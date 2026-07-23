const express = require('express');
const { authenticateToken, syncAuth, requireRole, canAccessLocation } = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  // Specific routes must precede the parameterized '/:locationId/summary' below,
  // or Express matches '/group/summary' as locationId="group" and the UUID
  // query throws "invalid input syntax for type uuid".
  // syncAuth: the scheduled Chief-of-Staff agent reads these with X-Sync-Key.
  router.get('/group/summary', syncAuth, async (req, res) => {
    if (req.user.role === 'manager') return res.status(403).json({ error: 'Access denied' });
    try {
      const result = await pool.query(
        `SELECT DISTINCT ON (location_id) location_id, revenue_mtd, car_count_mtd, parts_margin, labour_margin, avg_ro_value, effective_labour_rate, efficiency_avg, pph, total_profit, alerts, created_at
         FROM metrics_cache ORDER BY location_id, created_at DESC`
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:locationId/summary', syncAuth, async (req, res) => {
    if (!canAccessLocation(req.user, req.params.locationId)) return res.status(403).json({ error: 'Access denied for this location' });
    try {
      if (req.user.role === 'manager' && req.user.location_id !== req.params.locationId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const result = await pool.query(
        `SELECT * FROM metrics_cache WHERE location_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [req.params.locationId]
      );
      const row = result.rows[0] || null;
      // Advisors get the shop-floor slice: MTD revenue (the same figure the bay
      // display board shows), car count, hours, alerts. Margins, profit, pph,
      // RO values and rates are stripped SERVER-side so they never reach the
      // browser at all.
      if (row && req.user.role === 'advisor') {
        return res.json({
          location_id: row.location_id,
          revenue_mtd: row.revenue_mtd,
          car_count_mtd: row.car_count_mtd,
          labour_hours_sold: row.labour_hours_sold,
          labour_hours_worked: row.labour_hours_worked,
          alerts: row.alerts,
          created_at: row.created_at,
        });
      }
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // owner/partner or the sync machine key only — a manager must never write into
  // the finance cache that drives every dashboard, the group summary and the CoS brief.
  router.post('/:locationId/update', syncAuth, requireRole('owner', 'partner'), async (req, res) => {
    if (!canAccessLocation(req.user, req.params.locationId)) return res.status(403).json({ error: 'Access denied for this location' });
    const { revenue_mtd, car_count_mtd, parts_margin, labour_margin, avg_ro_value, labour_hours_sold, efficiency_avg, pph, total_profit, alerts } = req.body;
    try {
      const result = await pool.query(
        `INSERT INTO metrics_cache (location_id, revenue_mtd, car_count_mtd, parts_margin, labour_margin, avg_ro_value, labour_hours_sold, efficiency_avg, pph, total_profit, alerts, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
         RETURNING *`,
        [req.params.locationId, revenue_mtd, car_count_mtd, parts_margin, labour_margin, avg_ro_value, labour_hours_sold, efficiency_avg, pph, total_profit, JSON.stringify(alerts || [])]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
