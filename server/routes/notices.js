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

  // ── AI poster design (Claude designs the layout as SVG) ──
  // Claude can't paint photos, but it's strong at design-as-code. It returns a
  // bespoke 1080×1080 SVG per poster (composition, type, accents) under hard
  // guardrails: brand palette prompt, all text is REAL text (spelling can't
  // break), the logo is injected client-side (never drawn by the model), and
  // the SVG is sanitized here — scripts/foreignObject/event handlers/external
  // refs stripped. The client rasterizes to JPEG and uploads via /:id/image.
  const DESIGN_MODEL = 'claude-sonnet-4-6';
  const designSystem = `You are a poster designer for the shop-floor notice board of Mister Transmission (Parkland Transmission), an automotive transmission repair shop. You output ONE complete 1080x1080 SVG poster and nothing else — no markdown fences, no commentary.

Brand system (use ONLY these):
- Orange #F05423 (primary), #F8703B (light accent), #E14313 (deep accent)
- Charcoal #16181B, near-black #0A0B0D, off-white #F6F5F3, white #FFFFFF
- Display font: font-family="Archivo, Helvetica Neue, Arial, sans-serif" font-weight="800" (tight letter-spacing, e.g. -1)
- Body font: font-family="Helvetica Neue, Arial, sans-serif"

Rules:
- viewBox="0 0 1080 1080", width/height 1080. Vector shapes + text ONLY.
- The TITLE I give you must appear VERBATIM as the dominant headline — big and readable from across a garage bay (headline 72-110px). Break long titles across multiple lines using <tspan x="..." dy="...">.
- If BODY text is given, set it smaller (30-40px) below the headline, wrapped to lines of ~40 characters max via tspans.
- Leave the top-left area (x 0-320, y 0-170) visually calm — the brand logo is overlaid there afterward. No text there; background color/shapes are fine.
- Mood by KIND: celebration = energetic, bold diagonal shapes/rays/confetti dots, orange-dominant; safety = high-contrast, hazard chevrons or bold stripes, charcoal+orange, serious; notice = clean, minimal, informational.
- Fill the full canvas (no white page margins). Strong contrast: light text on dark, or charcoal on light.
- NO <script>, NO <image>, NO <foreignObject>, NO external URLs, NO event handlers, NO CTA phrases like "book now"/"call today".`;

  router.post('/design-poster', syncAuth, requireOwnerOrPartner, async (req, res) => {
    try {
      const KEY = process.env.ANTHROPIC_API_KEY;
      if (!KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });
      const { title, body, kind } = req.body || {};
      if (!title || !String(title).trim()) return res.status(400).json({ error: 'title required' });
      const mood = ['celebration', 'safety', 'notice', 'poster'].includes(kind) ? kind : 'notice';
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: DESIGN_MODEL, max_tokens: 4096, system: designSystem,
          messages: [{ role: 'user', content: `KIND: ${mood}\nTITLE: ${String(title).slice(0, 200)}\n${body ? `BODY: ${String(body).slice(0, 400)}` : 'BODY: (none)'}` }],
        }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: `Anthropic ${r.status}: ${JSON.stringify(data).slice(0, 200)}` });
      let raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const s = raw.indexOf('<svg'), e = raw.lastIndexOf('</svg>');
      if (s < 0 || e < 0) return res.status(502).json({ error: 'Model returned no SVG — try again' });
      let svg = raw.slice(s, e + 6);
      // Sanitize: no scripts, embedded docs, bitmap refs, handlers, or external URLs.
      svg = svg.replace(/<script[\s\S]*?<\/script>/gi, '')
               .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
               .replace(/<image[\s\S]*?(\/>|<\/image>)/gi, '')
               .replace(/\son\w+="[^"]*"/gi, '')
               .replace(/(xlink:href|href)="(?!#)[^"]*"/gi, '');
      res.json({ svg, kind: mood });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Create (no id) or update (with id). syncAuth: the CoS agent may post
  // notices with the machine key; it acts as owner.
  router.post('/', syncAuth, requireOwnerOrPartner, async (req, res) => {
    try {
      await ensureTable();
      const { id, location_id, kind, title, body, image_url, priority, active, expires_at, pending_image } = req.body || {};
      const k = KINDS.includes(kind) ? kind : 'notice';
      // pending_image: the client creates first, then uploads the file to
      // /:id/image — an image-only poster has no title/body/url at this point.
      if (!id && !title && !body && !image_url && !pending_image) {
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
