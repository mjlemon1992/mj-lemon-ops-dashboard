const express = require('express');
const { authenticateToken, requireRole, canAccessLocation } = require('../middleware/auth');
const { actualRevenueByMonth, actualsByMonth } = require('../lib/shopmonkey');

module.exports = (pool) => {
  const router = express.Router();

  // Owner/partner set targets anywhere; a manager only for their own location.
  const assertLoc = (req, res) => {
    if (canAccessLocation(req.user, req.params.locationId)) return true;
    res.status(403).json({ error: 'Access denied for this location' });
    return false;
  };

  // Keep the bonus module's sales_target (the payout GATE) in lockstep with the
  // revenue targets edited here — otherwise recalculate-to-yearly bumps a month
  // in `targets` while the bonus gate still reads the stale `sales_target`, and
  // the dashboard says "missed" while the crew gets paid. Skips months with an
  // approved unsuperseded run (locked inputs). Best-effort: never fail a save.
  const syncSalesTarget = async (locationId, year) => {
    try {
      await pool.query(
        `INSERT INTO sales_target (location_id, month, target)
         SELECT t.location_id, $2::text || '-' || LPAD(t.month::text, 2, '0'), t.revenue
           FROM targets t
          WHERE t.location_id = $1 AND t.year = $2 AND t.revenue > 0
            AND NOT EXISTS (SELECT 1 FROM bonus_run r
                              WHERE r.location_id = t.location_id
                                AND r.month = $2::text || '-' || LPAD(t.month::text, 2, '0')
                                AND r.status = 'approved' AND r.superseded_by IS NULL)
         ON CONFLICT (location_id, month) DO UPDATE SET target = EXCLUDED.target`,
        [locationId, Number(year)]);
    } catch (e) { /* bonus schema may be absent; a target save must never fail on the mirror */ }
  };

  router.get('/:locationId/:year', authenticateToken, async (req, res) => {
    try {
      if (['manager', 'advisor'].includes(req.user.role) && req.user.location_id !== req.params.locationId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const result = await pool.query(
        'SELECT * FROM targets WHERE location_id = $1 AND year = $2 ORDER BY month',
        [req.params.locationId, req.params.year]
      );
      // Advisors get the shop-floor targets only (revenue pace, car count,
      // hours, efficiency) — margin/ARO/pph targets are stripped server-side.
      if (req.user.role === 'advisor') {
        return res.json(result.rows.map((r) => ({
          location_id: r.location_id, year: r.year, month: r.month,
          revenue: r.revenue, car_count: r.car_count,
          labour_hours: r.labour_hours, efficiency: r.efficiency,
        })));
      }
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:locationId/:year/:month', authenticateToken, requireRole('owner', 'partner', 'manager'), async (req, res) => {
    const { revenue, car_count, parts_margin, labour_margin, labour_hours, efficiency, avg_ro_value, pph } = req.body;
    if (!assertLoc(req, res)) return;
    try {
      const result = await pool.query(
        `INSERT INTO targets (location_id, year, month, revenue, car_count, parts_margin, labour_margin, labour_hours, efficiency, avg_ro_value, pph)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (location_id, year, month) DO UPDATE SET
           revenue=$4, car_count=$5, parts_margin=$6, labour_margin=$7, labour_hours=$8, efficiency=$9, avg_ro_value=$10, pph=$11, updated_at=NOW()
         RETURNING *`,
        [req.params.locationId, req.params.year, req.params.month, revenue, car_count, parts_margin || 55, labour_margin || 70, labour_hours, efficiency || 80, avg_ro_value, pph]
      );
      await syncSalesTarget(req.params.locationId, req.params.year);
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:locationId/:year/bulk', authenticateToken, requireRole('owner', 'partner', 'manager'), async (req, res) => {
    const { targets } = req.body;
    if (!Array.isArray(targets)) return res.status(400).json({ error: 'targets must be an array' });
    if (!assertLoc(req, res)) return;
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const t of targets) {
          await client.query(
            `INSERT INTO targets (location_id, year, month, revenue, car_count, parts_margin, labour_margin, labour_hours, efficiency, avg_ro_value, pph)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (location_id, year, month) DO UPDATE SET
               revenue=$4, car_count=$5, parts_margin=$6, labour_margin=$7, labour_hours=$8, efficiency=$9, avg_ro_value=$10, pph=$11, updated_at=NOW()`,
            [req.params.locationId, req.params.year, t.month, t.revenue, t.car_count, t.parts_margin || 55, t.labour_margin || 70, t.labour_hours, t.efficiency || 80, t.avg_ro_value, t.pph]
          );
        }
        await client.query('COMMIT');
        await syncSalesTarget(req.params.locationId, req.params.year);
        res.json({ message: 'Targets saved', count: targets.length });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // RECALCULATE-TO-YEARLY. When completed months come in under target, the
  // remaining months must make up the shortfall for the year to still land on
  // its original annual revenue target. Read-only preview: pulls actual revenue
  // for completed months (one ShopMonkey sweep, same sales definition as MTD),
  // spreads the shortfall EVENLY across the remaining months, and returns the
  // proposed per-month bumps. The client applies via the bulk save.
  router.post('/:locationId/:year/recalculate', authenticateToken, requireRole('owner', 'partner', 'manager'), async (req, res) => {
    if (!assertLoc(req, res)) return;
    const year = Number(req.params.year);
    try {
      const nowParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Edmonton', year: 'numeric', month: 'numeric' }).formatToParts(new Date());
      const curYear = Number(nowParts.find((p) => p.type === 'year').value);
      const curMonth = Number(nowParts.find((p) => p.type === 'month').value);

      const { rows } = await pool.query('SELECT month, revenue FROM targets WHERE location_id=$1 AND year=$2', [req.params.locationId, year]);
      const targetRev = {};
      for (const r of rows) targetRev[Number(r.month)] = Number(r.revenue) || 0;
      const yearlyTarget = Object.values(targetRev).reduce((a, b) => a + b, 0);
      if (yearlyTarget <= 0) return res.json({ status: 'no_targets', message: 'Set your monthly revenue targets first, then recalculate.' });

      let completedMonths = [];
      let remainingMonths = [];
      if (year < curYear) { completedMonths = Array.from({ length: 12 }, (_, i) => i + 1); }
      else if (year === curYear) {
        for (let m = 1; m < curMonth; m++) completedMonths.push(m);
        for (let m = curMonth; m <= 12; m++) remainingMonths.push(m);
      }
      if (!remainingMonths.length) return res.json({ status: 'no_remaining', message: year < curYear ? `${year} is already complete — no remaining months to redistribute into.` : `Nothing to redistribute yet for ${year}.`, yearly_target: Math.round(yearlyTarget) });
      if (!completedMonths.length) return res.json({ status: 'no_completed', message: `No completed months yet in ${year} — nothing to catch up on.`, yearly_target: Math.round(yearlyTarget) });

      const { rows: lr } = await pool.query('SELECT shopmonkey_location_id FROM locations WHERE id=$1', [req.params.locationId]);
      const smLoc = lr[0] && lr[0].shopmonkey_location_id;
      if (!smLoc) return res.status(400).json({ error: 'This location is not connected to Shopmonkey, so there are no actuals to compare against.' });
      const apiKey = process.env.SHOPMONKEY_API_KEY;
      if (!apiKey) return res.status(400).json({ error: 'SHOPMONKEY_API_KEY not configured' });

      const lastCompleted = completedMonths[completedMonths.length - 1];
      const endYm = lastCompleted === 12 ? `${year + 1}-01` : `${year}-${String(lastCompleted + 1).padStart(2, '0')}`;
      // ShopMonkey's order list is flaky (a sweep can land a couple of orders
      // short when the metrics scheduler is hammering it). Retry a few times
      // before giving up rather than failing the whole button on a transient miss.
      // A full sweep is ~15-20s; keep the retry budget small so a throttled run
      // can't blow Railway's ~60s edge timeout (which surfaces as a confusing
      // "Application failed to respond"). One retry clears the common transient.
      let actuals = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { actuals = await actualRevenueByMonth(apiKey, smLoc, `${year}-01`, endYm); break; }
        catch (e) { lastErr = e; if (attempt < 1) await new Promise((r) => setTimeout(r, 3000)); }
      }
      if (!actuals) return res.status(503).json({ error: `Couldn't pull complete actuals from Shopmonkey (${(lastErr && lastErr.message) || 'throttled'}) — give it a minute and try again.` });
      const actualFor = (m) => actuals[`${year}-${String(m).padStart(2, '0')}`] || 0;

      const completed = completedMonths.map((m) => ({
        month: m, target: Math.round(targetRev[m] || 0), actual: Math.round(actualFor(m)),
        delta: Math.round(actualFor(m) - (targetRev[m] || 0)),
      }));
      // A $0 actual in a completed month is almost always a data gap (Shopmonkey
      // history doesn't reach back that far) rather than a real zero, and counting
      // it as a full miss would wildly over-inflate the catch-up. Skip those from
      // the shortfall and report them so the owner can account for them by hand.
      const scored = completed.filter((c) => c.actual > 0);
      const skipped = completed.filter((c) => c.actual <= 0).map((c) => c.month);
      const shortfall = Math.round(scored.reduce((a, c) => a + (c.target - c.actual), 0));  // + = behind

      if (!scored.length) {
        return res.json({ status: 'no_actuals', skipped, completed, yearly_target: Math.round(yearlyTarget), message: 'No completed month has Shopmonkey revenue yet, so there’s nothing to measure a shortfall against.' });
      }
      if (shortfall <= 0) {
        return res.json({
          status: 'ahead', yearly_target: Math.round(yearlyTarget), shortfall, skipped,
          completed, remaining_count: remainingMonths.length,
          message: shortfall === 0 ? 'Completed months are exactly on target — no catch-up needed.' : `Ahead of pace by $${Math.abs(shortfall).toLocaleString('en-CA')} — targets left as-is.`,
        });
      }
      const perMonthBump = shortfall / remainingMonths.length;
      // Distribute whole dollars so the bumps sum EXACTLY to the shortfall (the
      // first `remainder` months carry one extra dollar) — independent rounding
      // drifted the annual total by up to `remaining_count` dollars.
      const base = Math.floor(shortfall / remainingMonths.length);
      let remainder = shortfall - base * remainingMonths.length;
      const proposed = remainingMonths.map((m) => {
        const bump = base + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder -= 1;
        return { month: m, old_revenue: Math.round(targetRev[m] || 0), new_revenue: Math.max(0, Math.round(targetRev[m] || 0) + bump) };
      });
      res.json({ status: 'behind', yearly_target: Math.round(yearlyTarget), shortfall, per_month_bump: Math.round(perMonthBump), completed, proposed, skipped, remaining_count: remainingMonths.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Goals board + curve builder ────────────────────────────────────────────
  // One sweep serves both: monthly actuals (revenue + cars) for the requested
  // year AND the year before. Cached in-memory for 6h per location/year — the
  // sweep is the expensive part, and the board is a glance page.
  const goalsCache = new Map();   // key -> { data, ts }
  const GOALS_TTL_MS = 6 * 60 * 60 * 1000;
  const pullActualsSpan = async (locationId, year, refresh) => {
    const key = `${locationId}:${year}`;
    const hit = goalsCache.get(key);
    if (!refresh && hit && Date.now() - hit.ts < GOALS_TTL_MS) return hit.data;
    const { rows: lr } = await pool.query('SELECT shopmonkey_location_id FROM locations WHERE id=$1', [locationId]);
    const smLoc = lr[0] && lr[0].shopmonkey_location_id;
    if (!smLoc) return null;
    const apiKey = process.env.SHOPMONKEY_API_KEY;
    if (!apiKey) return null;
    // Span: Jan 1 of last year through Jan 1 of year+1 (the sweep filter is
    // gte-only anyway; the helper buckets and bounds by month key).
    let data = null; let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { data = await actualsByMonth(apiKey, smLoc, `${year - 1}-01`, `${year + 1}-01`); break; }
      catch (e) { lastErr = e; if (attempt < 1) await new Promise((r) => setTimeout(r, 3000)); }
    }
    if (!data) throw new Error(`Shopmonkey sweep failed (${(lastErr && lastErr.message) || 'throttled'})`);
    goalsCache.set(key, { data, ts: Date.now() });
    return data;
  };

  // QuickBooks fallback for months ShopMonkey history doesn't reach (this shop
  // moved onto ShopMonkey in early 2026 — 2025 lives only in the books).
  // Monthly income via the parkland-qbo connector, cached 24h. Revenue only:
  // QBO has no car counts, so those cells stay blank.
  const qboCache = new Map();
  const qboMonthlyIncome = async (locationId, year) => {
    const key = `qbo:${locationId}:${year}`;
    const hit = qboCache.get(key);
    if (hit && Date.now() - hit.ts < 24 * 60 * 60 * 1000) return hit.data;
    const BASE = process.env.QBO_CONNECTOR_URL, TOKEN = process.env.QBO_API_TOKEN;
    if (!BASE || !TOKEN) return null;
    const { rows } = await pool.query('SELECT qbo_slug FROM locations WHERE id=$1', [locationId]);
    let slug = rows[0] && rows[0].qbo_slug;
    if (!slug && process.env.QBO_DEFAULT_SLUG && process.env.QBO_DEFAULT_SLUG_LOCATION_ID === locationId) slug = process.env.QBO_DEFAULT_SLUG;
    if (!slug) return null;
    const out = {};
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      const endDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
      try {
        const r = await fetch(`${BASE}/qbo/${slug}/pnl?start=${year}-${mm}-01&end=${year}-${mm}-${String(endDay).padStart(2, '0')}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (!r.ok) continue;
        const j = await r.json();
        const inc = j && j.headline && Number(j.headline.income);
        if (Number.isFinite(inc) && inc > 0) out[m] = Math.round(inc);
      } catch (e) { /* month stays blank */ }
    }
    qboCache.set(key, { data: out, ts: Date.now() });
    return out;
  };

  // Grid data for the "Going for the Goals" board: per month — actual, goal,
  // last year (sales / cars / avg WO). Advisors never see this route (role gate).
  router.get('/:locationId/:year/goals', authenticateToken, requireRole('owner', 'partner', 'manager'), async (req, res) => {
    if (!assertLoc(req, res)) return;
    const year = Number(req.params.year);
    try {
      const actuals = await pullActualsSpan(req.params.locationId, year, req.query.refresh === '1');
      if (!actuals) return res.status(400).json({ error: 'This location is not connected to Shopmonkey yet, so there are no actuals to chart.' });
      const { rows } = await pool.query('SELECT month, revenue, car_count, avg_ro_value FROM targets WHERE location_id=$1 AND year=$2', [req.params.locationId, year]);
      const goalBy = Object.fromEntries(rows.map((r) => [Number(r.month), r]));
      const cell = (src) => src ? { revenue: src.revenue, cars: src.cars, awo: src.cars > 0 ? Math.round(src.revenue / src.cars) : null } : null;
      const months = [];
      for (let m = 1; m <= 12; m++) {
        const k = (y) => `${y}-${String(m).padStart(2, '0')}`;
        const g = goalBy[m];
        months.push({
          month: m,
          actual: cell(actuals[k(year)]),
          last_year: cell(actuals[k(year - 1)]),
          goal: g ? { revenue: Number(g.revenue) || 0, cars: Number(g.car_count) || 0, awo: Number(g.avg_ro_value) || null } : null,
        });
      }
      // Last-year months ShopMonkey can't see get books income from QuickBooks
      // (revenue only — no car counts in the books).
      let qboUsed = false;
      if (months.some((m) => !m.last_year)) {
        try {
          const qbo = await qboMonthlyIncome(req.params.locationId, year - 1);
          if (qbo) for (const m of months) {
            if (!m.last_year && qbo[m.month]) { m.last_year = { revenue: qbo[m.month], cars: null, awo: null, source: 'qbo' }; qboUsed = true; }
          }
        } catch (e) { /* books fallback is best-effort */ }
      }
      const sum = (list, f) => list.reduce((a, x) => a + (f(x) || 0), 0);
      res.json({
        year, months, qbo_used: qboUsed,
        totals: {
          actual: { revenue: Math.round(sum(months, (x) => x.actual && x.actual.revenue)), cars: sum(months, (x) => x.actual && x.actual.cars) },
          goal: { revenue: Math.round(sum(months, (x) => x.goal && x.goal.revenue)), cars: sum(months, (x) => x.goal && x.goal.cars) },
          last_year: { revenue: Math.round(sum(months, (x) => x.last_year && x.last_year.revenue)), cars: sum(months, (x) => x.last_year && x.last_year.cars) },
        },
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Build a year's monthly targets from a single annual number, shaped by LAST
  // YEAR's actual seasonality (Shopmonkey revenue — the same yardstick the
  // targets are graded against). Whole-dollar allocation sums EXACTLY to the
  // annual figure. Returns a preview; the client applies via the bulk save so
  // the existing save path (and its sales_target/bonus-gate mirror) stays the
  // single writer.
  router.post('/:locationId/:year/build-from-curve', authenticateToken, requireRole('owner', 'partner', 'manager'), async (req, res) => {
    if (!assertLoc(req, res)) return;
    const year = Number(req.params.year);
    const total = Math.round(Number((req.body || {}).total_revenue));
    if (!Number.isFinite(total) || total <= 0) return res.status(400).json({ error: 'Give me the annual revenue target as a positive number.' });
    try {
      const actuals = await pullActualsSpan(req.params.locationId, year, false);
      if (!actuals) return res.status(400).json({ error: 'This location is not connected to Shopmonkey yet — no history to shape the curve from.' });
      const ly = [];
      for (let m = 1; m <= 12; m++) ly.push(actuals[`${year - 1}-${String(m).padStart(2, '0')}`] || null);
      let withData = ly.filter((x) => x && x.revenue > 0).length;
      let basisSource = 'shopmonkey';
      if (withData < 6) {
        // ShopMonkey can't see that far back — shape the curve from the books
        // instead (QuickBooks monthly income; no car counts, so those pass
        // through untouched on apply).
        const qbo = await qboMonthlyIncome(req.params.locationId, year - 1);
        const qboMonths = qbo ? Object.keys(qbo).length : 0;
        if (qboMonths >= 6) {
          for (let m = 1; m <= 12; m++) ly[m - 1] = qbo[m] ? { revenue: qbo[m], cars: 0 } : null;
          withData = qboMonths;
          basisSource = 'quickbooks';
        } else {
          return res.status(400).json({ error: `Only ${withData} month(s) of ${year - 1} in ShopMonkey and ${qboMonths} in QuickBooks — not enough history to shape a seasonal curve. Use even amounts instead.` });
        }
      }
      // Months with no history get the average weight of the months that have
      // it, so a data gap doesn't zero out a target month.
      const lyTotal = ly.reduce((a, x) => a + (x ? x.revenue : 0), 0);
      const avgRev = lyTotal / withData;
      const weights = ly.map((x) => (x && x.revenue > 0 ? x.revenue : avgRev));
      const wTotal = weights.reduce((a, b) => a + b, 0);
      // Whole-dollar allocation, drift corrected on the largest month.
      const raw = weights.map((w) => (total * w) / wTotal);
      const alloc = raw.map((r) => Math.floor(r));
      let left = total - alloc.reduce((a, b) => a + b, 0);
      const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
      for (const [, i] of order) { if (left <= 0) break; alloc[i] += 1; left -= 1; }
      const lyCars = ly.reduce((a, x) => a + (x ? x.cars : 0), 0);
      const growth = lyTotal > 0 ? total / lyTotal : 1;
      const proposed = alloc.map((rev, i) => {
        // Books-based curve has no car counts — leave car/ARO targets untouched
        // on apply (null = keep whatever is already set for that month).
        if (basisSource === 'quickbooks') {
          return { month: i + 1, revenue: rev, car_count: null, avg_ro_value: null, last_year_revenue: ly[i] ? Math.round(ly[i].revenue) : null, weight_pct: Math.round((weights[i] / wTotal) * 1000) / 10 };
        }
        const carsLy = ly[i] ? ly[i].cars : (lyCars && withData ? Math.round(lyCars / withData) : 0);
        const cars = Math.max(0, Math.round(carsLy * growth));
        return {
          month: i + 1, revenue: rev, car_count: cars,
          avg_ro_value: cars > 0 ? Math.round(rev / cars) : null,
          last_year_revenue: ly[i] ? Math.round(ly[i].revenue) : null,
          weight_pct: Math.round((weights[i] / wTotal) * 1000) / 10,
        };
      });
      res.json({ year, total, basis_year: year - 1, basis_source: basisSource, basis_total: Math.round(lyTotal), months_with_history: withData, growth_pct: Math.round((growth - 1) * 1000) / 10, proposed });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
