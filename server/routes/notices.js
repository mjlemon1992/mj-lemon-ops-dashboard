const express = require('express');
const { authenticateToken, syncAuth, requireOwnerOrPartner } = require('../middleware/auth');

// Shop-floor notices: short updates, celebrations, safety notes, or full-image
// posters that rotate on the PIN-gated /display board so techs actually see
// them. Owner/partner writes from the dashboard UI; the Chief-of-Staff agent
// can also post via X-Sync-Key ("tell the shop..."). The display route reads
// active notices directly — no auth there beyond the display PIN.
module.exports = (pool) => {
  const router = express.Router();

  let _init = false;
  const ensureTable = async () => {
    if (_init) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS shop_notices (
      id SERIAL PRIMARY KEY,
      location_id UUID,                -- NULL = every location's board
      kind VARCHAR(16) NOT NULL DEFAULT 'notice',  -- notice | celebration | safety | poster
      title VARCHAR(200),
      body TEXT,
      image_url TEXT,                  -- poster/graphic; poster kind renders image full-bleed
      priority INTEGER NOT NULL DEFAULT 5,          -- 1 = top of rotation
      active BOOLEAN NOT NULL DEFAULT true,
      expires_at TIMESTAMP,            -- NULL = until turned off
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    // Uploaded poster bytes (same Postgres-bytea pattern as marketing_post).
    await pool.query('ALTER TABLE shop_notices ADD COLUMN IF NOT EXISTS image_data BYTEA');
    await pool.query('ALTER TABLE shop_notices ADD COLUMN IF NOT EXISTS image_mime VARCHAR(60)');
    _init = true;
  };

  const OK_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

  const KINDS = ['notice', 'celebration', 'safety', 'poster'];

  // Active notices for one location's board (used by display.js too).
  router.getActiveForLocation = async (locationId) => {
    await ensureTable();
    const r = await pool.query(
      `SELECT id, kind, title, body, image_url, priority, created_at
         FROM shop_notices
        WHERE active = true
          AND (location_id IS NULL OR location_id = $1)
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY priority ASC, created_at DESC
        LIMIT 20`,
      [locationId]
    );
    return r.rows;
  };

  // Admin list (all notices incl. inactive/expired, newest first). Image bytes
  // stay out of the list; has_image + the /:id/image endpoint cover previews.
  router.get('/', authenticateToken, requireOwnerOrPartner, async (req, res) => {
    try {
      await ensureTable();
      const r = await pool.query(
        `SELECT id, location_id, kind, title, body, image_url, priority, active,
                expires_at, created_by, created_at, updated_at,
                (image_data IS NOT NULL) AS has_image
           FROM shop_notices ORDER BY active DESC, priority ASC, created_at DESC LIMIT 100`
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Upload a poster/graphic for a notice: raw image body (Content-Type: image/*).
  // Mirrors the marketing intake pattern — no multipart, works from the phone.
  router.post('/:id/image',
    syncAuth, requireOwnerOrPartner,
    express.raw({ type: ['image/*', 'application/octet-stream'], limit: '15mb' }),
    async (req, res) => {
      try {
        await ensureTable();
        if (!req.body || !req.body.length) return res.status(400).json({ error: 'No image body. POST the file with Content-Type: image/png (or jpeg/webp/gif).' });
        let mime = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (mime === 'application/octet-stream') mime = 'image/jpeg';
        if (!OK_MIME.includes(mime)) return res.status(415).json({ error: `Unsupported image type "${mime}". Use JPEG, PNG, WebP, or GIF.` });
        const r = await pool.query(
          'UPDATE shop_notices SET image_data = $2, image_mime = $3, updated_at = NOW() WHERE id = $1 RETURNING id',
          [req.params.id, req.body, mime]
        );
        if (!r.rows.length) return res.status(404).json({ error: 'Notice not found' });
        res.json({ ok: true, id: r.rows[0].id, bytes: req.body.length, mime });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

  // Serve a stored image (admin preview). The display board gets images inlined
  // as data URIs in its own payload, so this stays JWT-only.
  router.get('/:id/image', authenticateToken, requireOwnerOrPartner, async (req, res) => {
    try {
      await ensureTable();
      const r = await pool.query('SELECT image_data, image_mime FROM shop_notices WHERE id = $1', [req.params.id]);
      if (!r.rows.length || !r.rows[0].image_data) return res.status(404).json({ error: 'No image' });
      res.set('Content-Type', r.rows[0].image_mime || 'image/jpeg');
      res.set('Cache-Control', 'private, max-age=300');
      res.send(r.rows[0].image_data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Create (no id) or update (with id). syncAuth: the CoS agent may post
  // notices with the machine key; it acts as owner.
  router.post('/', syncAuth, requireOwnerOrPartner, async (req, res) => {
    try {
      await ensureTable();
      const { id, location_id, kind, title, body, image_url, priority, active, expires_at } = req.body || {};
      const k = KINDS.includes(kind) ? kind : 'notice';
      if (!id && !title && !body && !image_url) {
        return res.status(400).json({ error: 'title, body or image_url required' });
      }
      if (id) {
        const r = await pool.query(
          `UPDATE shop_notices SET
             location_id = COALESCE($2, location_id),
             kind = COALESCE($3, kind),
             title = COALESCE($4, title),
             body = COALESCE($5, body),
             image_url = COALESCE($6, image_url),
             priority = COALESCE($7, priority),
             active = COALESCE($8, active),
             expires_at = $9,
             updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [id, location_id, kind ? k : null, title, body, image_url, priority, active, expires_at || null]
        );
        if (!r.rows.length) return res.status(404).json({ error: 'Notice not found' });
        return res.json(r.rows[0]);
      }
      const r = await pool.query(
        `INSERT INTO shop_notices (location_id, kind, title, body, image_url, priority, active, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [location_id || null, k, title || null, body || null, image_url || null,
         priority != null ? priority : 5, active !== false, expires_at || null,
         req.user.via === 'sync-key' ? 'chief-of-staff' : (req.user.email || req.user.name || 'owner')]
      );
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Quick on/off from the admin list.
  router.post('/:id/toggle', syncAuth, requireOwnerOrPartner, async (req, res) => {
    try {
      await ensureTable();
      const r = await pool.query(
        'UPDATE shop_notices SET active = NOT active, updated_at = NOW() WHERE id = $1 RETURNING *',
        [req.params.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Notice not found' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/:id', authenticateToken, requireOwnerOrPartner, async (req, res) => {
    try {
      await ensureTable();
      await pool.query('DELETE FROM shop_notices WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
