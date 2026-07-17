const express = require('express');
const { authenticateToken, requireRole, canAccessLocation } = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  // Owner/partner set targets anywhere; a manager only for their own location.
  const assertLoc = (req, res) => {
    if (canAccessLocation(req.user, req.params.locationId)) return true;
    res.status(403).json({ error: 'Access denied for this location' });
    return false;
  };

  router.get('/:locationId/:year', authenticateToken, async (req, res) => {
    try {
      if (req.user.role === 'manager' && req.user.location_id !== req.params.locationId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const result = await pool.query(
        'SELECT * FROM targets WHERE location_id = $1 AND year = $2 ORDER BY month',
        [req.params.locationId, req.params.year]
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:locationId/:year/:month', authenticateToken, requireRole('owner', 'partner', 'manager'), async (req, res) => {
    const { revenue, car_count, parts_margin, labour_margin, labour_hours, efficiency, avg_ro_value, pph } = req.body;
    if (!assertLoc(req, res)) return;
    try {
      const result = await pool.query(
        `INSERT INTO targets (location_id, year, month, revenue, car_count, parts_margin, labour_margin, labour_hours, efficiency, avg_ro_value, pph)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (location_id, year, month) DO UPDATE SET
           revenue=$4, car_count=$5, parts_margin=$6, labour_margin=$7, labour_hours=$8, efficiency=$9, avg_ro_value=$10, pph=$11, updated_at=NOW()
         RETURNING *`,
        [req.params.locationId, req.params.year, req.params.month, revenue, car_count, parts_margin || 55, labour_margin || 70, labour_hours, efficiency || 80, avg_ro_value, pph]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:locationId/:year/bulk', authenticateToken, requireRole('owner', 'partner', 'manager'), async (req, res) => {
    const { targets } = req.body;
    if (!Array.isArray(targets)) return res.status(400).json({ error: 'targets must be an array' });
    if (!assertLoc(req, res)) return;
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const t of targets) {
          await client.query(
            `INSERT INTO targets (location_id, year, month, revenue, car_count, parts_margin, labour_margin, labour_hours, efficiency, avg_ro_value, pph)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (location_id, year, month) DO UPDATE SET
               revenue=$4, car_count=$5, parts_margin=$6, labour_margin=$7, labour_hours=$8, efficiency=$9, avg_ro_value=$10, pph=$11, updated_at=NOW()`,
            [req.params.locationId, req.params.year, t.month, t.revenue, t.car_count, t.parts_margin || 55, t.labour_margin || 70, t.labour_hours, t.efficiency || 80, t.avg_ro_value, t.pph]
          );
        }
        await client.query('COMMIT');
        res.json({ message: 'Targets saved', count: targets.length });
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
