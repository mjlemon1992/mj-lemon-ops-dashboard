const express = require('express');
const { authenticateToken, requireOwner } = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  // display_pin gates the public shop-floor display; weekly_hours is the default
  // on-clock hours/tech used for the efficiency denominator (40 unless changed).
  let _colInit = false;
  const ensureColumns = async () => {
    if (_colInit) return;
    await pool.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS display_pin VARCHAR(12)');
    await pool.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS weekly_hours DECIMAL(6,2) DEFAULT 40');
    await pool.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS qbo_slug TEXT');
    _colInit = true;
  };

  // Owner machine auth (same pattern as the sync/CoS routes): a valid X-Sync-Key
  // stands in for an owner JWT. Fails closed if SYNC_SECRET is unset.
  const syncAuth = (req, res, next) => {
    const secret = process.env.SYNC_SECRET;
    const provided = req.get('X-Sync-Key');
    if (secret && provided && provided === secret) {
      req.user = { role: 'owner', via: 'sync-key' };
      return next();
    }
    return authenticateToken(req, res, next);
  };

  // Set ONLY the shop-floor display PIN. Owner-gated (JWT or sync key). Narrow on
  // purpose: lets the owner set/clear a board PIN without exposing the full
  // location update. PIN must be 3-12 digits (or empty string to clear).
  router.put('/:id/display-pin', syncAuth, requireOwner, async (req, res) => {
    try {
      await ensureColumns();
      const raw = (req.body && req.body.display_pin != null) ? String(req.body.display_pin).trim() : '';
      if (raw && !/^\d{3,12}$/.test(raw)) {
        return res.status(400).json({ error: 'display_pin must be 3-12 digits (or empty to clear)' });
      }
      const r = await pool.query(
        'UPDATE locations SET display_pin = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name',
        [raw || null, req.params.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Location not found' });
      res.json({ ok: true, id: r.rows[0].id, name: r.rows[0].name, pin_set: !!raw });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

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
    const { name, address, city, province, shopmonkey_location_id, qbo_company_id, qbo_slug, slack_channel, num_technicians, labour_rate, stale_threshold_days, parts_margin_target, efficiency_target, pph_target, display_pin, weekly_hours } = req.body;
    if (!name) return res.status(400).json({ error: 'Location name required' });
    try {
      await ensureColumns();
      const result = await pool.query(
        `INSERT INTO locations (name, address, city, province, shopmonkey_location_id, qbo_company_id, qbo_slug, slack_channel, num_technicians, labour_rate, stale_threshold_days, parts_margin_target, efficiency_target, pph_target, display_pin, weekly_hours, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true) RETURNING *`,
        [name, address, city, province, shopmonkey_location_id, qbo_company_id, qbo_slug || null, slack_channel, num_technicians || 5, labour_rate || 170, stale_threshold_days || 5, parts_margin_target || 55, efficiency_target || 80, pph_target || 254, display_pin || null, weekly_hours || 40]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // num_technicians is intentionally NOT updated here — it is auto-derived from
  // the live Shopmonkey roster (see routes/technicians.js) and must not be
  // clobbered by an edit-location save.
  router.put('/:id', authenticateToken, requireOwner, async (req, res) => {
    const { name, address, city, province, shopmonkey_location_id, qbo_company_id, qbo_slug, slack_channel, labour_rate, stale_threshold_days, parts_margin_target, efficiency_target, pph_target, active, display_pin, weekly_hours } = req.body;
    try {
      await ensureColumns();
      const result = await pool.query(
        `UPDATE locations SET name=$1, address=$2, city=$3, province=$4, shopmonkey_location_id=$5, qbo_company_id=$6, qbo_slug=$7, slack_channel=$8, labour_rate=$9, stale_threshold_days=$10, parts_margin_target=$11, efficiency_target=$12, pph_target=$13, active=$14, display_pin=$15, weekly_hours=$16, updated_at=NOW()
         WHERE id=$17 RETURNING *`,
        [name, address, city, province, shopmonkey_location_id, qbo_company_id, qbo_slug || null, slack_channel, labour_rate, stale_threshold_days, parts_margin_target, efficiency_target, pph_target, active, display_pin || null, weekly_hours || 40, req.params.id]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Location not found' });
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
