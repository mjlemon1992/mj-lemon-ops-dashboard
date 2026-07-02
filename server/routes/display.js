const express = require('express');
const crypto = require('crypto');
const { workingPaceFrac, efficiencyPct } = require('../lib/workdays');

// In-memory PIN brute-force throttle. The display route is public (no JWT), so
// without this a short numeric PIN is guessable. Per IP+location: after MAX_FAILS
// wrong PINs in WINDOW_MS, lock that key out for LOCK_MS. Resets on a correct PIN.
// Single-process / resets on redeploy — fine for this scale.
const WINDOW_MS = 10 * 60 * 1000, MAX_FAILS = 8, LOCK_MS = 15 * 60 * 1000;
const pinFails = new Map();
const rlKey = (req, loc) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.socket?.remoteAddress || 'unknown';
  return ip + '|' + loc;
};
const isLocked = (k) => {
  const e = pinFails.get(k);
  if (e && e.lockedUntil && e.lockedUntil > Date.now()) return true;
  return false;
};
const recordFail = (k) => {
  const now = Date.now();
  let e = pinFails.get(k);
  if (!e || now - e.first > WINDOW_MS) e = { first: now, count: 0, lockedUntil: 0 };
  e.count++;
  if (e.count >= MAX_FAILS) e.lockedUntil = now + LOCK_MS;
  pinFails.set(k, e);
  if (pinFails.size > 10000) { for (const [key, v] of pinFails) if (now - v.first > WINDOW_MS && (!v.lockedUntil || v.lockedUntil < now)) pinFails.delete(key); }
};
// Constant-time PIN compare (length-guarded; PIN length isn't sensitive and the
// throttle covers brute force).
const pinEqual = (a, b) => {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

// Public, PIN-gated shop-floor display data. NO JWT — meant to run unattended on
// a TV in the bay. Each location has a short display_pin; the board passes it as
// ?pin= and only that location's numbers come back. Read-only.
module.exports = (pool) => {
  const router = express.Router();

  let _init = false;
  const ensureColumns = async () => {
    if (_init) return;
    await pool.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS display_pin VARCHAR(12)');
    await pool.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS weekly_hours DECIMAL(6,2) DEFAULT 40');
    _init = true;
  };

  const num = (v) => (v == null ? null : Number(v));

  router.get('/:locationId', async (req, res) => {
    try {
      await ensureColumns();
      const locRes = await pool.query('SELECT * FROM locations WHERE id = $1', [req.params.locationId]);
      if (!locRes.rows.length) return res.status(404).json({ error: 'Location not found' });
      const loc = locRes.rows[0];

      const pin = (req.query.pin || '').toString();
      if (!loc.display_pin) return res.status(403).json({ error: 'Display not set up for this location yet. Set a display PIN under Locations.' });
      const rk = rlKey(req, req.params.locationId);
      if (isLocked(rk)) return res.status(429).json({ error: 'Too many incorrect PIN attempts. Try again later.' });
      if (!pinEqual(pin, loc.display_pin)) { recordFail(rk); return res.status(401).json({ error: 'Incorrect PIN' }); }
      pinFails.delete(rk);

      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1;
      const province = loc.province || 'ab';
      const locWeekly = Number(loc.weekly_hours) || 40;

      // Latest metrics snapshot (revenue MTD + freshness).
      const mRes = await pool.query(
        'SELECT revenue_mtd, parts_margin, created_at FROM metrics_cache WHERE location_id = $1 ORDER BY created_at DESC LIMIT 1',
        [req.params.locationId]
      );
      const m = mRes.rows[0] || {};
      const revenue = num(m.revenue_mtd) || 0;

      // Monthly revenue target.
      const tRes = await pool.query(
        'SELECT revenue FROM targets WHERE location_id = $1 AND year = $2 AND month = $3',
        [req.params.locationId, year, month]
      );
      const target = tRes.rows[0] && tRes.rows[0].revenue != null ? Number(tRes.rows[0].revenue) : null;
      const frac = workingPaceFrac(province, now);
      const pacePct = (target && target > 0 && frac && frac > 0) ? Math.round((revenue / (target * frac)) * 100) : null;
      const gap = target != null ? Math.round((target - revenue) * 100) / 100 : null;
      const pctToTarget = (target && target > 0) ? Math.round((revenue / target) * 100) : null;

      // Latest MTD tech snapshot.
      try { await pool.query("ALTER TABLE tech_efficiency ADD COLUMN IF NOT EXISTS period_type VARCHAR(8)"); } catch (e) {}
      const snapRes = await pool.query(
        "SELECT MAX(snapshot_date) AS d FROM tech_efficiency WHERE location_id = $1 AND period_type = 'mtd' AND snapshot_date <= CURRENT_DATE",
        [req.params.locationId]
      );
      const snapDate = snapRes.rows[0] && snapRes.rows[0].d ? snapRes.rows[0].d : null;

      // Per-tech weekly-hour overrides + hidden list.
      let whByTech = {};
      try {
        const whRes = await pool.query('SELECT tech_id, hours_per_week FROM tech_weekly_hours WHERE location_id = $1', [req.params.locationId]);
        for (const r of whRes.rows) whByTech[r.tech_id] = r.hours_per_week;
      } catch (e) {}
      let hidden = new Set();
      try {
        const hr = await pool.query('SELECT tech_id FROM hidden_techs WHERE location_id = $1', [req.params.locationId]);
        for (const r of hr.rows) hidden.add(r.tech_id);
      } catch (e) {}

      let techs = [];
      if (snapDate) {
        const teRes = await pool.query(
          "SELECT tech_id, tech_name, hours_sold, hours_billed FROM tech_efficiency WHERE location_id = $1 AND snapshot_date = $2 AND period_type = 'mtd'",
          [req.params.locationId, snapDate]
        );
        techs = teRes.rows
          .filter(r => !hidden.has(r.tech_id))
          .map(r => {
            const hpw = whByTech[r.tech_id] != null ? Number(whByTech[r.tech_id]) : locWeekly;
            const sold = num(r.hours_sold);
            return {
              tech_id: r.tech_id,
              tech_name: r.tech_name,
              hours_sold: sold,
              hours_billed: num(r.hours_billed),
              hours_per_week: hpw,
              efficiency: efficiencyPct(sold, province, hpw, now)
            };
          })
          .sort((a, b) => (b.efficiency || 0) - (a.efficiency || 0));
      }

      const totalSold = techs.reduce((s, t) => s + (t.hours_sold || 0), 0);
      const totalBilled = techs.reduce((s, t) => s + (t.hours_billed || 0), 0);

      // YTD tech snapshot — same shape as the mtd list so the board can cycle
      // between the two periods. Uses the stored efficiency (uniform working
      // days x 8, written by the YTD recompute) rather than re-deriving here.
      let techsYtd = [];
      try {
        const ySnapRes = await pool.query(
          "SELECT MAX(snapshot_date) AS d FROM tech_efficiency WHERE location_id = $1 AND period_type = 'ytd' AND snapshot_date <= CURRENT_DATE",
          [req.params.locationId]
        );
        const ySnap = ySnapRes.rows[0] && ySnapRes.rows[0].d ? ySnapRes.rows[0].d : null;
        if (ySnap) {
          const yRes = await pool.query(
            "SELECT tech_id, tech_name, hours_sold, hours_billed, efficiency FROM tech_efficiency WHERE location_id = $1 AND snapshot_date = $2 AND period_type = 'ytd'",
            [req.params.locationId, ySnap]
          );
          techsYtd = yRes.rows
            .filter(r => !hidden.has(r.tech_id))
            .map(r => ({
              tech_id: r.tech_id,
              tech_name: r.tech_name,
              hours_sold: num(r.hours_sold),
              hours_billed: num(r.hours_billed),
              efficiency: num(r.efficiency)
            }))
            .sort((a, b) => (b.efficiency || 0) - (a.efficiency || 0));
        }
      } catch (e) { techsYtd = []; }

      // Active shop notices for this board (all-location notices included).
      // Table is created by routes/notices.js on first write; tolerate absence.
      let notices = [];
      try {
        const nRes = await pool.query(
          `SELECT id, kind, title, body, image_url, priority, created_at
             FROM shop_notices
            WHERE active = true
              AND (location_id IS NULL OR location_id = $1)
              AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY priority ASC, created_at DESC
            LIMIT 20`,
          [req.params.locationId]
        );
        notices = nRes.rows;
      } catch (e) { notices = []; }

      // All-locations revenue standings (revenue only — no targets/efficiency for
      // the others), ranked highest revenue-to-date first. Lets each shop's board
      // show where it sits against the rest of the group.
      let leaderboard = [];
      try {
        const lbRes = await pool.query(
          `SELECT l.id, l.name, mc.revenue_mtd
             FROM locations l
             LEFT JOIN LATERAL (
               SELECT revenue_mtd FROM metrics_cache
               WHERE location_id = l.id ORDER BY created_at DESC LIMIT 1
             ) mc ON true
            WHERE l.active = true`
        );
        leaderboard = lbRes.rows
          .map(r => ({ id: r.id, name: r.name, revenue: num(r.revenue_mtd) || 0, is_current: r.id === loc.id }))
          .sort((a, b) => b.revenue - a.revenue)
          .map((r, i) => ({ ...r, rank: i + 1 }));
      } catch (e) { leaderboard = []; }

      // Google reviews scorecard — read the cache the marketing tile populates
      // (rating, total, and reviews-this-month). DB-only; no Google call here.
      let reviews = null;
      try {
        const rv = await pool.query('SELECT payload FROM marketing_reviews_cache WHERE location_id = $1', [req.params.locationId]);
        if (rv.rows.length) {
          const p = typeof rv.rows[0].payload === 'string' ? JSON.parse(rv.rows[0].payload) : rv.rows[0].payload;
          reviews = { rating: p.rating ?? null, total: p.total ?? null, delta: p.delta ?? 0 };
        }
      } catch (e) { reviews = null; }

      res.set('Cache-Control', 'no-store');
      res.json({
        location: { id: loc.id, name: loc.name, city: loc.city, province, weekly_hours: locWeekly },
        revenue,
        target,
        gap,
        pace_pct: pacePct,
        pct_to_target: pctToTarget,
        parts_margin: num(m.parts_margin),
        techs,
        techs_ytd: techsYtd,
        notices,
        leaderboard,
        reviews,
        totals: {
          hours_sold: Math.round(totalSold * 10) / 10,
          hours_billed: Math.round(totalBilled * 10) / 10
        },
        efficiency_target: Number(loc.efficiency_target) || 80,
        metrics_updated_at: m.created_at || null,
        tech_snapshot_date: snapDate,
        server_time: now.toISOString()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
