const express = require('express');
const { authenticateToken, canAccessLocation } = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  // Get latest tech efficiency snapshot for a location
  router.get('/:locationId', authenticateToken, async (req, res) => {
    try {
      if (req.user.role === 'manager' && req.user.location_id !== req.params.locationId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      // Pin to ONE period (default mtd) — when both an mtd and a ytd snapshot
      // carry today's date, MAX(snapshot_date) returns both and every tech shows
      // up twice with different hours. Exclude techs hidden on the Technicians
      // page so this matches every other efficiency surface.
      const period = ['mtd', 'ytd'].includes(req.query.period) ? req.query.period : 'mtd';
      // hidden_techs is created lazily by the Technicians route; make sure it
      // exists so the NOT EXISTS filter below never 500s on a fresh database.
      await pool.query(`CREATE TABLE IF NOT EXISTS hidden_techs (
        location_id UUID NOT NULL, tech_id TEXT, tech_name TEXT, hidden_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (location_id, tech_id))`).catch(() => {});
      const result = await pool.query(
        `SELECT te.* FROM tech_efficiency te
          WHERE te.location_id = $1
            AND (te.period_type = $2 OR te.period_type IS NULL)
            AND te.snapshot_date = (SELECT MAX(snapshot_date) FROM tech_efficiency
                                     WHERE location_id = $1 AND (period_type = $2 OR period_type IS NULL))
            AND NOT EXISTS (SELECT 1 FROM hidden_techs h
                             WHERE h.location_id = te.location_id
                               AND (h.tech_id = te.tech_id OR h.tech_name = te.tech_name))
          ORDER BY te.tech_name`,
        [req.params.locationId, period]
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bulk upsert tech efficiency from Make (one snapshot = all techs for a date)
  router.post('/:locationId/update', authenticateToken, async (req, res) => {
    if (!canAccessLocation(req.user, req.params.locationId)) return res.status(403).json({ error: 'Access denied for this location' });
    const { snapshot_date, techs } = req.body;
    if (!Array.isArray(techs)) return res.status(400).json({ error: 'techs must be an array' });
    const date = snapshot_date || new Date().toISOString().slice(0, 10);
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // clear existing rows for this location + date so re-runs are idempotent
        await client.query('DELETE FROM tech_efficiency WHERE location_id = $1 AND snapshot_date = $2', [req.params.locationId, date]);
        for (const t of techs) {
          const hoursWorked = t.hours_worked != null ? t.hours_worked : null;
          const efficiency = (hoursWorked && hoursWorked > 0) ? Math.round((t.hours_sold / hoursWorked) * 100) : null;
          await client.query(
            `INSERT INTO tech_efficiency (location_id, snapshot_date, tech_id, tech_name, hours_available, hours_worked, hours_sold, efficiency, labour_revenue, parts_gp)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [req.params.locationId, date, t.tech_id || null, t.tech_name, t.hours_available || null, hoursWorked, t.hours_sold || 0, efficiency, t.labour_revenue || null, t.parts_gp || null]
          );
        }
        await client.query('COMMIT');
        res.json({ message: 'Tech efficiency saved', count: techs.length, date });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
