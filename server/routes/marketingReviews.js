const express = require('express');
const { authenticateToken, requireOwnerOrPartner } = require('../middleware/auth');

// Marketing: live Google review scorecard. Read-only — pulls rating, total count and a few
// recent reviews from the Google Places Details API, cached 12h per location. Replies are NOT
// supported here (handled in Shopmonkey CRM). The month-over-month delta needs history, so we
// snapshot {rating,total} once per calendar month and diff against it.
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;
const MODEL_FRESH_MS = 12 * 60 * 60 * 1000;

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
  const gate = [authenticateToken, requireOwnerOrPartner];

  router.get('/status', ...gate, (req, res) => res.json({ configured: !!GOOGLE_KEY }));

  // Cached 12h; ?force=1 refetches. 503 when the key or this location's place_id is missing,
  // which the client treats as "not configured" and hides the tile.
  router.get('/:locationId', ...gate, async (req, res) => {
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
      const reviews = (r.reviews || []).slice(0, 3).map(rv => ({
        author: rv.author_name, rating: rv.rating, text: rv.text,
        when: rv.relative_time_description, time: rv.time,
      }));
      const dlt = await monthDelta(id, total, rating);
      const payload = { rating, total, delta: dlt, reviews };
      await pool.query(`INSERT INTO marketing_reviews_cache (location_id, payload, created_at) VALUES ($1,$2,NOW())
        ON CONFLICT (location_id) DO UPDATE SET payload=EXCLUDED.payload, created_at=NOW()`, [id, JSON.stringify(payload)]);
      res.json({ ...payload, cached: false });
    } catch (e) { fail(res, e); }
  });

  return router;
};
