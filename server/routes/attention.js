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

  // This endpoint is polled every 60s by every signed-in tab — run the schema
  // DDL once per process, not per request.
  let ensured = null;
  const ensureOnce = () => {
    if (!ensured) ensured = Promise.all([ensureTimeClockTables(pool), ensureBonusFuelTables(pool)]).catch((e) => { ensured = null; throw e; });
    return ensured;
  };

  router.get('/', authenticateToken, requireRole('owner', 'partner', 'manager'), async (req, res) => {
    try {
      await ensureOnce();
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

      const prevMonth = (() => {
        const now = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' }) + 'T12:00:00Z');
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        return d.toISOString().slice(0, 7);
      })();
      const [timeoff, edits, fuel, bonusRuns, bonusCrew] = await Promise.all([
        pool.query(
          `SELECT r.id, r.location_id, r.person_id, r.type, r.paid, r.working_days,
                  r.start_date::text AS start_date, r.end_date::text AS end_date,
                  p.name AS person_name, p.vacation_days_per_year AS allowance,
                  (SELECT COALESCE(SUM(a.working_days), 0)::int FROM time_off_request a
                    WHERE a.person_id = r.person_id AND a.status = 'approved' AND a.type = 'vacation'
                      AND to_char(a.start_date, 'YYYY') = to_char(now(), 'YYYY')) AS vacation_used
             FROM time_off_request r JOIN bonus_person p ON p.id = r.person_id
            WHERE r.location_id = ANY($1) AND r.status = 'pending'
            ORDER BY r.requested_at`, [ids]),
        pool.query(
          `SELECT r.id, r.location_id, r.person_id, r.entry_id, r.note,
                  r.proposed_clock_in, r.proposed_clock_out, r.proposed_break_minutes,
                  p.name AS person_name, e.clock_in, e.clock_out
             FROM time_edit_request r
             JOIN bonus_person p ON p.id = r.person_id
             LEFT JOIN time_clock_entry e ON e.id = r.entry_id
            WHERE r.location_id = ANY($1) AND r.status = 'pending'
            ORDER BY r.requested_at`, [ids]),
        pool.query(
          `SELECT location_id, COUNT(*)::int AS n, COALESCE(SUM(ABS(amount)), 0)::numeric(12,2) AS total
             FROM fuel_ledger
            WHERE location_id = ANY($1) AND person_id IS NULL AND type = 'purchase'
            GROUP BY location_id`, [ids]),
        // Last month's bonus not yet approved = the net-profit prompt (owner/partner).
        ['owner', 'partner'].includes(req.user.role)
          ? pool.query(
            `SELECT location_id, status FROM bonus_run
              WHERE location_id = ANY($1) AND month = $2 AND superseded_by IS NULL`, [ids, prevMonth])
          : Promise.resolve({ rows: null }),
        // Only prompt shops that actually run a bonus (≥1 active in-bonus person).
        pool.query(
          `SELECT location_id FROM bonus_person
            WHERE location_id = ANY($1) AND active = true AND in_bonus IS NOT FALSE
            GROUP BY location_id`, [ids]),
      ]);

      // Bonus prompt: previous month with no approved (unsuperseded) run.
      const bonus = [];
      if (bonusRuns.rows) {
        const runByLoc = Object.fromEntries(bonusRuns.rows.map((r) => [r.location_id, r.status]));
        const hasCrew = new Set(bonusCrew.rows.map((r) => r.location_id));
        for (const l of locs) {
          if (!hasCrew.has(l.id)) continue;   // shop doesn't run a bonus — no prompt
          const st = runByLoc[l.id];
          if (st !== 'approved') bonus.push({ location_id: l.id, location_name: l.name, month: prevMonth, status: st || 'none' });
        }
      }

      const countByLoc = (rows) => {
        const m = {};
        for (const r of rows) m[r.location_id] = (m[r.location_id] || 0) + 1;
        return m;
      };
      const items = [];
      const push = (byLoc, kind, label, path) => {
        for (const [lid, n] of Object.entries(byLoc)) {
          items.push({ kind, location_id: lid, location_name: nameOf[lid], count: n, label: n === 1 ? label : `${label}s`, path });
        }
      };
      push(countByLoc(timeoff.rows), 'timeoff', 'holiday request', '/time-clock');
      push(countByLoc(edits.rows), 'edit', 'punch change', '/time-clock');
      push(Object.fromEntries(fuel.rows.map((r) => [r.location_id, r.n])), 'fuel', 'unassigned fuel purchase', '/fuel-card');

      const withName = (r) => ({ ...r, location_name: nameOf[r.location_id] });
      res.json({
        items,
        total: items.reduce((s, i) => s + i.count, 0),
        detail: {
          timeoff: timeoff.rows.map(withName),
          edits: edits.rows.map(withName),
          fuel: fuel.rows.map(withName),
          bonus,
        },
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  return router;
};
