const express = require('express');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { ensureTimeClockTables } = require('../lib/timeClockSchema');
const { ensureBonusFuelTables } = require('../lib/bonusFuelSchema');

// "Waiting on you" — one call that gathers every queue a human has to clear:
// pending time-off requests, punch change requests, unassigned fuel purchases.
// Locations are resolved from the caller's role, so a manager only ever sees
// their own shop's queues.
module.exports = (pool) => {
  const router = express.Router();

  router.get('/', authenticateToken, requireRole('owner', 'partner', 'manager'), async (req, res) => {
    try {
      await Promise.all([ensureTimeClockTables(pool), ensureBonusFuelTables(pool)]);
      let locs;
      if (['owner', 'partner'].includes(req.user.role)) {
        ({ rows: locs } = await pool.query('SELECT id, name FROM locations WHERE active = true ORDER BY name'));
      } else {
        if (!req.user.location_id) return res.json({ items: [], total: 0 });
        ({ rows: locs } = await pool.query('SELECT id, name FROM locations WHERE id = $1', [req.user.location_id]));
      }
      if (!locs.length) return res.json({ items: [], total: 0 });
      const ids = locs.map((l) => l.id);
      const nameOf = Object.fromEntries(locs.map((l) => [l.id, l.name]));

      const [timeoff, edits, fuel] = await Promise.all([
        pool.query(
          `SELECT location_id, COUNT(*)::int AS n FROM time_off_request
            WHERE location_id = ANY($1) AND status = 'pending' AND person_id IS NOT NULL
            GROUP BY location_id`, [ids]),
        pool.query(
          `SELECT location_id, COUNT(*)::int AS n FROM time_edit_request
            WHERE location_id = ANY($1) AND status = 'pending'
            GROUP BY location_id`, [ids]),
        pool.query(
          `SELECT location_id, COUNT(*)::int AS n FROM fuel_ledger
            WHERE location_id = ANY($1) AND person_id IS NULL AND type = 'purchase'
            GROUP BY location_id`, [ids]),
      ]);

      const items = [];
      const push = (rows, kind, label, path) => {
        for (const r of rows) {
          items.push({
            kind, location_id: r.location_id, location_name: nameOf[r.location_id],
            count: r.n, label: r.n === 1 ? label : `${label}s`, path,
          });
        }
      };
      push(timeoff.rows, 'timeoff', 'holiday request', '/time-clock');
      push(edits.rows, 'edit', 'punch change', '/time-clock');
      push(fuel.rows, 'fuel', 'unassigned fuel purchase', '/fuel-card');
      res.json({ items, total: items.reduce((s, i) => s + i.count, 0) });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  return router;
};
