const express = require('express');
const { authenticateToken, syncAuth, requireRole, canAccessLocation } = require('../middleware/auth');

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
    // Owner taste feedback on AI-designed posters (👍/👎 + the rated SVG).
    // Recent rows are fed back into the design prompt as aesthetic exemplars,
    // so the designer converges on what the owner actually likes.
    await pool.query(`CREATE TABLE IF NOT EXISTS notice_poster_feedback (
      id SERIAL PRIMARY KEY,
      rating VARCHAR(8) NOT NULL,      -- up | down
      kind VARCHAR(16),
      title VARCHAR(200),
      svg TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    _init = true;
  };

  const OK_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

  // Managers (shop operators) manage ONLY their own location's notices. Global
  // (all-locations) notices are owner/partner territory: managers see them on
  // their board and in the list, but can't create, edit, toggle or delete them.
  const manages = (user, noticeLocId) =>
    ['owner', 'partner'].includes(user.role) || (user.role === 'manager' && noticeLocId && noticeLocId === user.location_id);
  const assertManages = async (req, res) => {
    if (['owner', 'partner'].includes(req.user.role)) return true;
    const r = await pool.query('SELECT location_id FROM shop_notices WHERE id = $1', [req.params.id]);
    if (!r.rows.length) { res.status(404).json({ error: 'Notice not found' }); return false; }
    if (!manages(req.user, r.rows[0].location_id)) { res.status(403).json({ error: 'Access denied for this notice' }); return false; }
    return true;
  };


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
  router.get('/', authenticateToken, requireRole('owner', 'partner', 'manager', 'advisor'), async (req, res) => {
    try {
      await ensureTable();
      const mgrFilter = req.user.role === 'manager';
      const r = await pool.query(
        `SELECT id, location_id, kind, title, body, image_url, priority, active,
                expires_at, created_by, created_at, updated_at,
                (image_data IS NOT NULL) AS has_image
           FROM shop_notices
          ${mgrFilter ? 'WHERE (location_id IS NULL OR location_id = $1)' : ''}
          ORDER BY active DESC, priority ASC, created_at DESC LIMIT 100`,
        mgrFilter ? [req.user.location_id] : []
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Upload a poster/graphic for a notice: raw image body (Content-Type: image/*).
  // Mirrors the marketing intake pattern — no multipart, works from the phone.
  router.post('/:id/image',
    syncAuth, requireRole('owner', 'partner', 'manager', 'advisor'),
    express.raw({ type: ['image/*', 'application/octet-stream'], limit: '15mb' }),
    async (req, res) => {
      try {
        await ensureTable();
        if (!(await assertManages(req, res))) return;
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
  router.get('/:id/image', authenticateToken, requireRole('owner', 'partner', 'manager', 'advisor'), async (req, res) => {
    try {
      await ensureTable();
      const r = await pool.query('SELECT image_data, image_mime, location_id FROM shop_notices WHERE id = $1', [req.params.id]);
      if (!r.rows.length || !r.rows[0].image_data) return res.status(404).json({ error: 'No image' });
      if (req.user.role === 'manager' && r.rows[0].location_id && r.rows[0].location_id !== req.user.location_id) {
        return res.status(403).json({ error: 'Access denied for this notice' });
      }
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
- If a FOOTER line is provided, render it VERBATIM as a small attribution near the bottom (24-32px, muted off-white or light gray, bottom-left or bottom-center). Never alter it, never invent a different shop/location name anywhere on the poster.
- NO <script>, NO <image>, NO <foreignObject>, NO external URLs, NO event handlers, NO CTA phrases like "book now"/"call today".`;

  // Location-aware branding footer. Specific board -> that shop's line;
  // All locations -> combined line across active shops. Casing in the DB is
  // messy ("red deer ", "ab"), so normalize here — the model renders verbatim.
  const tcase = (s) => String(s || '').trim().split(/\s+/).map(w => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : '').join(' ');
  const brandLineFor = async (locationId) => {
    try {
      if (locationId) {
        const { rows } = await pool.query('SELECT name, city, province FROM locations WHERE id = $1', [locationId]);
        if (!rows.length) return 'Mister Transmission';
        const l = rows[0];
        return l.city ? `Mister Transmission — ${tcase(l.city)}, ${String(l.province || '').trim().toUpperCase()}`.replace(/, $/, '')
                      : `Mister Transmission — ${String(l.name || '').trim()}`;
      }
      const { rows } = await pool.query('SELECT city, name FROM locations WHERE active = true ORDER BY name');
      const cities = [...new Set(rows.map(l => tcase(l.city) || String(l.name || '').trim()).filter(Boolean))];
      return cities.length ? `Mister Transmission — ${cities.join(' & ')}` : 'Mister Transmission';
    } catch { return 'Mister Transmission'; }
  };

  router.post('/design-poster', syncAuth, requireRole('owner', 'partner', 'manager', 'advisor'), async (req, res) => {
    try {
      const KEY = process.env.ANTHROPIC_API_KEY;
      if (!KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });
      let { title, body, kind, location_id } = req.body || {};
      if (req.user.role === 'manager') location_id = req.user.location_id;
      if (!title || !String(title).trim()) return res.status(400).json({ error: 'title required' });
      const mood = ['celebration', 'safety', 'notice', 'poster'].includes(kind) ? kind : 'notice';
      await ensureTable();
      const footer = await brandLineFor(location_id || null);
      // Owner taste: recent 👍/👎 designs go in as aesthetic exemplars. SVGs are
      // clipped to bound the prompt; the model emulates/avoids the LOOK, never
      // the literal words of past posters.
      let taste = '';
      try {
        const fb = await pool.query('SELECT rating, svg FROM notice_poster_feedback ORDER BY created_at DESC LIMIT 12');
        const clip = (s) => String(s || '').slice(0, 3500);
        const ups = fb.rows.filter(x => x.rating === 'up').slice(0, 3);
        const downs = fb.rows.filter(x => x.rating === 'down').slice(0, 3);
        if (ups.length) taste += `\n\nOWNER TASTE — the owner LIKED these previous designs. Emulate their aesthetic direction (composition energy, palette use, type treatment) — NOT their literal words:\n${ups.map((x, i) => `LIKED ${i + 1}:\n${clip(x.svg)}`).join('\n')}`;
        if (downs.length) taste += `\n\nOWNER TASTE — the owner DISLIKED these designs. Avoid their aesthetic direction:\n${downs.map((x, i) => `DISLIKED ${i + 1}:\n${clip(x.svg)}`).join('\n')}`;
      } catch (_) { /* taste is garnish, never a blocker */ }
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: DESIGN_MODEL, max_tokens: 4096, system: designSystem,
          messages: [{ role: 'user', content: `KIND: ${mood}\nTITLE: ${String(title).slice(0, 200)}\n${body ? `BODY: ${String(body).slice(0, 400)}` : 'BODY: (none)'}\nFOOTER: ${footer}${taste}` }],
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

  // 👍/👎 on a generated design. Stored with the SVG; recent rows steer the
  // next generations (see the taste block in design-poster).
  router.post('/poster-feedback', syncAuth, requireRole('owner', 'partner', 'manager', 'advisor'), async (req, res) => {
    try {
      await ensureTable();
      const { rating, kind, title, svg } = req.body || {};
      if (!['up', 'down'].includes(rating)) return res.status(400).json({ error: 'rating must be "up" or "down"' });
      if (!svg) return res.status(400).json({ error: 'svg required' });
      await pool.query(
        'INSERT INTO notice_poster_feedback (rating, kind, title, svg) VALUES ($1,$2,$3,$4)',
        [rating, String(kind || '').slice(0, 16), String(title || '').slice(0, 200), String(svg).slice(0, 30000)]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── AI poster ideas ("💡 Suggest ideas", board-flavoured) ──
  // Proposes 4 internal posters for the techs: a safety reminder, a team
  // encouragement piece (metrics-aware — reads the shop's OWN numbers from
  // metrics_cache so praise has substance), a seasonal/culture piece, and a
  // wildcard. Safety ideas are constrained to universal, non-procedural
  // reminders — the model must never write repair procedures or spec claims.
  const IDEAS_SYSTEM = `You suggest posters for the shop-floor notice board of Mister Transmission (Parkland Transmission), an automotive transmission repair shop in Alberta/BC, Canada. The audience is the TECHNICIANS and shop staff (internal) — never customers.

Return ONLY a JSON array of exactly 4 ideas — no prose, no markdown fences:
[{"kind":"safety|celebration|notice","title":"poster headline, max 8 words","body":"supporting line, max 160 chars","why":"max 60 chars — why this, now"}]

The mix: one SAFETY reminder, one team ENCOURAGEMENT/celebration, one seasonal or shop-culture piece for the given month, one wildcard.
Safety rules: only universally-accepted, non-procedural shop safety (housekeeping, PPE, eye protection, lifting posture, hydration, slow-down-when-tired, spill cleanup). NEVER specific repair procedures, lift/jack instructions, electrical steps, or any torque/spec/technical claim.
Encouragement rules: if metrics are provided, ground the praise in them — cite ONLY numbers actually given, never invent or extrapolate. If no metrics, keep it genuine and general.
Financial privacy (hard rule): the ONLY business numbers allowed on the board are month-to-date REVENUE, CAR COUNT, LABOUR HOURS SOLD, and TECH EFFICIENCY vs its target. NEVER mention profit, margins, parts margin, profit-per-hour, costs, or average repair-order value — internal financial detail stays off the shop floor, even if it appears in the data you're given.
Voice: positive, plain-spoken, respectful of the trade. No hype, no corporate fluff, no CTAs.`;

  router.post('/poster-ideas', syncAuth, requireRole('owner', 'partner', 'manager', 'advisor'), async (req, res) => {
    try {
      const KEY = process.env.ANTHROPIC_API_KEY;
      if (!KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });
      let { location_id } = req.body || {};
      if (req.user.role === 'manager') location_id = req.user.location_id;
      await ensureTable();
      // Freshest metrics row (for the chosen board, else the freshest anywhere).
      // Deliberately narrow SELECT: revenue, cars, hours and efficiency ONLY.
      // Margin/profit economics are owner-level numbers and never reach the
      // model, so they can't leak onto the shop floor.
      let m = null;
      try {
        const q = location_id
          ? await pool.query(
              `SELECT m.revenue_mtd, m.car_count_mtd, m.labour_hours_sold, m.efficiency_avg, m.created_at, l.name, l.efficiency_target
                 FROM metrics_cache m JOIN locations l ON l.id = m.location_id
                WHERE m.location_id = $1 ORDER BY m.created_at DESC LIMIT 1`, [location_id])
          : await pool.query(
              `SELECT m.revenue_mtd, m.car_count_mtd, m.labour_hours_sold, m.efficiency_avg, m.created_at, l.name, l.efficiency_target
                 FROM metrics_cache m JOIN locations l ON l.id = m.location_id
                ORDER BY m.created_at DESC LIMIT 1`);
        m = q.rows[0] || null;
      } catch (_) { /* metrics are garnish, never a blocker */ }
      const month = new Date().toLocaleDateString('en-CA', { month: 'long', timeZone: 'America/Edmonton' });
      let ctx = 'No metrics available — keep encouragement general.';
      if (m && Number(m.revenue_mtd) > 0) {
        ctx = `Latest shop metrics for ${String(m.name || '').trim()} (as of ${new Date(m.created_at).toISOString().slice(0, 10)}): revenue MTD $${Math.round(m.revenue_mtd).toLocaleString('en-CA')} across ${m.car_count_mtd} cars`;
        if (Number(m.labour_hours_sold) > 0) ctx += `, ${Math.round(m.labour_hours_sold)} labour hours sold`;
        if (m.efficiency_avg != null) ctx += `, avg tech efficiency ${Math.round(m.efficiency_avg)}%${m.efficiency_target ? ` vs ${Math.round(m.efficiency_target)}% target` : ''}`;
        ctx += '.';
      }
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: DESIGN_MODEL, max_tokens: 900, system: IDEAS_SYSTEM,
          messages: [{ role: 'user', content: `Month: ${month}. ${ctx} Suggest 4 board poster ideas.` }],
        }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: `Anthropic ${r.status}` });
      let raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').replace(/```json|```/g, '').trim();
      const s = raw.indexOf('['), e = raw.lastIndexOf(']');
      if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
      const ideas = JSON.parse(raw);
      const KIND_OK = ['safety', 'celebration', 'notice'];
      res.json({
        ideas: (Array.isArray(ideas) ? ideas : []).slice(0, 6).map(i => ({
          kind: KIND_OK.includes(i.kind) ? i.kind : 'notice',
          title: String(i.title || '').slice(0, 120),
          body: String(i.body || '').slice(0, 200),
          why: String(i.why || '').slice(0, 80),
        })).filter(i => i.title),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Create (no id) or update (with id). syncAuth: the CoS agent may post
  // notices with the machine key; it acts as owner.
  router.post('/', syncAuth, requireRole('owner', 'partner', 'manager', 'advisor'), async (req, res) => {
    try {
      await ensureTable();
      let { id, location_id, kind, title, body, image_url, priority, active, expires_at, pending_image } = req.body || {};
      // A shop operator always posts to their own board — never global/others'.
      if (req.user.role === 'manager') location_id = req.user.location_id;
      const k = KINDS.includes(kind) ? kind : 'notice';
      // pending_image: the client creates first, then uploads the file to
      // /:id/image — an image-only poster has no title/body/url at this point.
      if (!id && !title && !body && !image_url && !pending_image) {
        return res.status(400).json({ error: 'title, body or image_url required' });
      }
      if (id) {
        if (req.user.role === 'manager') {
          const own = await pool.query('SELECT location_id FROM shop_notices WHERE id = $1', [id]);
          if (!own.rows.length) return res.status(404).json({ error: 'Notice not found' });
          if (!manages(req.user, own.rows[0].location_id)) return res.status(403).json({ error: 'Access denied for this notice' });
        }
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
  router.post('/:id/toggle', syncAuth, requireRole('owner', 'partner', 'manager', 'advisor'), async (req, res) => {
    try {
      await ensureTable();
      if (!(await assertManages(req, res))) return;
      const r = await pool.query(
        'UPDATE shop_notices SET active = NOT active, updated_at = NOW() WHERE id = $1 RETURNING *',
        [req.params.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Notice not found' });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/:id', authenticateToken, requireRole('owner', 'partner', 'manager', 'advisor'), async (req, res) => {
    try {
      await ensureTable();
      if (!(await assertManages(req, res))) return;
      await pool.query('DELETE FROM shop_notices WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
