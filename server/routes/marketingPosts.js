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

// Optional AI poster ART (the photographic hero behind a generated poster).
// Anthropic can't generate images, so this uses OpenAI's image API. Ships dark:
// no OPENAI_API_KEY -> /status imageGen:false, poster-image 503s, and the client
// falls back to the flat brand template. Model is overridable (gpt-image-1 is
// best; set OPENAI_IMAGE_MODEL=dall-e-3 if your org isn't verified for it).
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';

// The image is a BACKGROUND only — the dashboard overlays the real logo and the
// exact headline/copy on top, so the model is told to render NO text. That's how
// we keep spelling, brand colour, and the no-CTA rule perfect every time.
const IMAGE_STYLE = `Photorealistic, cinematic, professional automotive marketing photography. Premium, trustworthy, clean, dramatic natural light, shallow depth of field. Absolutely NO text, no words, no letters, no numbers, no logos, no watermarks, no badges anywhere in the image. Composition: keep the lower-left area darker and visually uncluttered so text can be overlaid there.`;
const imagePromptFor = (type, topic) => {
  const subj = (topic && topic.trim()) ? topic.trim()
    : type === 'seasonal' ? 'a vehicle on a scenic Alberta or BC road appropriate to the current season'
    : type === 'testimonial' ? 'a clean, modern, well-lit automotive service bay'
    : 'a transmission or drivetrain detail in a professional repair shop';
  return `Marketing poster background image for a transmission repair shop (Mister Transmission, Red Deer & Kelowna, Canada). Subject: ${subj}. ${IMAGE_STYLE}`;
};

const CAPTION_SYSTEM = `You write social media captions for an automotive TRANSMISSION repair shop
(Mister Transmission — Parkland Transmission, Red Deer & Kelowna). You are given a photo from the
shop floor and an optional short note. Write platform-specific captions for the photo.

Brand voice: expert and plain-spoken, honest, no hype or clickbait. Red Seal technicians; happy to
give an honest second opinion; "we fix it right." Never invent specifics that aren't in the photo
or note (no fake prices, names, or claims).

Write the captions by calling the write_captions tool — always call it, never reply with prose.
If the photo isn't a clear shop or vehicle subject, still write the best generic shop captions you
can rather than refusing.`;

// Forced-tool schema: the model must return structured captions, so it can never
// reply with prose that fails JSON parsing (the old cause of blank captions).
const CAPTION_TOOL = {
  name: 'write_captions',
  description: 'Return the three platform-specific captions for the shop photo.',
  input_schema: {
    type: 'object',
    properties: {
      instagram: { type: 'string', description: 'Punchy, 1-3 short lines, ending with 4-6 relevant hashtags.' },
      facebook: { type: 'string', description: 'Conversational, 2-4 sentences, a soft call-to-action, no hashtag spam.' },
      gbp: { type: 'string', description: 'Google Business Profile post: 1-2 informative sentences with a clear call-to-action.' },
    },
    required: ['instagram', 'facebook', 'gbp'],
  },
};

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
    // Soft-delete columns: a deleted post is kept (deleted_at set) so it can be
    // restored and so a vanished draft is never untraceable. deleted_via tells
    // user-delete from auto-purge; deleted_by records who.
    await pool.query('ALTER TABLE marketing_post ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE marketing_post ADD COLUMN IF NOT EXISTS deleted_via VARCHAR(20)');
    await pool.query('ALTER TABLE marketing_post ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(120)');
    // Append-only audit: every lifecycle event (create/approve/skip/delete/
    // restore/purge) so "why did this post change/vanish" is always answerable.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS marketing_post_audit (
        id BIGSERIAL PRIMARY KEY,
        post_id UUID,
        location_id UUID,
        action VARCHAR(20) NOT NULL,
        actor VARCHAR(120),
        detail TEXT,
        at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_mpa_post ON marketing_post_audit(post_id, at DESC)');
    _init = true;
  };

  // Audit is best-effort: a logging failure must never break the request that
  // triggered it. actorOf derives a stable label from the authed user.
  const actorOf = (req) => {
    const u = req && req.user;
    if (!u) return 'unknown';
    return String(u.email || (u.role ? `${u.role}:${u.id || ''}` : '') || u.id || 'unknown').slice(0, 120);
  };
  const audit = async (postId, locationId, action, actor, detail) => {
    try {
      await pool.query(
        'INSERT INTO marketing_post_audit (post_id, location_id, action, actor, detail) VALUES ($1,$2,$3,$4,$5)',
        [postId || null, locationId || null, action, actor || null, detail || null]
      );
    } catch (_) { /* never let auditing break the real operation */ }
  };

  // Un-actioned drafts self-expire after PURGE_DAYS (the R2 "lifecycle rule",
  // done in SQL for the DB-backed v1). Posted/skipped rows are kept.
  const purge = async () => {
    // Un-actioned drafts past PURGE_DAYS are SOFT-deleted (recoverable + logged),
    // not dropped — so an "expired" draft can still be explained and restored.
    const { rows } = await pool.query(
      `UPDATE marketing_post SET deleted_at = NOW(), deleted_via = 'purge'
         WHERE status='draft' AND deleted_at IS NULL AND created_at < NOW() - ($1 || ' days')::interval
         RETURNING id, location_id`,
      [String(PURGE_DAYS)]
    );
    for (const r of rows) await audit(r.id, r.location_id, 'purge', 'system', `auto-expired after ${PURGE_DAYS}d`);
    // Reclaim storage: rows soft-deleted longer than PURGE_DAYS are gone for good
    // (their image bytea would otherwise accumulate forever).
    await pool.query(
      `DELETE FROM marketing_post WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - ($1 || ' days')::interval`,
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
    const callAnthropic = () => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: CAPTION_SYSTEM,
        tools: [CAPTION_TOOL],
        // Force the structured tool call so the model can't return prose instead of
        // JSON — which is what previously left captions blank on off-topic photos.
        tool_choice: { type: 'tool', name: 'write_captions' },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: imageBase64 } },
            { type: 'text', text: `Write the captions.${note ? ` Shop note: "${note}".` : ''}` },
          ],
        }],
      }),
    });
    // One retry on a transient Anthropic failure (overloaded / rate-limited / 5xx) so a
    // brief blip doesn't leave the draft with blank captions and no obvious cause.
    let res = await callAnthropic();
    if (!res.ok && [429, 500, 502, 503, 529].includes(res.status)) {
      await new Promise(r => setTimeout(r, 1500));
      res = await callAnthropic();
    }
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(`Anthropic ${res.status}: ${JSON.stringify(body).slice(0, 300)}`), { status: 502 });
    const tu = (body.content || []).find(b => b.type === 'tool_use' && b.name === 'write_captions');
    if (!tu || !tu.input) throw Object.assign(new Error('Caption generation returned no captions — try again.'), { status: 502 });
    return { ig: tu.input.instagram || '', fb: tu.input.facebook || '', gbp: tu.input.gbp || '' };
  };

  const dataUri = (row) => row.image_data ? `data:${row.image_mime};base64,${row.image_data.toString('base64')}` : null;
  const fail = (res, e) => res.status(e.status || 500).json({ error: String(e.message || e) });
  const gate = [authenticateToken, requireOwnerOrPartner];

  router.get('/status', ...gate, (req, res) => res.json({ configured: !!ANTHROPIC_KEY, model: MODEL, purgeDays: PURGE_DAYS, imageGen: !!OPENAI_KEY }));

  // Generate the photographic poster BACKGROUND (no text) for a topic. The client
  // composites the real logo + exact copy over it. 503 when no key (ships dark).
  router.post('/poster-image', ...gate, async (req, res) => {
    try {
      if (!OPENAI_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY not set' });
      const { type = 'seasonal', topic = '' } = req.body || {};
      const isGptImage = /^gpt-image/.test(IMAGE_MODEL);
      const payload = { model: IMAGE_MODEL, prompt: imagePromptFor(type, topic), n: 1, size: '1024x1024' };
      // Quality scales differ per model; gpt-image-1 always returns b64, dall-e
      // needs response_format to get b64 instead of a short-lived URL.
      if (isGptImage) payload.quality = 'high';
      else { payload.quality = 'hd'; payload.response_format = 'b64_json'; }
      const r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await r.json();
      if (!r.ok) return res.status(502).json({ error: `OpenAI ${r.status}: ${JSON.stringify(body).slice(0, 200)}` });
      const b64 = body.data && body.data[0] && body.data[0].b64_json;
      if (!b64) return res.status(502).json({ error: 'No image returned' });
      res.json({ image: `data:image/png;base64,${b64}` });
    } catch (e) { fail(res, e); }
  });

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

        // Create the draft FIRST so a card always appears — you can always write or
        // edit the captions yourself. Caption generation is best-effort afterward.
        const { rows } = await pool.query(
          `INSERT INTO marketing_post (location_id, location_name, status, note, image_data, image_mime)
           VALUES ($1,$2,'draft',$3,$4,$5) RETURNING id`,
          [req.params.locationId, name, note || null, req.body, mime]
        );
        const id = rows[0].id;
        await audit(id, req.params.locationId, 'created', actorOf(req), note ? `note: ${note.slice(0, 80)}` : null);

        let captionError = null;
        try {
          const caps = await generate(req.body.toString('base64'), mime, note);
          await pool.query('UPDATE marketing_post SET caption_ig=$1, caption_fb=$2, caption_gbp=$3 WHERE id=$4',
            [caps.ig, caps.fb, caps.gbp, id]);
        } catch (e) { captionError = String(e.message || e); }

        res.json({ ok: true, id, captionError });
      } catch (e) { fail(res, e); }
    }
  );

  // Approval queue: draft posts for a location, image inlined as a data URI.
  router.get('/:locationId/queue', ...gate, async (req, res) => {
    try {
      await ensureTables();
      await purge();
      const status = req.query.status || 'draft';
      // status=deleted returns the "Recently deleted" bin (soft-deleted rows,
      // newest first by when they were deleted). Every other status excludes
      // soft-deleted rows so a deleted post never lingers in a live queue.
      const where = status === 'deleted'
        ? 'location_id=$1 AND deleted_at IS NOT NULL'
        : 'location_id=$1 AND status=$2 AND deleted_at IS NULL';
      const params = status === 'deleted' ? [req.params.locationId] : [req.params.locationId, status];
      const { rows } = await pool.query(
        `SELECT id, location_name, status, note, image_mime, image_data,
                caption_ig, caption_fb, caption_gbp, created_at, actioned_at, deleted_at, deleted_via
           FROM marketing_post WHERE ${where}
           ORDER BY COALESCE(deleted_at, created_at) DESC LIMIT 50`,
        params
      );
      res.json(rows.map(r => ({
        id: r.id, location_name: r.location_name, status: r.status, note: r.note,
        captions: { ig: r.caption_ig, fb: r.caption_fb, gbp: r.caption_gbp },
        image: dataUri(r), created_at: r.created_at, actioned_at: r.actioned_at,
        deleted_at: r.deleted_at, deleted_via: r.deleted_via,
      })));
    } catch (e) { fail(res, e); }
  });

  const setStatus = (status) => async (req, res) => {
    try {
      await ensureTables();
      const { rows } = await pool.query(
        `UPDATE marketing_post SET status=$1, actioned_at=NOW() WHERE id=$2 AND deleted_at IS NULL RETURNING id, location_id`,
        [status, req.params.postId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Post not found' });
      await audit(rows[0].id, rows[0].location_id, status, actorOf(req), null);
      res.json({ ok: true, id: rows[0].id, status });
    } catch (e) { fail(res, e); }
  };
  // NOTE: "approve" marks ready-to-post; real publishing waits on Meta/GBP access.
  router.post('/post/:postId/approve', ...gate, setStatus('approved'));
  router.post('/post/:postId/skip', ...gate, setStatus('skipped'));
  router.post('/post/:postId/unapprove', ...gate, setStatus('draft'));

  // Soft delete (e.g. imported the wrong image). The row + image are KEPT and
  // hidden from the live queues; it lands in "Recently deleted" and can be
  // restored. A bounded hard-sweep in purge() reclaims the storage later. Every
  // delete is audited, so a vanished post is always attributable.
  router.delete('/post/:postId', ...gate, async (req, res) => {
    try {
      await ensureTables();
      const actor = actorOf(req);
      const { rows } = await pool.query(
        `UPDATE marketing_post SET deleted_at = NOW(), deleted_via = 'user', deleted_by = $2
           WHERE id=$1 AND deleted_at IS NULL RETURNING id, location_id`,
        [req.params.postId, actor]
      );
      if (!rows.length) return res.status(404).json({ error: 'Post not found' });
      await audit(rows[0].id, rows[0].location_id, 'delete', actor, 'soft-deleted via UI');
      res.json({ ok: true, id: rows[0].id, softDeleted: true });
    } catch (e) { fail(res, e); }
  });

  // Restore a soft-deleted post back to its prior status.
  router.post('/post/:postId/restore', ...gate, async (req, res) => {
    try {
      await ensureTables();
      const { rows } = await pool.query(
        `UPDATE marketing_post SET deleted_at = NULL, deleted_via = NULL, deleted_by = NULL
           WHERE id=$1 AND deleted_at IS NOT NULL RETURNING id, location_id`,
        [req.params.postId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Post not found or not deleted' });
      await audit(rows[0].id, rows[0].location_id, 'restore', actorOf(req), null);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });

  // Per-post audit trail: who did what, when. Answers "why did this change/vanish".
  router.get('/post/:postId/audit', ...gate, async (req, res) => {
    try {
      await ensureTables();
      const { rows } = await pool.query(
        'SELECT action, actor, detail, at FROM marketing_post_audit WHERE post_id=$1 ORDER BY at DESC LIMIT 100',
        [req.params.postId]
      );
      res.json(rows);
    } catch (e) { fail(res, e); }
  });

  // Edit captions before approving.
  router.patch('/post/:postId', ...gate, async (req, res) => {
    try {
      await ensureTables();
      const { ig, fb, gbp } = req.body || {};
      const { rows } = await pool.query(
        `UPDATE marketing_post SET caption_ig=COALESCE($1,caption_ig), caption_fb=COALESCE($2,caption_fb),
           caption_gbp=COALESCE($3,caption_gbp) WHERE id=$4 AND deleted_at IS NULL RETURNING id`,
        [ig ?? null, fb ?? null, gbp ?? null, req.params.postId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Post not found' });
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { fail(res, e); }
  });

  // Re-run caption generation on the stored image (e.g. you didn't like the draft).
  router.post('/post/:postId/regenerate', ...gate, async (req, res) => {
    try {
      await ensureTables();
      const { rows } = await pool.query('SELECT image_data, image_mime, note FROM marketing_post WHERE id=$1 AND deleted_at IS NULL', [req.params.postId]);
      if (!rows.length) return res.status(404).json({ error: 'Post not found' });
      const r = rows[0];
      if (!r.image_data) return res.status(400).json({ error: 'No stored image to regenerate from' });
      const caps = await generate(r.image_data.toString('base64'), r.image_mime, r.note || '');
      await pool.query('UPDATE marketing_post SET caption_ig=$1, caption_fb=$2, caption_gbp=$3 WHERE id=$4',
        [caps.ig, caps.fb, caps.gbp, req.params.postId]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Generate poster/ad COPY (headline/subline/cta). The client renders it into a
  // branded template and uploads the result as a normal image draft.
  const POSTER_SYSTEM = `You write copy for a BRANDED POSTER / social ad for a transmission repair shop
(Mister Transmission — Parkland Transmission, Red Deer & Kelowna AB/BC). Voice: expert, plain-spoken,
honest, no hype, no clickbait. Given a poster TYPE and optional TOPIC, return ONLY JSON, no fences:
{"headline":"3-7 punchy words","subline":"one sentence, <=120 chars","cta":"short action, <=28 chars"}
- "seasonal": tie to the season/topic (winter, tow season, road-trip).
- "educational": a trust-building "did you know" fact about transmissions.
- "testimonial": treat TOPIC as a customer quote — headline = a short pull-quote from it, subline =
  brief context, cta = a soft invite. If no quote is given, write a credible, generic one.
Never invent prices or specifics you weren't given.`;

  router.post('/poster-copy', ...gate, async (req, res) => {
    try {
      if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });
      const { type = 'seasonal', topic = '' } = req.body || {};
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL, max_tokens: 600, system: POSTER_SYSTEM,
          messages: [{ role: 'user', content: `Poster type: ${type}. Topic: ${topic || '(none — pick something seasonally relevant for an Alberta/BC transmission shop)'}` }],
        }),
      });
      const body = await r.json();
      if (!r.ok) return res.status(502).json({ error: `Anthropic ${r.status}: ${JSON.stringify(body).slice(0, 200)}` });
      let raw = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('').replace(/```json|```/g, '').trim();
      const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
      if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
      const j = JSON.parse(raw);
      res.json({ headline: j.headline || '', subline: j.subline || '', cta: j.cta || 'Book your transmission check' });
    } catch (e) { fail(res, e); }
  });

  // Suggest timely poster ideas for the current season / time of year.
  const IDEAS_SYSTEM = `You suggest timely social-media POSTER ideas for a transmission repair shop in
Alberta & BC, Canada (Mister Transmission — Parkland Transmission). Given the current month, propose
ideas tied to the season and what drivers are doing then: summer road trips, towing/RV/boat season,
heat stress on transmissions, fall maintenance, winter cold-starts & block heaters, holiday travel,
spring thaw, back-to-school. Mix practical/educational with a seasonal hook.
Return ONLY a JSON array of 4 items, no prose, no fences:
[{"type":"seasonal|educational|testimonial","topic":"specific concrete topic, <=70 chars","label":"3-5 word button label","why":"<=60 chars why it's timely"}]
Honest, on-brand, no hype, no invented stats.`;

  router.post('/poster-ideas', ...gate, async (req, res) => {
    try {
      if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });
      const { month = '' } = req.body || {};
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL, max_tokens: 700, system: IDEAS_SYSTEM,
          messages: [{ role: 'user', content: `Current month: ${month || '(unknown)'}. Region: Alberta & BC, Canada. Suggest 4 timely poster ideas.` }],
        }),
      });
      const body = await r.json();
      if (!r.ok) return res.status(502).json({ error: `Anthropic ${r.status}` });
      let raw = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('').replace(/```json|```/g, '').trim();
      const s = raw.indexOf('['), e = raw.lastIndexOf(']');
      if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
      const ideas = JSON.parse(raw);
      res.json({ ideas: Array.isArray(ideas) ? ideas.slice(0, 6) : [] });
    } catch (e) { fail(res, e); }
  });

  return router;
};
