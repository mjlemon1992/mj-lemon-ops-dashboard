const express = require('express');
const { authenticateToken, requireOwner } = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  router.get('/', authenticateToken, async (req, res) => {
    try {
      let query = 'SELECT * FROM locations ORDER BY name';
      let params = [];
      if (req.user.role === 'manager') {
        query = 'SELECT * FROM locations WHERE id = $1';
        params = [req.user.location_id];
      }
      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:id', authenticateToken, async (req, res) => {
    try {
      if (req.user.role === 'manager' && req.user.location_id !== req.params.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const result = await pool.query('SELECT * FROM locations WHERE id = $1', [req.params.id]);
      if (!result.rows.length) return res.status(404).json({ error: 'Location not found' });
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', authenticateToken, requireOwner, async (req, res) => {
    const { name, address, city, province, shopmonkey_location_id, qbo_company_id, slack_channel, num_technicians, labour_rate, stale_threshold_days, parts_margin_target, efficiency_target, pph_target } = req.body;
    if (!name) return res.status(400).json({ error: 'Location name required' });
    try {
      const result = await pool.query(
        `INSERT INTO locations (name, address, city, province, shopmonkey_location_id, qbo_company_id, slack_channel, num_technicians, labour_rate, stale_threshold_days, parts_margin_target, efficiency_target, pph_target, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true) RETURNING *`,
        [name, address, city, province, shopmonkey_location_id, qbo_company_id, slack_channel, num_technicians || 5, labour_rate || 170, stale_threshold_days || 5, parts_margin_target || 55, efficiency_target || 80, pph_target || 254]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', authenticateToken, requireOwner, async (req, res) => {
    const { name, address, city, province, shopmonkey_location_id, qbo_company_id, slack_channel, num_technicians, labour_rate, stale_threshold_days, parts_margin_target, efficiency_target, pph_target, active } = req.body;
    try {
      const result = await pool.query(
        `UPDATE locations SET name=$1, address=$2, city=$3, province=$4, shopmonkey_location_id=$5, qbo_company_id=$6, slack_channel=$7, num_technicians=$8, labour_rate=$9, stale_threshold_days=$10, parts_margin_target=$11, efficiency_target=$12, pph_target=$13, active=$14, updated_at=NOW()
         WHERE id=$15 RETURNING *`,
        [name, address, city, province, shopmonkey_location_id, qbo_company_id, slack_channel, num_technicians, labour_rate, stale_threshold_days, parts_margin_target, efficiency_target, pph_target, active, req.params.id]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Location not found' });
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
