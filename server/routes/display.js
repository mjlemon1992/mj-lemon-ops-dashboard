const express = require('express');
const crypto = require('crypto');
const { workingPaceFrac, efficiencyPct, workingDaysElapsed, workingDaysInMonth } = require('../lib/workdays');

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
    // Per-board switch: show the all-locations revenue standings, or keep the
    // board to this shop's own numbers only (owner toggles it under Locations).
    await pool.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS display_show_leaderboard BOOLEAN DEFAULT true');
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
      // Shop-tz calendar, not server UTC: revenue_mtd is computed in Mountain time,
      // so the target/pace must use the same month. On the last evening of a month
      // UTC is already next month, which blanked the target and spiked pace on the
      // bay TV for ~6h at every rollover.
      const _edm = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Edmonton', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now);
      const year = Number(_edm.find((p) => p.type === 'year').value);
      const month = Number(_edm.find((p) => p.type === 'month').value);
      // A noon-UTC anchor on the shop-tz calendar day keeps the pace fraction on
      // the correct month/day regardless of the server's timezone.
      const nowShop = new Date(`${year}-${String(month).padStart(2, '0')}-${String(Number(_edm.find((p) => p.type === 'day').value)).padStart(2, '0')}T12:00:00Z`);
      const province = loc.province || 'ab';
      const locWeekly = Number(loc.weekly_hours) || 40;

      // Latest metrics snapshot (revenue MTD + freshness).
      const mRes = await pool.query(
        'SELECT revenue_mtd, car_count_mtd, parts_margin, created_at FROM metrics_cache WHERE location_id = $1 ORDER BY created_at DESC LIMIT 1',
        [req.params.locationId]
      );
      const m = mRes.rows[0] || {};
      const revenue = num(m.revenue_mtd) || 0;

      // Monthly revenue + car-count targets.
      const tRes = await pool.query(
        'SELECT revenue, car_count FROM targets WHERE location_id = $1 AND year = $2 AND month = $3',
        [req.params.locationId, year, month]
      );
      const target = tRes.rows[0] && tRes.rows[0].revenue != null ? Number(tRes.rows[0].revenue) : null;
      const frac = workingPaceFrac(province, nowShop);
      const pacePct = (target && target > 0 && frac && frac > 0) ? Math.round((revenue / (target * frac)) * 100) : null;
      const gap = target != null ? Math.round((target - revenue) * 100) / 100 : null;
      const pctToTarget = (target && target > 0) ? Math.round((revenue / target) * 100) : null;

      // Car count — one of the four board-legal numbers, same treatment as revenue.
      const carsActual = num(m.car_count_mtd);
      const carTarget = tRes.rows[0] && tRes.rows[0].car_count != null ? Number(tRes.rows[0].car_count) : null;
      const cars = carsActual != null ? {
        actual: carsActual,
        target: carTarget,
        pct_to_target: (carTarget && carTarget > 0) ? Math.round((carsActual / carTarget) * 100) : null,
        pace_pct: (carTarget && carTarget > 0 && frac && frac > 0) ? Math.round((carsActual / (carTarget * frac)) * 100) : null,
      } : null;

      // "What does today need": working-day position + $/working-day still needed.
      // Pure revenue math — board-legal.
      const wdElapsed = workingDaysElapsed(province, nowShop);
      const wdTotal = workingDaysInMonth(province, nowShop);
      const wdLeft = Math.max(1, wdTotal - wdElapsed + 1);   // include today's remaining capacity
      const days = {
        working_elapsed: wdElapsed,
        working_total: wdTotal,
        per_day_needed: (gap != null && gap > 0) ? Math.round(gap / wdLeft) : null,
      };

      // Bonus gate — VISIBILITY ONLY. The gate is sales-vs-target, which is already
      // on this board; pool %, net profit, and dollar amounts never appear here.
      // Shown only where a bonus program actually exists (crew + this month's
      // sales target seeded).
      let bonusGate = null;
      try {
        const bg = await pool.query(
          `SELECT (SELECT COUNT(*) FROM bonus_person WHERE location_id=$1 AND active=true) AS crew,
                  (SELECT COUNT(*) FROM sales_target WHERE location_id=$1 AND month=$2) AS tgt,
                  (SELECT MAX(stretch_threshold) FROM formula_version WHERE location_id=$1) AS stretch`,
          [req.params.locationId, `${year}-${String(month).padStart(2, '0')}`]
        );
        const r = bg.rows[0];
        if (Number(r.crew) > 0 && Number(r.tgt) > 0 && pctToTarget != null) {
          bonusGate = { pct: pctToTarget, stretch_pct: r.stretch != null ? Math.round(Number(r.stretch) * 100) : null };
        }
      } catch (e) { bonusGate = null; }

      // Best full month this year — the record line on the revenue bar. Derived
      // from stored snapshots: the LAST snapshot of each shop-tz month bucket is
      // the month-end figure. Deliberately NOT MAX() — snapshots written during
      // the flaky-pagination era were sometimes inflated (June showed 206k at
      // peak vs the penny-exact 190,627.08 final), and the final snapshot is the
      // one written after fetch-until-complete settled. No ShopMonkey call.
      let record = null;
      try {
        const rc = await pool.query(
          `SELECT to_char(created_at AT TIME ZONE 'America/Edmonton', 'YYYY-MM') AS ym,
                  (ARRAY_AGG(revenue_mtd ORDER BY created_at DESC))[1] AS rev
             FROM metrics_cache
            WHERE location_id = $1 AND revenue_mtd IS NOT NULL
              AND to_char(created_at AT TIME ZONE 'America/Edmonton', 'YYYY') = $2
            GROUP BY 1`,
          [req.params.locationId, String(year)]
        );
        const curYm = `${year}-${String(month).padStart(2, '0')}`;
        const past = rc.rows.filter(r => r.ym !== curYm && Number(r.rev) > 0);
        if (past.length) {
          const best = past.reduce((a, b) => (Number(b.rev) > Number(a.rev) ? b : a));
          record = { month: best.ym, revenue: Math.round(Number(best.rev)) };
        }
      } catch (e) { record = null; }

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

      // Hours sold THIS WEEK per tech (Mon–today, shop-tz) from the per-RO detail
      // the sync persists. Keeps the leaderboard moving day-to-day mid-month.
      let weekByTech = {};
      try {
        const dow = (nowShop.getUTCDay() + 6) % 7;   // Mon=0 on the shop-tz anchor
        const weekStart = new Date(nowShop); weekStart.setUTCDate(weekStart.getUTCDate() - dow);
        const ws = weekStart.toISOString().slice(0, 10);
        const wk = await pool.query(
          `SELECT tech_id, SUM(hours_sold)::float AS h FROM tech_work_detail
            WHERE location_id = $1 AND invoiced_date >= $2 GROUP BY tech_id`,
          [req.params.locationId, ws]
        );
        for (const r of wk.rows) weekByTech[r.tech_id] = Math.round(Number(r.h) * 10) / 10;
      } catch (e) { weekByTech = {}; }

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
              hours_sold_week: weekByTech[r.tech_id] != null ? weekByTech[r.tech_id] : null,
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
          `SELECT id, kind, title, body, image_url, image_data, image_mime, priority, created_at
             FROM shop_notices
            WHERE active = true
              AND (location_id IS NULL OR location_id = $1)
              AND (publish_at IS NULL OR publish_at <= NOW())
              AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY priority ASC, created_at DESC
            LIMIT 20`,
          [req.params.locationId]
        );
        // Uploaded poster bytes ship inline as data URIs (the board is a plain
        // <img> behind a PIN — no authed image endpoint to point it at).
        notices = nRes.rows.map(r => ({
          id: r.id, kind: r.kind, title: r.title, body: r.body, priority: r.priority, created_at: r.created_at,
          image: r.image_url || (r.image_data ? `data:${r.image_mime || 'image/jpeg'};base64,${r.image_data.toString('base64')}` : null)
        }));
      } catch (e) { notices = []; }

      // All-locations revenue standings (revenue only — no targets/efficiency for
      // the others), ranked highest revenue-to-date first. Lets each shop's board
      // show where it sits against the rest of the group. Per-board opt-out:
      // display_show_leaderboard=false keeps this board to its own numbers only
      // (other locations' figures never leave the server).
      let leaderboard = [];
      if (loc.display_show_leaderboard !== false) try {
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

      // Live time-clock status per crew member — the board mirrors the kiosk:
      // clocked in (since when), on break (since when), or clocked out.
      // Tolerates the clock tables not existing yet.
      let clock = [];
      try {
        const cRes = await pool.query(
          `SELECT p.name, p.color, p.photo, p.photo_mime, e.clock_in, e.break_started_at
             FROM bonus_person p
             LEFT JOIN time_clock_entry e ON e.person_id = p.id AND e.clock_out IS NULL
            WHERE p.location_id = $1 AND p.active = true`, [req.params.locationId]);
        clock = cRes.rows.map(r => ({
          name: r.name, color: r.color || null,
          photo: r.photo ? `data:${r.photo_mime || 'image/jpeg'};base64,${r.photo.toString('base64')}` : null,
          status: r.clock_in ? (r.break_started_at ? 'break' : 'on') : 'off',
          clock_in: r.clock_in, break_started_at: r.break_started_at
        }));
      } catch (e) { clock = []; }

      res.set('Cache-Control', 'no-store');
      res.json({
        location: {
          id: loc.id, name: loc.name, city: loc.city, province, weekly_hours: locWeekly,
          night_start: Number.isInteger(Number(loc.night_start)) ? Number(loc.night_start) : 21,
          night_end: Number.isInteger(Number(loc.night_end)) ? Number(loc.night_end) : 6,
        },
        clock,
        revenue,
        target,
        gap,
        pace_pct: pacePct,
        pct_to_target: pctToTarget,
        cars,
        days,
        bonus_gate: bonusGate,
        record,
        // parts_margin deliberately NOT emitted — this board is PIN-only (no JWT),
        // and owner-level finance (margin/profit/pph/costs) must never reach the
        // shop floor, not even latent in the payload. Revenue-vs-target is board-legal.
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
