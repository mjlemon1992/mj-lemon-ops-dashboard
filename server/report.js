// report.js — MJ Lemon — Friday finance snapshot (READ-ONLY)
// Mount in server/index.js ABOVE the SPA catch-all:
//     app.use('/report', require('./report'));
// Endpoint:  GET /report/weekly  -> { text: "<slack mrkdwn string>" }
// Auth:      Authorization: Bearer <REPORT_TOKEN>
// Smoke test before the data layer is wired: set REPORT_MOCK=1

const express = require('express');
const router = express.Router();

const TARGETS = {
  revenue:      45000,
  cars:         18,
  partsMargin:  0.55,
  labourMargin: 0.70,
  profitPerHr:  253,
  efficiency:   0.80,
};

const LOCATION_ID = process.env.LOCATION_ID || '8174d72a-967b-48de-b37c-997b2d071693';

const METRICS = [
  { key: 'revenue',      label: 'Revenue',       fmt: money },
  { key: 'cars',         label: 'Cars',          fmt: int   },
  { key: 'partsMargin',  label: 'Parts margin',  fmt: pct   },
  { key: 'labourMargin', label: 'Labour margin', fmt: pct   },
  { key: 'profitPerHr',  label: 'Profit / hr',   fmt: money },
  { key: 'efficiency',   label: 'Efficiency',    fmt: pct   },
];

async function getActuals(start, end) {
  if (process.env.REPORT_MOCK === '1') return mock();

  // Shopmonkey closed/invoiced ROs in [start, end]:
  //   revenue, carCount, partsRev, partsCost, labourRev, labourCost, hoursSold
  const ro = await require('./shopmonkey').weeklyTotals(start, end);

  // Worked (clocked) hours from the dashboard backend (aggregates QBO Time).
  // Summary endpoint is MTD-only today; expose workedHours(loc, start, end) for weekly.
  const hoursWorked = await require('./dashboard').workedHours(LOCATION_ID, start, end);

  const grossProfit = (ro.partsRev - ro.partsCost) + (ro.labourRev - ro.labourCost);

  return {
    revenue:      ro.revenue,
    cars:         ro.carCount,
    partsMargin:  ro.partsRev  ? (ro.partsRev  - ro.partsCost)  / ro.partsRev  : 0,
    labourMargin: ro.labourRev ? (ro.labourRev - ro.labourCost) / ro.labourRev : 0,
    profitPerHr:  ro.hoursSold ? grossProfit / ro.hoursSold : null,
    efficiency:   hoursWorked  ? ro.hoursSold / hoursWorked  : null,
  };
}

router.get('/weekly', auth, async (req, res) => {
  try {
    const { start, end } = weekRange();
    const actuals = await getActuals(start, end);
    const rows    = METRICS.map(m => row(m, actuals[m.key]));
    const text    = buildMessage(rows, start, end);
    res.json(req.query.debug ? { text, rows, window: { start, end } } : { text });
  } catch (e) {
    console.error('[report] failed:', e);
    res.status(500).json({ error: 'report_failed' });
  }
});

module.exports = router;

function auth(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!process.env.REPORT_TOKEN || token !== process.env.REPORT_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function weekRange(now = new Date()) {
  const day = now.getDay();
  const mondayOffset = day === 0 ? 6 : day - 1;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - mondayOffset);
  return { start, end: now };
}

function row(metric, value) {
  if (value == null) {
    return { emoji: '⚪', label: metric.label, value: '—', available: false };
  }
  const target = TARGETS[metric.key];
  const vsTarget = target ? (value / target - 1) * 100 : 0;
  return { emoji: emojiFor(vsTarget), label: metric.label, value: metric.fmt(value), vsTarget, available: true };
}

function emojiFor(pct) {
  if (pct >= 0)   return '🟢';
  if (pct >= -10) return '🟡';
  return '🔴';
}

function buildMessage(rows, start, end) {
  const header = `*📊 Weekly Finance Snapshot*\n_${dateRange(start, end)}_\n`;
  const lines = rows.map(r =>
    r.available
      ? `${r.emoji} *${r.label}* — ${r.value}  (${signed(r.vsTarget)} vs target)`
      : `${r.emoji} *${r.label}* — ${r.value}  (no data)`
  );
  return [header, ...lines].join('\n');
}

function money(n) { return '$' + Math.round(n).toLocaleString('en-CA'); }
function int(n)   { return Math.round(n).toLocaleString('en-CA'); }
function pct(n)   { return (n * 100).toFixed(1) + '%'; }

function signed(p) {
  const s = p >= 0 ? '+' : '-';
  return s + Math.abs(p).toFixed(1) + '%';
}

function dateRange(start, end) {
  const o = { weekday: 'short', day: '2-digit', month: 'short' };
  return `${start.toLocaleDateString('en-GB', o)} – ${end.toLocaleDateString('en-GB', o)} ${end.getFullYear()}`;
}

function mock() {
  return {
    revenue: 57397, cars: 18,
    partsMargin: 0.5835, labourMargin: 0.8389,
    profitPerHr: 280, efficiency: 0.48,
  };
}
