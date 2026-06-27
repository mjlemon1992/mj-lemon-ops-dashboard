const express = require('express');
const { authenticateToken, requireOwnerOrPartner } = require('../middleware/auth');

// Marketing module, piece 2: capture -> AI captions -> approval queue.
// A bay photo (+ short note) is stored, Claude writes platform captions, and it
// lands as a draft in the approval queue. Owner approves/edits/skips. ACTUAL
// posting to FB/IG/GBP is deferred until Meta app review + GBP API access clear —
// so "approve" currently just marks it ready; nothing leaves the building.
//
// v1 storage: images live in Postgres (bytea) with a 60-day purge of un-actioned
// drafts. Migrates to Cloudflare R2 when posting is built (public URLs needed then).
//
// Ships dark: no ANTHROPIC_API_KEY -> /status configured:false, intake 503s.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const PURGE_DAYS = parseInt(process.env.MARKETING_PURGE_DAYS || '60', 10);
const OK_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const CAPTION_SYSTEM = `You write social media captions for an automotive TRANSMISSION repair shop
(Mister Transmission — Parkland Transmission, Red Deer & Kelowna). You are given a photo from the
shop floor and an optional short note. Write platform-specific captions for the photo.

Brand voice: expert and plain-spoken, honest, no hype or clickbait. Red Seal technicians; happy to
give an honest second opinion; "we fix it right." Never invent specifics that aren't in the photo
or note (no fake prices, names, or claims).

Output ONLY a single JSON object, no prose, no fences:
{
  "instagram": "punchy, 1-3 short lines, end with 4-6 relevant hashtags",
  "facebook": "conversational, 2-4 sentences, a soft call-to-action, no hashtag spam",
  "gbp": "Google Business Profile post: 1-2 sentences, informative, a clear call-to-action"
}`;

module.exports = (pool) => {
  const router = express.Router();

  let _init = false;
  const ensureTables = async () => {
    if (_init) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS marketing_post (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
        location_name VARCHAR(255),
        status VARCHAR(20) NOT NULL DEFAULT 'draft',   -- draft | approved | skipped
        note TEXT,
        image_data BYTEA,
        image_mime VARCHAR(60),
        caption_ig TEXT, caption_fb TEXT, caption_gbp TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        actioned_at TIMESTAMPTZ
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_marketing_post_loc_status ON marketing_post(location_id, status, created_at DESC)');
    _init = true;
  };

  // Un-actioned drafts self-expire after PURGE_DAYS (the R2 "lifecycle rule",
  // done in SQL for the DB-backed v1). Posted/skipped rows are kept.
  const purge = async () => {
    await pool.query(
      `DELETE FROM marketing_post WHERE status='draft' AND created_at < NOW() - ($1 || ' days')::interval`,
      [String(PURGE_DAYS)]
    );
  };

  const locName = async (id) => {
    const { rows } = await pool.query('SELECT name FROM locations WHERE id = $1', [id]);
    if (!rows.length) throw Object.assign(new Error('Location not found'), { status: 404 });
    return rows[0].name;
  };

  // ── Caption generation (Anthropic REST, vision; no SDK dependency) ──
  const generate = async (imageBase64, mime, note) => {
    if (!ANTHROPIC_KEY) throw Object.assign(new Error('ANTHROPIC_API_KEY not set'), { status: 503 });
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        system: CAPTION_SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: imageBase64 } },
            { type: 'text', text: `Write the captions.${note ? ` Shop note: "${note}".` : ''}` },
          ],
        }],
      }),
    });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(`Anthropic ${res.status}: ${JSON.stringify(body).slice(0, 300)}`), { status: 502 });
    let raw = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('').replace(/```json|```/g, '').trim();
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
    try {
      const j = JSON.parse(raw);
      return { ig: j.instagram || '', fb: j.facebook || '', gbp: j.gbp || '' };
    } catch (err) {
      throw Object.assign(new Error('Caption generation returned invalid JSON — try again.'), { status: 502 });
    }
  };

  const dataUri = (row) => row.image_data ? `data:${row.image_mime};base64,${row.image_data.toString('base64')}` : null;
  const fail = (res, e) => res.status(e.status || 500).json({ error: String(e.message || e) });
  const gate = [authenticateToken, requireOwnerOrPartner];

  router.get('/status', ...gate, (req, res) => res.json({ configured: !!ANTHROPIC_KEY, model: MODEL, purgeDays: PURGE_DAYS }));

  // Intake: raw image body (Content-Type: image/*), ?note=...
  router.post('/:locationId/intake',
    ...gate,
    express.raw({ type: ['image/*', 'application/octet-stream'], limit: '30mb' }),
    async (req, res) => {
      try {
        await ensureTables();
        if (!Buffer.isBuffer(req.body) || !req.body.length)
          return res.status(400).json({ error: 'No image body. POST the photo with Content-Type: image/jpeg.' });
        let mime = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (mime === 'application/octet-stream') mime = 'image/jpeg';
        if (!OK_MIME.includes(mime))
          return res.status(415).json({ error: `Unsupported image type "${mime}". Use JPEG, PNG, WebP, or GIF (HEIC isn't supported yet — your phone may need "Most Compatible" camera format).` });

        const name = await locName(req.params.locationId);
        const note = (req.query.note || '').toString().slice(0, 500);
        const caps = await generate(req.body.toString('base64'), mime, note);

        const { rows } = await pool.query(
          `INSERT INTO marketing_post (location_id, location_name, status, note, image_data, image_mime, caption_ig, caption_fb, caption_gbp)
           VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
          [req.params.locationId, name, note || null, req.body, mime, caps.ig, caps.fb, caps.gbp]
        );
        res.json({ ok: true, id: rows[0].id });
      } catch (e) { fail(res, e); }
    }
  );

  // Approval queue: draft posts for a location, image inlined as a data URI.
  router.get('/:locationId/queue', ...gate, async (req, res) => {
    try {
      await ensureTables();
      await purge();
      const status = req.query.status || 'draft';
      const { rows } = await pool.query(
        `SELECT id, location_name, status, note, image_mime, image_data,
                caption_ig, caption_fb, caption_gbp, created_at, actioned_at
           FROM marketing_post WHERE location_id=$1 AND status=$2 ORDER BY created_at DESC LIMIT 50`,
        [req.params.locationId, status]
      );
      res.json(rows.map(r => ({
        id: r.id, location_name: r.location_name, status: r.status, note: r.note,
        captions: { ig: r.caption_ig, fb: r.caption_fb, gbp: r.caption_gbp },
        image: dataUri(r), created_at: r.created_at, actioned_at: r.actioned_at,
      })));
    } catch (e) { fail(res, e); }
  });

  const setStatus = (status) => async (req, res) => {
    try {
      await ensureTables();
      const { rows } = await pool.query(
        `UPDATE marketing_post SET status=$1, actioned_at=NOW() WHERE id=$2 RETURNING id`,
        [status, req.params.postId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Post not found' });
      res.json({ ok: true, id: rows[0].id, status });
    } catch (e) { fail(res, e); }
  };
  // NOTE: "approve" marks ready-to-post; real publishing waits on Meta/GBP access.
  router.post('/post/:postId/approve', ...gate, setStatus('approved'));
  router.post('/post/:postId/skip', ...gate, setStatus('skipped'));

  // Edit captions before approving.
  router.patch('/post/:postId', ...gate, async (req, res) => {
    try {
      await ensureTables();
      const { ig, fb, gbp } = req.body || {};
      const { rows } = await pool.query(
        `UPDATE marketing_post SET caption_ig=COALESCE($1,caption_ig), caption_fb=COALESCE($2,caption_fb),
           caption_gbp=COALESCE($3,caption_gbp) WHERE id=$4 RETURNING id`,
        [ig ?? null, fb ?? null, gbp ?? null, req.params.postId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Post not found' });
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });

  return router;
};
