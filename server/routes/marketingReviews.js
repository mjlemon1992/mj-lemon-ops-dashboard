const express = require('express');
const { authenticateToken, syncAuth, requireRole, canAccessLocation } = require('../middleware/auth');
const { notifyRoles } = require('../lib/notify');
const { postSlack } = require('../lib/slack');

// Marketing: live Google review scorecard + AI reply pipeline. Pulls rating, total count and a
// few recent reviews from the Google Places Details API, cached 12h per location.
//
// Reply pipeline (the in-house Review Manager — Shopmonkey CRM's auto-posts, ours keeps a
// human in the loop):
//   watch (2h scheduler, self-throttled to 6h) → new review detected → Claude AUTO-DRAFTS the
//   reply → push notification to owner/partner/manager ("draft ready") → human edits/copies →
//   pastes on Google → Mark posted. The drafts table carries status (new → posted/dismissed),
//   so future auto-POSTING via the Google Business Profile API (OAuth + Google approval) slots
//   in exactly where "human pastes" sits today — nothing else changes.
// The month-over-month delta needs history, so we snapshot {rating,total} once per calendar
// month and diff against it.
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;
const MODEL_FRESH_MS = 12 * 60 * 60 * 1000;
const WATCH_EVERY_MS = 6 * 60 * 60 * 1000;   // Places 'reviews' field bills per call — 4x/day is plenty
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const SLACK_WEBHOOK = process.env.SLACK_MARKETING_WEBHOOK_URL;

// Public replies are brand surface + legal surface: gracious always, defensive never,
// and no admissions or job specifics that could bite in a dispute.
const REPLY_SYSTEM = `You draft the shop's public reply to a Google review of a transmission repair shop. Rules:
- 1-3 sentences, warm and plain-spoken, no corporate filler, no emojis, no hashtags, no ALL CAPS.
- Address the reviewer by first name when one is given.
- 4-5 stars: thank them and echo ONE specific thing they praised; welcome them back. No discounts, offers, or promises.
- 3 stars or below: stay calm and gracious. Never argue, never blame the customer or staff, admit no fault and no liability, and do not discuss the specifics of the job in public. Say the shop would like to make it right and invite them to call the shop directly.
- Never mention prices, warranty decisions, refunds, or personal information.
- Write in the same language as the review.
Return ONLY the reply text — no quotes, no preamble.`;

// Preview mode: set MARKETING_REVIEWS_DEMO=1 to render a clearly-labelled SAMPLE scorecard
// before the Google key / place_id are wired up. Returned with demo:true so the UI marks it
// "sample" (not "live"); never cached, and real data always wins once the key is set.
const DEMO = /^(1|true|yes)$/i.test(process.env.MARKETING_REVIEWS_DEMO || '');
const demoPayload = () => ({
  rating: 4.7, total: 127, delta: 3, demo: true,
  reviews: [{ author: 'Martin F.', rating: 5, when: '2 days ago',
    text: 'Honest about what actually needed doing. Saved me a grand vs the dealer quote.' }],
});

module.exports = (pool) => {
  const router = express.Router();

  let _init = false;
  const ensure = async () => {
    if (_init) return;
    await pool.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS google_place_id VARCHAR(255)');
    await pool.query(`CREATE TABLE IF NOT EXISTS marketing_reviews_cache (
      location_id UUID PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
      payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS marketing_reviews_snapshot (
      location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      year INTEGER NOT NULL, month INTEGER NOT NULL,
      total INTEGER, rating DECIMAL(2,1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (location_id, year, month))`);
    // One row per seen review; the reply lifecycle lives in status:
    // seed (pre-existing at first watch, never notified) → new (auto-drafted,
    // notified) → posted / dismissed (human decision; future GBP auto-post
    // stamps 'posted' itself).
    await pool.query(`CREATE TABLE IF NOT EXISTS review_reply_drafts (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      review_time BIGINT NOT NULL,
      author VARCHAR(255),
      rating INTEGER,
      review_text TEXT,
      draft TEXT,
      status VARCHAR(16) NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (location_id, review_time, author))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS review_watch_state (
      location_id UUID PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
      last_run TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    _init = true;
  };

  // Google Places Details: rating, total count, up to 5 recent reviews.
  const fetchPlace = async (placeId) => {
    const params = new URLSearchParams({ place_id: placeId, fields: 'rating,user_ratings_total,reviews', key: GOOGLE_KEY });
    const r = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?${params}`);
    const d = await r.json();
    if (d.status !== 'OK') throw Object.assign(new Error(`Google Places ${d.status}: ${d.error_message || ''}`.trim()), { status: 502 });
    return d.result || {};
  };

  const draftReply = async (shopName, { author, rating, text }) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 300, system: REPLY_SYSTEM,
        messages: [{ role: 'user', content:
          `Shop: ${shopName}\nReviewer: ${author || '(no name)'}\nRating: ${rating} star(s)\nReview: ${String(text || '(star rating only, no text)').slice(0, 1500)}` }],
      }),
    });
    const body = await r.json();
    if (!r.ok) throw Object.assign(new Error(`Anthropic ${r.status}: ${JSON.stringify(body).slice(0, 200)}`), { status: 502 });
    const draft = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!draft) throw new Error('Empty draft');
    return draft;
  };

  // Snapshot {total,rating} once per calendar month; delta = current total - this month's snapshot.
  const monthDelta = async (locId, total, rating) => {
    // Month key in the shop's timezone (matching every other monthly bucket in
    // the app) — UTC would roll the "this month" delta ~6h early on month-end.
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: 'numeric' })
      .formatToParts(new Date());
    const year = +p.find(x => x.type === 'year').value, month = +p.find(x => x.type === 'month').value;
    const { rows } = await pool.query('SELECT total FROM marketing_reviews_snapshot WHERE location_id=$1 AND year=$2 AND month=$3', [locId, year, month]);
    if (!rows.length) {
      await pool.query(`INSERT INTO marketing_reviews_snapshot (location_id, year, month, total, rating)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (location_id, year, month) DO NOTHING`, [locId, year, month, total, rating]);
      return 0;   // first sighting this month — no baseline to diff yet
    }
    const base = rows[0].total;
    return base != null && total != null ? Math.max(0, total - base) : 0;
  };

  const fail = (res, e) => res.status(e.status || 500).json({ error: String(e.message || e) });
  // Shop operators (managers) may use this for THEIR location; asserted below.
  const gate = [authenticateToken, requireRole('owner', 'partner', 'manager')];
  const assertLoc = (req, res) => {
    if (canAccessLocation(req.user, req.params.locationId)) return true;
    res.status(403).json({ error: 'Access denied for this location' });
    return false;
  };

  router.get('/status', ...gate, (req, res) => res.json({ configured: !!GOOGLE_KEY }));

  // Cached 12h; ?force=1 refetches. 503 when the key or this location's place_id is missing,
  // which the client treats as "not configured" and hides the tile. Stored reply drafts ride
  // along uncached so status flips (posted/dismissed) show immediately.
  router.get('/:locationId', ...gate, async (req, res) => {
    if (!assertLoc(req, res)) return;
    try {
      await ensure();
      const id = req.params.locationId, force = req.query.force === '1';
      const { rows: draftRows } = await pool.query(
        `SELECT review_time, author, rating, draft, status FROM review_reply_drafts
         WHERE location_id=$1 AND status <> 'seed'
         ORDER BY review_time DESC LIMIT 10`, [id]);
      const drafts = draftRows.map(d => ({ ...d, review_time: Number(d.review_time) }));
      if (!force) {
        const { rows } = await pool.query('SELECT payload, created_at FROM marketing_reviews_cache WHERE location_id=$1', [id]);
        if (rows.length && (Date.now() - new Date(rows[0].created_at).getTime()) < MODEL_FRESH_MS) {
          const p = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
          return res.json({ ...p, drafts, cached: true });
        }
      }
      if (!GOOGLE_KEY) {
        if (DEMO) return res.json(demoPayload());
        return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY not set' });
      }
      const { rows: lr } = await pool.query('SELECT google_place_id FROM locations WHERE id=$1', [id]);
      if (!lr.length) return res.status(404).json({ error: 'Location not found' });
      const placeId = lr[0].google_place_id;
      if (!placeId) {
        if (DEMO) return res.json(demoPayload());
        return res.status(503).json({ error: 'google_place_id not set for this location' });
      }

      const r = await fetchPlace(placeId);
      const total = r.user_ratings_total ?? null, rating = r.rating ?? null;
      // Featured quotes: 4★+ only (the scorecard showcases wins). Low-star
      // recents aren't hidden from the owner — they surface as a count so the
      // card can say "N recent under 4★ · handle on Google" without the text.
      const fetched = (r.reviews || []);
      const reviews = fetched.filter(rv => Number(rv.rating) >= 4).slice(0, 3).map(rv => ({
        author: rv.author_name, rating: rv.rating, text: rv.text,
        when: rv.relative_time_description, time: rv.time,
      }));
      const lows = fetched.filter(rv => Number(rv.rating) < 4);
      const low_recent = lows.length;
      // Low-star text rides along for the reply-drafting flow — these are the
      // reviews that most need a response. Featured quotes stay 4★+ only.
      const attention = lows.slice(0, 3).map(rv => ({
        author: rv.author_name, rating: rv.rating, text: rv.text,
        when: rv.relative_time_description, time: rv.time,
      }));
      const dlt = await monthDelta(id, total, rating);
      const payload = { rating, total, delta: dlt, reviews, low_recent, attention };
      await pool.query(`INSERT INTO marketing_reviews_cache (location_id, payload, created_at) VALUES ($1,$2,NOW())
        ON CONFLICT (location_id) DO UPDATE SET payload=EXCLUDED.payload, created_at=NOW()`, [id, JSON.stringify(payload)]);
      res.json({ ...payload, drafts, cached: false });
    } catch (e) { fail(res, e); }
  });

  // The review watcher — hit by the 2h scheduler, self-throttled to every 6h
  // (the Places 'reviews' field bills per call). New review → auto-draft →
  // push notification with the draft ready. First run seeds silently so a
  // fresh location doesn't blast notifications for old reviews.
  router.post('/:locationId/watch', syncAuth, requireRole('owner', 'partner'), async (req, res) => {
    try {
      await ensure();
      const id = req.params.locationId;
      const force = req.query.force === '1';
      if (!GOOGLE_KEY) return res.json({ ran: false, reason: 'GOOGLE_MAPS_API_KEY not set' });
      const { rows: lr } = await pool.query('SELECT name, google_place_id FROM locations WHERE id=$1', [id]);
      if (!lr.length) return res.status(404).json({ error: 'Location not found' });
      if (!lr[0].google_place_id) return res.json({ ran: false, reason: 'google_place_id not set' });

      const { rows: st } = await pool.query('SELECT last_run FROM review_watch_state WHERE location_id=$1', [id]);
      const seedMode = !st.length;
      if (!seedMode && !force && (Date.now() - new Date(st[0].last_run).getTime()) < WATCH_EVERY_MS)
        return res.json({ ran: false, reason: 'watched recently' });

      const r = await fetchPlace(lr[0].google_place_id);
      const fetched = (r.reviews || []).filter(rv => rv && rv.time);
      let fresh = 0;
      for (const rv of fetched) {
        const author = rv.author_name || '';
        const { rows: seen } = await pool.query(
          'SELECT 1 FROM review_reply_drafts WHERE location_id=$1 AND review_time=$2 AND author=$3',
          [id, rv.time, author]);
        if (seen.length) continue;
        if (seedMode) {
          await pool.query(`INSERT INTO review_reply_drafts (location_id, review_time, author, rating, review_text, status)
            VALUES ($1,$2,$3,$4,$5,'seed') ON CONFLICT DO NOTHING`, [id, rv.time, author, rv.rating, rv.text || null]);
          continue;
        }
        // Genuinely new review: draft first (notification says it's ready), but
        // a drafting failure must never swallow the notification itself.
        let draft = null;
        if (ANTHROPIC_KEY) {
          try { draft = await draftReply(lr[0].name, { author, rating: rv.rating, text: rv.text }); }
          catch (e) { console.error('[reviews] auto-draft failed:', e.message); }
        }
        // The INSERT is the notification gate: with two overlapping watch runs
        // (scheduler + manual force), only the one whose insert lands fires the
        // push/Slack — ON CONFLICT collapses the loser to rowCount 0.
        const { rowCount } = await pool.query(`INSERT INTO review_reply_drafts (location_id, review_time, author, rating, review_text, draft, status)
          VALUES ($1,$2,$3,$4,$5,$6,'new') ON CONFLICT DO NOTHING`, [id, rv.time, author, rv.rating, rv.text || null, draft]);
        if (!rowCount) continue;
        fresh++;
        const stars = '★'.repeat(Math.max(1, Math.min(5, Math.round(rv.rating || 0))));
        notifyRoles(pool, {
          roles: ['owner', 'partner', 'manager'], locationId: id,
          title: `New ${stars} Google review — ${author || 'Customer'}`,
          body: `${String(rv.text || '(star rating only)').slice(0, 90)}${draft ? ' · reply draft ready' : ''}`,
          path: '/marketing', tag: `review-${rv.time}`,
        });
        if (SLACK_WEBHOOK) {
          postSlack(SLACK_WEBHOOK,
            `New ${stars} Google review for ${lr[0].name} — ${author || 'Customer'}: "${String(rv.text || '(star rating only)').slice(0, 140)}"${draft ? '\nReply draft ready on the dashboard → Marketing.' : ''}`)
            .catch(e => console.error('[reviews] slack:', e.message));
        }
      }
      await pool.query(`INSERT INTO review_watch_state (location_id, last_run) VALUES ($1, NOW())
        ON CONFLICT (location_id) DO UPDATE SET last_run=NOW()`, [id]);
      res.json({ ran: true, seeded: seedMode, checked: fetched.length, new: fresh });
    } catch (e) { fail(res, e); }
  });

  // Reply lifecycle: the human pasted it on Google (posted) or decided not to
  // reply (dismissed). Future GBP auto-post will stamp 'posted' itself.
  router.post('/:locationId/reply-status', ...gate, async (req, res) => {
    if (!assertLoc(req, res)) return;
    try {
      await ensure();
      const { review_time, author, status } = req.body || {};
      if (!review_time || !['posted', 'dismissed'].includes(status))
        return res.status(400).json({ error: 'review_time and status (posted|dismissed) required' });
      const { rowCount } = await pool.query(
        `UPDATE review_reply_drafts SET status=$4, updated_at=NOW()
         WHERE location_id=$1 AND review_time=$2 AND author=$3`,
        [req.params.locationId, review_time, author || '', status]);
      if (!rowCount) return res.status(404).json({ error: 'No draft found for that review' });
      res.json({ ok: true, status });
    } catch (e) { fail(res, e); }
  });

  // AI reply draft for one review, on demand (also the Redraft path for watched
  // reviews — pass review_time to persist over the stored draft). Draft-only by
  // design — the human reads it, tweaks it, and pastes it on Google.
  router.post('/:locationId/draft-reply', ...gate, async (req, res) => {
    if (!assertLoc(req, res)) return;
    try {
      await ensure();
      if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });
      const { author, rating, text, review_time } = req.body || {};
      if (rating == null) return res.status(400).json({ error: 'rating required' });
      const { rows } = await pool.query('SELECT name FROM locations WHERE id=$1', [req.params.locationId]);
      if (!rows.length) return res.status(404).json({ error: 'Location not found' });
      const draft = await draftReply(rows[0].name, { author, rating, text });
      if (review_time) {
        await pool.query(
          `UPDATE review_reply_drafts SET draft=$4, updated_at=NOW()
           WHERE location_id=$1 AND review_time=$2 AND author=$3 AND status <> 'posted'`,
          [req.params.locationId, review_time, author || '', draft]);
      }
      res.json({ draft });
    } catch (e) { fail(res, e); }
  });

  return router;
};
