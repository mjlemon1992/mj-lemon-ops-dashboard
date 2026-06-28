const express = require('express');
const { authenticateToken } = require('../middleware/auth');

// GET /api/technicians/:locationId
// Live technician roster from Shopmonkey (/v3/user, assignedTechnician===true),
// merged with the latest snapshot from tech_efficiency. Also auto-derives the
// location's technician count from the live roster (replaces the manual field).
// Worked hours / efficiency stay null until QBO Time (clocked hours) connects.
module.exports = (pool) => {
  const router = express.Router();

  let _whInit = false;
  const ensureWeeklyHoursTable = async () => {
    if (_whInit) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS tech_weekly_hours (
      location_id UUID NOT NULL,
      tech_id VARCHAR(255) NOT NULL,
      tech_name VARCHAR(255),
      hours_per_week DECIMAL(6,2),
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (location_id, tech_id)
    )`);
    _whInit = true;
  };

  router.post('/:locationId/weekly-hours', authenticateToken, async (req, res) => {
    try {
      await ensureWeeklyHoursTable();
      const { tech_id, tech_name, hours_per_week } = req.body || {};
      if (!tech_id) return res.status(400).json({ error: 'tech_id required' });
      const hpw = hours_per_week === '' || hours_per_week == null ? null : Number(hours_per_week);
      await pool.query(
        `INSERT INTO tech_weekly_hours (location_id, tech_id, tech_name, hours_per_week, updated_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (location_id, tech_id)
         DO UPDATE SET hours_per_week = $4, tech_name = COALESCE($3, tech_weekly_hours.tech_name), updated_at = NOW()`,
        [req.params.locationId, tech_id, tech_name || null, hpw]
      );
      res.json({ ok: true, tech_id, hours_per_week: hpw });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  let _htInit = false;
  const ensureHiddenTechsTable = async () => {
    if (_htInit) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS hidden_techs (
      location_id UUID NOT NULL,
      tech_id VARCHAR(255) NOT NULL,
      tech_name VARCHAR(255),
      hidden_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (location_id, tech_id)
    )`);
    _htInit = true;
  };

  // List hidden techs for a location
  router.get('/:locationId/hidden-techs', authenticateToken, async (req, res) => {
    try {
      await ensureHiddenTechsTable();
      const r = await pool.query('SELECT tech_id, tech_name FROM hidden_techs WHERE location_id = $1', [req.params.locationId]);
      res.json({ ok: true, hidden: r.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Toggle a tech hidden/shown. body: { tech_id, tech_name, hidden: true|false }
  router.post('/:locationId/hidden-techs', authenticateToken, async (req, res) => {
    try {
      await ensureHiddenTechsTable();
      const { tech_id, tech_name, hidden } = req.body || {};
      if (!tech_id) return res.status(400).json({ error: 'tech_id required' });
      if (hidden) {
        await pool.query(
          `INSERT INTO hidden_techs (location_id, tech_id, tech_name, hidden_at)
           VALUES ($1,$2,$3,NOW())
           ON CONFLICT (location_id, tech_id)
           DO UPDATE SET tech_name = COALESCE($3, hidden_techs.tech_name), hidden_at = NOW()`,
          [req.params.locationId, tech_id, tech_name || null]
        );
      } else {
        await pool.query('DELETE FROM hidden_techs WHERE location_id = $1 AND tech_id = $2', [req.params.locationId, tech_id]);
      }
      res.json({ ok: true, tech_id, hidden: !!hidden });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:locationId', authenticateToken, async (req, res) => {
    const apiKey = process.env.SHOPMONKEY_API_KEY;
    try {
      if (req.user.role === 'manager' && req.user.location_id !== req.params.locationId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const locResult = await pool.query('SELECT * FROM locations WHERE id = $1', [req.params.locationId]);
      if (!locResult.rows.length) return res.status(404).json({ error: 'Location not found' });
      const loc = locResult.rows[0];

      let roster = [];
      let rosterError = null;
      if (!loc.shopmonkey_location_id) {
        // Location not connected to Shopmonkey: no roster. The /v3/user list is
        // account-wide, so without this guard an unconnected location would show
        // another shop's technicians (with null stats).
        rosterError = 'Location not connected to Shopmonkey';
      } else if (!apiKey) {
        rosterError = 'SHOPMONKEY_API_KEY not configured';
      } else {
        try {
          const r = await fetch('https://api.shopmonkey.cloud/v3/user?limit=200', {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
          });
          if (!r.ok) {
            rosterError = `Shopmonkey API error ${r.status}`;
          } else {
            const td = await r.json();
            const list = (td && td.data && td.data.data) ? td.data.data : (td.data || []);
            roster = list
              .filter(t => t.assignedTechnician === true && t.active !== false)
              .map(t => ({
                tech_id: t.id,
                tech_name: t.name || [t.firstName, t.lastName].filter(Boolean).join(' ') || 'Unknown'
              }));
          }
        } catch (e) {
          rosterError = e.message;
        }
      }

      let statsByTech = {};
      let snapshotDate = null;
      const period = (req.query && req.query.period === 'ytd') ? 'ytd' : 'mtd';
      // Ensure the period_type column exists before we query it — the read path
      // must not depend on a recompute having run first on this container.
      try { await pool.query('ALTER TABLE tech_efficiency ADD COLUMN IF NOT EXISTS period_type VARCHAR(8)'); } catch (e) {}
      // Latest snapshot for the requested period (mtd|ytd), never future-dated
      // (a future snapshot must never outrank today's). Falls back to any
      // worked-hours snapshot if this period hasn't been computed yet.
      const teWorked = await pool.query(
        'SELECT MAX(snapshot_date) AS d FROM tech_efficiency WHERE location_id = $1 AND period_type = $2 AND snapshot_date <= CURRENT_DATE',
        [req.params.locationId, period]
      );
      // Period-aware only: never fall back across periods (an mtd request must
      // never show ytd rows). If this period has no snapshot, show nothing
      // rather than the wrong period's data.
      snapshotDate = teWorked.rows[0] && teWorked.rows[0].d ? teWorked.rows[0].d : null;
      if (snapshotDate) {
        const te = await pool.query(
          `SELECT tech_id, tech_name, hours_sold, hours_billed, vehicle_count, hours_worked, efficiency, labour_revenue
           FROM tech_efficiency WHERE location_id = $1 AND snapshot_date = $2 AND period_type = $3`,
          [req.params.locationId, snapshotDate, period]
        );
        for (const row of te.rows) {
          if (row.tech_id) statsByTech[row.tech_id] = row;
        }
      }

      // Only show techs who logged labour this month (present in tech_efficiency).
      // Drops roster members who did no tech work (e.g. owners on the roster).
      await ensureWeeklyHoursTable();
      const whRes = await pool.query('SELECT tech_id, hours_per_week FROM tech_weekly_hours WHERE location_id = $1', [req.params.locationId]);
      const whByTech = {};
      for (const r of whRes.rows) whByTech[r.tech_id] = r.hours_per_week;

      const activeRoster = snapshotDate ? roster.filter(t => statsByTech[t.tech_id]) : roster;
      const technicians = activeRoster.map(t => {
        const h = statsByTech[t.tech_id];
        return {
          tech_id: t.tech_id,
          tech_name: t.tech_name,
          hours_sold: h && h.hours_sold != null ? Number(h.hours_sold) : null,
          hours_billed: h && h.hours_billed != null ? Number(h.hours_billed) : null,
          vehicle_count: h && h.vehicle_count != null ? Number(h.vehicle_count) : null,
          hours_worked: h && h.hours_worked != null ? Number(h.hours_worked) : null,
          efficiency: h && h.efficiency != null ? Number(h.efficiency) : null,
          labour_revenue: h && h.labour_revenue != null ? Number(h.labour_revenue) : null,
          hours_per_week: whByTech[t.tech_id] != null ? Number(whByTech[t.tech_id]) : null
        };
      });

      let derivedCount = technicians.length;
      if (!loc.shopmonkey_location_id) {
        // Unconnected location has no technicians; clear any stale inherited count.
        derivedCount = 0;
        await pool.query(
          'UPDATE locations SET num_technicians = 0, updated_at = NOW() WHERE id = $1',
          [req.params.locationId]
        );
      } else if (!rosterError && derivedCount > 0) {
        await pool.query(
          'UPDATE locations SET num_technicians = $1, updated_at = NOW() WHERE id = $2',
          [derivedCount, req.params.locationId]
        );
      } else {
        derivedCount = loc.num_technicians;
      }

      let hiddenTechs = [];
      try {
        await ensureHiddenTechsTable();
        const hr = await pool.query('SELECT tech_id, tech_name FROM hidden_techs WHERE location_id = $1', [req.params.locationId]);
        hiddenTechs = hr.rows;
      } catch (e) {}

      res.json({
        technicians,
        count: technicians.length,
        derived_count: derivedCount,
        hidden: hiddenTechs,
        distinct_vehicles_mtd: loc.distinct_vehicles_mtd != null ? loc.distinct_vehicles_mtd : null,
        hours_snapshot_date: snapshotDate,
        has_hours: !!snapshotDate,
        roster_source: rosterError ? 'unavailable' : 'shopmonkey_live',
        roster_error: rosterError
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
