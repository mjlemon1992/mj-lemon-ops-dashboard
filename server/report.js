// report.js — MJ Lemon — Finance Snapshot (READ-ONLY, MTD)
// Mount: app.use('/report', require('./report')(pool));  (ABOVE the SPA catch-all)

const express = require('express');

const LOCATION_ID = process.env.LOCATION_ID || '8174d72a-967b-48de-b37c-997b2d071693';

const TARGET_FALLBACK = {
  revenue: 45000, car_count: 18, parts_margin: 55,
  labour_margin: 70, pph: 253, efficiency: 80,
};

const METRICS = [
  { key: 'revenue',      label: 'Revenue',       fmt: money, tfmt: money, pace: true  },
  { key: 'car_count',    label: 'Cars',          fmt: int,   tfmt: int,   pace: true  },
  { key: 'parts_margin', label: 'Parts margin',  fmt: pctv,  tfmt: pctv,  pace: false },
  { key: 'labour_margin',label: 'Labour margin', fmt: pctv,  tfmt: pctv,  pace: false },
  { key: 'pph',          label: 'Profit / hr',   fmt: money, tfmt: money, pace: false },
  { key: 'efficiency',   label: 'Efficiency',    fmt: pctv,  tfmt: pctv,  pace: false },
];

module.exports = (pool) => {
  const router = express.Router();
  router.get('/weekly', auth, async (req, res) => {
    try {
      const now = new Date();
      const frac = monthFraction(now);
      const [actuals, targets, locationName] = await Promise.all([
        getActuals(pool, now), getTargets(pool, now), getLocationName(pool),
      ]);
      const rows = METRICS.map(m => row(m, actuals[m.key], targets[m.key], frac));
      const text = buildMessage(rows, now, frac, locationName);
      const html = buildHtml(rows, now, frac, locationName);
      res.json(req.query.debug ? { text, html, rows, actuals, targets, frac, locationName } : { text, html });
    } catch (e) {
      console.error('[report] failed:', e);
      res.status(500).json({ error: 'report_failed' });
    }
  });
  return router;
};

function monthFraction(now) {
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return now.getDate() / daysInMonth;
}

async function getLocationName(pool) {
  try {
    const r = await pool.query('SELECT name FROM locations WHERE id = $1 LIMIT 1', [LOCATION_ID]);
    const raw = r.rows[0] && r.rows[0].name;
    return raw ? titleCase(raw) : null;
  } catch { return null; }
}

async function getActuals(pool, now) {
  const r = await pool.query(
    `SELECT revenue_mtd, car_count_mtd, parts_margin, labour_margin, efficiency_avg, pph
       FROM metrics_cache WHERE location_id = $1
      ORDER BY created_at DESC NULLS LAST LIMIT 1`, [LOCATION_ID]);
  const m = r.rows[0] || {};
  let efficiency = numOrNull(m.efficiency_avg);
  if (efficiency == null) efficiency = await computeEfficiency(pool, now);
  return {
    revenue:       numOrNull(m.revenue_mtd),
    car_count:     numOrNull(m.car_count_mtd),
    parts_margin:  numOrNull(m.parts_margin),
    labour_margin: numOrNull(m.labour_margin),
    pph:           numOrNull(m.pph),
    efficiency,
  };
}

async function computeEfficiency(pool, now) {
  try {
    const r = await pool.query(
      `SELECT COALESCE(SUM(hours_sold),0) AS sold,
              COALESCE(SUM(hours_worked),0) AS worked
         FROM tech_efficiency
        WHERE location_id = $1
          AND hours_worked IS NOT NULL AND hours_worked > 0
          AND snapshot_date = (SELECT MAX(snapshot_date) FROM tech_efficiency WHERE location_id = $1)`,
      [LOCATION_ID]);
    const sold = Number(r.rows[0] && r.rows[0].sold) || 0;
    const worked = Number(r.rows[0] && r.rows[0].worked) || 0;
    return worked > 0 ? Math.round((sold / worked) * 100) : null;
  } catch { return null; }
}

async function getTargets(pool, now) {
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

function row(metric, value, target, frac) {
  if (value == null) return { emoji: '⚪', label: metric.label, value: '—', available: false };
  const effTarget = metric.pace ? (target * frac) : target;
  const vsTarget = (effTarget && effTarget > 0) ? (value / effTarget - 1) * 100 : 0;
  return {
    emoji: emojiFor(vsTarget), label: metric.label, value: metric.fmt(value), vsTarget, pace: metric.pace,
    targetText: metric.pace ? `pace ${metric.tfmt(effTarget)} of ${metric.tfmt(target)}` : `target ${metric.tfmt(target)}`,
    available: true,
  };
}

function emojiFor(p) { return p >= 0 ? '🟢' : (p >= -10 ? '🟡' : '🔴'); }

function buildHtml(rows, now, frac, locationName) {
  const loc = locationName ? ` &mdash; ${esc(locationName)}` : '';
  const month = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const asOf  = now.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
  const dot = { '🟢': '#22c55e', '🟡': '#eab308', '🔴': '#ef4444', '⚪': '#9ca3af' };
  const metricRows = rows.map(r => {
    const color = dot[r.emoji] || '#9ca3af';
    const right = r.available ? `${esc(r.targetText)}, ${signed(r.vsTarget)}` : 'no data';
    return `
        <tr>
          <td width="6" bgcolor="${color}" style="width:6px;background-color:${color};font-size:0;line-height:0;">&nbsp;</td>
          <td style="padding:10px 14px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#111111;">${esc(r.label)}</td>
          <td align="right" style="padding:10px 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#111111;white-space:nowrap;">${esc(r.value)}</td>
          <td align="right" style="padding:10px 14px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#777777;white-space:nowrap;">${esc(right)}</td>
        </tr>
        <tr><td colspan="4" style="border-bottom:1px solid #eeeeee;font-size:0;line-height:0;">&nbsp;</td></tr>`;
  }).join('');
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background-color:#ffffff;border:1px solid #e5e5e5;border-radius:8px;">
        <tr><td style="padding:20px 22px 4px;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:bold;color:#111111;">&#128202; Finance Snapshot${loc}</td></tr>
        <tr><td style="padding:0 22px 16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#777777;">Month to Date &middot; ${esc(month)} &middot; as of ${esc(asOf)} (${Math.round(frac * 100)}% through month)</td></tr>
        <tr><td style="padding:0 14px 18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${metricRows}</table>
        </td></tr>
        <tr><td style="padding:0 22px 20px;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#999999;">MJ Lemon Ops Dashboard &middot; automated weekly snapshot</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function buildMessage(rows, now, frac, locationName) {
  const loc = locationName ? ` — ${locationName}` : '';
  const month = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const asOf  = now.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
  const header = `*📊 Finance Snapshot${loc} — Month to Date*\n_${month} · as of ${asOf} (${Math.round(frac * 100)}% through month)_\n`;
  const lines = rows.map(r =>
    r.available
      ? `${r.emoji} *${r.label}* — ${r.value}  (${r.targetText}, ${signed(r.vsTarget)})`
      : `${r.emoji} *${r.label}* — ${r.value}  (no data)`);
  return [header, ...lines].join('\n');
}

function money(n) { return '$' + Math.round(n).toLocaleString('en-CA'); }
function int(n)   { return Math.round(n).toLocaleString('en-CA'); }
function pctv(n)  { return Number(n).toFixed(1) + '%'; }
function signed(p){ return (p >= 0 ? '+' : '-') + Math.abs(p).toFixed(1) + '%'; }
function pad(n)   { return String(n).padStart(2, '0'); }
function titleCase(s){ return String(s).trim().replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()); }

function numOrNull(v) { const n = Number(v); return (v == null || Number.isNaN(n)) ? null : n; }
function numOr(v, d)  { const n = Number(v); return Number.isFinite(n) ? n : d; }

const HOLIDAYS = {
  ab: { 2026: ['2026-01-01','2026-02-16','2026-04-03','2026-05-18','2026-07-01','2026-09-07','2026-10-12','2026-11-11','2026-12-25','2026-12-28'] },
  bc: { 2026: ['2026-01-01','2026-02-16','2026-04-03','2026-05-18','2026-07-01','2026-08-03','2026-09-07','2026-09-30','2026-10-12','2026-11-11','2026-12-25','2026-12-28'] }
};
function holidaySet(province, year) {
  const prov = (province || 'ab').toLowerCase();
  const list = (HOLIDAYS[prov] && HOLIDAYS[prov][year]) || (HOLIDAYS.ab[year] || []);
  return new Set(list);
}
function workingDaysInRange(province, startStr, endStr) {
  const start = new Date(startStr + 'T00:00:00Z');
  const end = new Date(endStr + 'T00:00:00Z');
  let n = 0; const hy = {};
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const d = new Date(t); const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const y = d.getUTCFullYear();
    if (!hy[y]) hy[y] = holidaySet(province, y);
    const iso = `${y}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
    if (hy[y].has(iso)) continue;
    n++;
  }
  return n;
}

function auth(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!process.env.REPORT_TOKEN || token !== process.env.REPORT_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
