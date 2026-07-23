const express = require('express');
const { authenticateToken, requireRole, canAccessLocation } = require('../middleware/auth');

// Marketing: live Google review scorecard + AI reply drafting. Pulls rating, total count and a
// few recent reviews from the Google Places Details API, cached 12h per location. Replies:
// Claude DRAFTS them (same in-house replacement direction as review-request texts — the
// Shopmonkey CRM's Review Manager auto-posts AI replies; ours keeps a human in the loop) and
// the owner pastes on Google. Direct posting would need the Google Business Profile API
// (OAuth + Google approval) — a later step if copy/paste gets old. The month-over-month delta
// needs history, so we snapshot {rating,total} once per calendar month and diff against it.
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;
const MODEL_FRESH_MS = 12 * 60 * 60 * 1000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

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

  // Snapshot {total,rating} once per calendar month; delta = current total - this month's snapshot.
  const monthDelta = async (locId, total, rating) => {
    const now = new Date(), year = now.getUTCFullYear(), month = now.getUTCMonth() + 1;
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
  // which the client treats as "not configured" and hides the tile.
  router.get('/:locationId', ...gate, async (req, res) => {
    if (!assertLoc(req, res)) return;
    try {
      await ensure();
      const id = req.params.locationId, force = req.query.force === '1';
      if (!force) {
        const { rows } = await pool.query('SELECT payload, created_at FROM marketing_reviews_cache WHERE location_id=$1', [id]);
        if (rows.length && (Date.now() - new Date(rows[0].created_at).getTime()) < MODEL_FRESH_MS) {
          const p = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
          return res.json({ ...p, cached: true });
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
      res.json({ ...payload, cached: false });
    } catch (e) { fail(res, e); }
  });

  // AI reply draft for one review. Draft-only by design — the human reads it,
  // tweaks it, and pastes it on Google. Nothing is ever posted from here.
  router.post('/:locationId/draft-reply', ...gate, async (req, res) => {
    if (!assertLoc(req, res)) return;
    try {
      if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });
      const { author, rating, text } = req.body || {};
      if (rating == null) return res.status(400).json({ error: 'rating required' });
      const { rows } = await pool.query('SELECT name FROM locations WHERE id=$1', [req.params.locationId]);
      if (!rows.length) return res.status(404).json({ error: 'Location not found' });
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL, max_tokens: 300, system: REPLY_SYSTEM,
          messages: [{ role: 'user', content:
            `Shop: ${rows[0].name}\nReviewer: ${author || '(no name)'}\nRating: ${rating} star(s)\nReview: ${String(text || '(star rating only, no text)').slice(0, 1500)}` }],
        }),
      });
      const body = await r.json();
      if (!r.ok) throw Object.assign(new Error(`Anthropic ${r.status}: ${JSON.stringify(body).slice(0, 200)}`), { status: 502 });
      const draft = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      if (!draft) throw new Error('Empty draft');
      res.json({ draft });
    } catch (e) { fail(res, e); }
  });

  return router;
};
