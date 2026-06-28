const express = require('express');
const { authenticateToken } = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  // Specific routes must precede the parameterized '/:locationId/summary' below,
  // or Express matches '/group/summary' as locationId="group" and the UUID
  // query throws "invalid input syntax for type uuid".
  router.get('/group/summary', authenticateToken, async (req, res) => {
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

  router.get('/:locationId/summary', authenticateToken, async (req, res) => {
    try {
      if (req.user.role === 'manager' && req.user.location_id !== req.params.locationId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const result = await pool.query(
        `SELECT * FROM metrics_cache WHERE location_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [req.params.locationId]
      );
      res.json(result.rows[0] || null);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:locationId/update', authenticateToken, async (req, res) => {
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
