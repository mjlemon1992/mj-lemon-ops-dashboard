// report.js — MJ Lemon — Finance Snapshot (READ-ONLY, MTD)
// Mount in server/index.js ABOVE the SPA catch-all, passing the pg pool:
//     app.use('/report', require('./report')(pool));

const express = require('express');

const LOCATION_ID = process.env.LOCATION_ID || '8174d72a-967b-48de-b37c-997b2d071693';

const TARGET_FALLBACK = {
  revenue: 45000, car_count: 18, parts_margin: 55,
  labour_margin: 70, pph: 253, efficiency: 80,
};

const METRICS = [
  { key: 'revenue',      label: 'Revenue',       fmt: money },
  { key: 'car_count',    label: 'Cars',          fmt: int   },
  { key: 'parts_margin', label: 'Parts margin',  fmt: pctv  },
  { key: 'labour_margin',label: 'Labour margin', fmt: pctv  },
  { key: 'pph',          label: 'Profit / hr',   fmt: money },
  { key: 'efficiency',   label: 'Efficiency',    fmt: pctv  },
];

module.exports = (pool) => {
  const router = express.Router();
  router.get('/weekly', auth, async (req, res) => {
    try {
      const now = new Date();
      const actuals = await getActuals(pool, now);
      const targets = await getTargets(pool, now);
      const rows = METRICS.map(m => row(m, actuals[m.key], targets[m.key]));
      const text = buildMessage(rows, now);
      res.json(req.query.debug ? { text, rows, actuals, targets } : { text });
    } catch (e) {
      console.error('[report] failed:', e);
      res.status(500).json({ error: 'report_failed' });
    }
  });
  return router;
};

async function getActuals(pool, now) {
  if (process.env.REPORT_MOCK === '1') {
    return { revenue: 57397, car_count: 18, parts_margin: 58.4,
             labour_margin: 83.9, pph: 280, efficiency: 48 };
  }
  const r = await pool.query(
    `SELECT revenue_mtd, car_count_mtd, parts_margin, labour_margin, efficiency_avg, pph
       FROM metrics_cache WHERE location_id = $1
      ORDER BY created_at DESC LIMIT 1`, [LOCATION_ID]);
  const m = r.rows[0] || {};
  return {
    revenue:       numOrNull(m.revenue_mtd),
    car_count:     numOrNull(m.car_count_mtd),
    parts_margin:  numOrNull(m.parts_margin),
    labour_margin: numOrNull(m.labour_margin),
    pph:           numOrNull(m.pph),
    efficiency:    numOrNull(m.efficiency_avg),
  };
}

async function getTargets(pool, now) {
  if (process.env.REPORT_MOCK === '1') return { ...TARGET_FALLBACK };
  const r = await pool.query(
    `SELECT revenue, car_count, parts_margin, labour_margin, efficiency, pph
       FROM targets WHERE location_id = $1 AND year = $2 AND month = $3 LIMIT 1`,
    [LOCATION_ID, now.getFullYear(), now.getMonth() + 1]);
  const t = r.rows[0];
  if (!t) return { ...TARGET_FALLBACK };
  return {
    revenue:       numOr(t.revenue,       TARGET_FALLBACK.revenue),
    car_count:     numOr(t.car_count,     TARGET_FALLBACK.car_count),
    parts_margin:  numOr(t.parts_margin,  TARGET_FALLBACK.parts_margin),
    labour_margin: numOr(t.labour_margin, TARGET_FALLBACK.labour_margin),
    pph:           numOr(t.pph,           TARGET_FALLBACK.pph),
    efficiency:    numOr(t.efficiency,    TARGET_FALLBACK.efficiency),
  };
}

function row(metric, value, target) {
  if (value == null) return { emoji: '⚪', label: metric.label, value: '—', available: false };
  const vsTarget = (target && target > 0) ? (value / target - 1) * 100 : 0;
  return { emoji: emojiFor(vsTarget), label: metric.label, value: metric.fmt(value), vsTarget, available: true };
}

function emojiFor(p) { return p >= 0 ? '🟢' : (p >= -10 ? '🟡' : '🔴'); }

function buildMessage(rows, now) {
  const month = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const asOf  = now.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
  const header = `*📊 Finance Snapshot — Month to Date*\n_${month} · as of ${asOf}_\n`;
  const lines = rows.map(r =>
    r.available
      ? `${r.emoji} *${r.label}* — ${r.value}  (${signed(r.vsTarget)} vs target)`
      : `${r.emoji} *${r.label}* — ${r.value}  (no data)`);
  return [header, ...lines].join('\n');
}

function money(n) { return '$' + Math.round(n).toLocaleString('en-CA'); }
function int(n)   { return Math.round(n).toLocaleString('en-CA'); }
function pctv(n)  { return Number(n).toFixed(1) + '%'; }
function signed(p){ return (p >= 0 ? '+' : '-') + Math.abs(p).toFixed(1) + '%'; }

function numOrNull(v) { const n = Number(v); return (v == null || Number.isNaN(n)) ? null : n; }
function numOr(v, d)  { const n = Number(v); return Number.isFinite(n) ? n : d; }

function auth(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!process.env.REPORT_TOKEN || token !== process.env.REPORT_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
