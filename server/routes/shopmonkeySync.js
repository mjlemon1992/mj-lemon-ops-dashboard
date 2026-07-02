const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { workingDaysElapsed } = require('../lib/workdays');

function parseShopmonkeyDate(str) {
  if (!str || str === 'empty') return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function centsToDollars(c) {
  return (typeof c === 'number' ? c : 0) / 100;
}

// Pre-tax subtotal in cents: the five revenue components. Line discounts are
// already baked into these (a comped road test reports laborCents:0), so we do
// NOT subtract discountCents again, and fees/EPA sit outside the subtotal.
// Validated penny-exact to the Shopmonkey monthly report ($81,500.78 pre-tax).
function orderSubtotalCents(o) {
  return (o.partsCents || 0) + (o.laborCents || 0) + (o.shopSuppliesCents || 0)
    + (o.subcontractsCents || 0) + (o.tiresCents || 0);
}

function isComeback(o) {
  return orderSubtotalCents(o) === 0;
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shopmonkey's /v3/order query is FLAKY: a single sweep returns a varying PARTIAL
// subset (probing frozen data returned 100-107 of 107), caps pages at 100, and its
// skip-pagination overlaps/gaps as orders are edited. The UNION of repeated sweeps
// converges to meta.total, so we sweep + union by id until we've collected the whole
// set, then complete-or-throw. Returns { orders, total }. Throws on incomplete
// (partial) or empty+no-meta (throttle) so callers never cache wrong/partial data.
async function sweepOrders(apiKey, { where, locationId, maxSweeps = 5 }) {
  const whereStr = JSON.stringify(where);
  const sort = JSON.stringify([{ name: 'createdDate', order: 'asc' }]);
  const byId = new Map();
  let total = null;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    for (let skip = 0; skip < 5000; skip += 100) {
      const params = { where: whereStr, limit: '100', skip: String(skip), sort };
      if (locationId) params.locationId = locationId;
      const res = await fetch(`https://api.shopmonkey.cloud/v3/order?${new URLSearchParams(params)}`, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
      });
      if (!res.ok) { const txt = await res.text(); throw new Error(`Shopmonkey API error ${res.status}: ${txt.slice(0, 200)}`); }
      const b = await res.json();
      const meta = b.meta || (b.data && b.data.meta) || null;   // meta may sit top-level OR nested
      if (meta && typeof meta.total === 'number') total = meta.total;
      const batch = Array.isArray(b.data) ? b.data : (b.data && b.data.data) || [];
      for (const o of batch) if (o && o.id) byId.set(o.id, o);
      if (batch.length < 100) break;
      await _sleep(120);
    }
    if (total !== null && byId.size >= total) break;
    await _sleep(200);
  }
  if (total === null && byId.size === 0) {
    throw new Error('Shopmonkey returned no orders and no meta (throttled/failed) — refusing to report empty');
  }
  if (total !== null && byId.size < total) {
    throw new Error(`Shopmonkey incomplete: ${byId.size}/${total} orders after ${maxSweeps} sweeps (throttled?) — not reporting partial data`);
  }
  return { orders: [...byId.values()], total };
}

// ---- Committed WIP helpers -------------------------------------------------
// Workflow-status name map, cached 10 min PER LOCATION (a global cache handed one
// location another's stage names).
const _wfCache = {};
async function fetchWorkflowStatusMap(apiKey, locationId) {
  const c = _wfCache[locationId];
  if (c && Date.now() - c.at < 10 * 60 * 1000 && Object.keys(c.map).length) return c.map;
  const params = new URLSearchParams({ locationId, limit: '50' });
  const res = await fetch(`https://api.shopmonkey.cloud/v3/workflow_status?${params}`, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
  if (!res.ok) return (c && c.map) || {};
  const data = await res.json();
  const rows = (data && data.data && data.data.data) ? data.data.data : (data.data || []);
  const map = {};
  rows.forEach((w) => { map[w.id] = w.name; });
  _wfCache[locationId] = { at: Date.now(), map };
  return map;
}
async function fetchCommittedOrders(apiKey, locationId) {
  const { orders } = await sweepOrders(apiKey, { where: { authorized: true, invoicedDate: null, archived: false }, locationId });
  const seen = new Map();
  for (const o of orders) { if (o.deleted) continue; const key = o.number || o.id; if (!seen.has(key)) seen.set(key, o); }
  return [...seen.values()];
}
// Takes the DASHBOARD location id and resolves the Shopmonkey location id itself
// (callers previously passed the DB id straight to Shopmonkey → wrong/empty WIP).
async function buildCommittedWip(pool, apiKey, dbLocationId) {
  const AGING_DAYS = 14;
  const empty = { total_count: 0, total_value: 0, active_count: 0, active_value: 0, aging_count: 0, aging_value: 0, aging_days: AGING_DAYS, by_stage: [], active: [], aging: [] };
  const { rows: lr } = await pool.query('SELECT shopmonkey_location_id FROM locations WHERE id = $1', [dbLocationId]);
  const smId = lr[0] && lr[0].shopmonkey_location_id;
  if (!smId) return empty;   // not connected to Shopmonkey
  const now = Date.now();
  const DAY = 86400000;
  const wf = await fetchWorkflowStatusMap(apiKey, smId);
  const stageOf = (o) => wf[o.workflowStatusId] || o.status || 'Unknown';
  const committed = await fetchCommittedOrders(apiKey, smId);
  const rows = committed.map((o) => {
    const authMs = o.authorizedDate ? new Date(o.authorizedDate).getTime() : now;
    const ageDays = Math.floor((now - authMs) / DAY);
    return { order_number: o.number || o.id, order_id: o.id, stage: stageOf(o), subtotal: centsToDollars(orderSubtotalCents(o)), authorized_date: o.authorizedDate || null, age_days: ageDays, aging: ageDays > AGING_DAYS };
  });
  const active = rows.filter((r) => !r.aging);
  const aging = rows.filter((r) => r.aging);
  const sum = (arr) => arr.reduce((s, r) => s + r.subtotal, 0);
  const byStage = {};
  for (const r of rows) { byStage[r.stage] = byStage[r.stage] || { stage: r.stage, count: 0, total: 0 }; byStage[r.stage].count += 1; byStage[r.stage].total += r.subtotal; }
  return { total_count: rows.length, total_value: sum(rows), active_count: active.length, active_value: sum(active), aging_count: aging.length, aging_value: sum(aging), aging_days: AGING_DAYS, by_stage: Object.values(byStage).sort((a, b) => b.total - a.total), active: active.sort((a, b) => new Date(b.authorized_date) - new Date(a.authorized_date)), aging: aging.sort((a, b) => new Date(a.authorized_date) - new Date(b.authorized_date)) };
}
// ---- end Committed WIP helpers --------------------------------------------
// MTD must be anchored to the SHOP's timezone (Mountain), not the server's (UTC on
// Railway). Otherwise, for the ~6-7h between UTC midnight and local midnight at
// month-end, "month-to-date" flips to next month and the dashboard reads ~$0.
function monthStartFor(now, tz = 'America/Edmonton') {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric' }).formatToParts(now);
  const y = +parts.find((p) => p.type === 'year').value;
  const m = +parts.find((p) => p.type === 'month').value;
  const guess = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const local = new Date(guess.toLocaleString('en-US', { timeZone: tz }));
  return new Date(guess.getTime() + (guess.getTime() - local.getTime()));
}

async function fetchOrdersSince(apiKey, sinceDate) {
  const { orders, total } = await sweepOrders(apiKey, { where: { invoicedDate: { gte: sinceDate.toISOString() } } });
  const filtered = orders.filter(o => !o.deleted && o.invoicedDate && o.invoicedDate !== 'empty');
  // Empty is legit ONLY if Shopmonkey explicitly reports 0 (e.g. the 1st of a new
  // month before the first invoice). Otherwise it's a throttle/failure — throw so
  // the caller keeps its last good cache instead of caching $0.
  if (filtered.length === 0 && total !== 0) {
    throw new Error(`Shopmonkey returned no invoiced orders (total=${total}) — refusing to report empty`);
  }
  return filtered;
}

// Technician name map. Roster lives on /v3/user (assignedTechnician===true);
// /v3/technician 404s on this account.
async function fetchTechNames(apiKey) {
  const techNames = {};
  try {
    const res = await fetch('https://api.shopmonkey.cloud/v3/user?limit=200', {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });
    if (res.ok) {
      const td = await res.json();
      const list = (td && td.data && td.data.data) ? td.data.data : (td.data || []);
      for (const t of list) {
        if (t.assignedTechnician === true && t.active !== false) {
          techNames[t.id] = t.name || [t.firstName, t.lastName].filter(Boolean).join(' ') || 'Unknown';
        }
      }
    }
  } catch (e) { /* optional */ }
  return techNames;
}

// ---- Live alerts: stale vehicles + per-RO margin flags ---------------------
// Open orders = not invoiced, not archived (i.e. cars still in the shop).
async function fetchOpenOrders(apiKey, locationId) {
  const { orders } = await sweepOrders(apiKey, { where: { invoicedDate: null, archived: false }, locationId });
  return orders.filter(o => !o.deleted);
}

// Builds the alert list stored in metrics_cache.alerts and rendered by the
// Alerts page / Home strip / sidebar badge. Two kinds:
//   stale  — open (uninvoiced, un-archived) order whose days-on-site >= the
//            location's stale_threshold_days. "Days on site" is measured from
//            the work order's createdDate (when the RO was opened) — this is the
//            intended definition. Archived/invoiced jobs are excluded by the
//            fetch, so completed cars never show up as stale.
//   margin — order invoiced this month whose parts margin (from the per-order
//            profitability already on the object) is below parts_margin_target.
// Each alert carries structured fields; the client formats the display text,
// so the RO number is always the one Shopmonkey reports for that exact order.
async function buildAlerts(apiKey, loc, mtdOrders) {
  const DAY = 86400000;
  const now = Date.now();
  const staleThreshold = parseInt(loc.stale_threshold_days, 10) || 5;
  const marginTarget = parseFloat(loc.parts_margin_target) || 55;
  const locName = loc.name || 'Location';
  const alerts = [];

  let open = [];
  try { open = await fetchOpenOrders(apiKey, loc.shopmonkey_location_id || ''); }
  catch (e) { console.error('fetchOpenOrders failed:', e.message); open = []; }
  for (const o of open) {
    if (!loc.shopmonkey_location_id) continue; // location not connected to Shopmonkey: never inherit account-wide orders
    if (o.locationId && o.locationId !== loc.shopmonkey_location_id) continue;
    const start = parseShopmonkeyDate(o.createdDate) || parseShopmonkeyDate(o.authorizedDate);
    if (!start) continue;
    const days = Math.floor((now - start.getTime()) / DAY);
    if (days < staleThreshold) continue;
    alerts.push({
      type: 'stale',
      ro: o.number != null ? String(o.number) : (o.id || ''),
      vehicle: o.generatedVehicleName || 'Vehicle',
      customer: o.generatedCustomerName || 'Customer',
      checked_in: start.toISOString().slice(0, 10),
      days_on_site: days,
      location: locName
    });
  }

  for (const o of mtdOrders) {
    const prof = o.profitability && o.profitability.parts ? o.profitability.parts : null;
    const retail = prof && typeof prof.retailCents === 'number' ? prof.retailCents : (o.partsCents || 0);
    const wholesale = prof && typeof prof.wholesaleCents === 'number' ? prof.wholesaleCents : 0;
    if (retail <= 0 || wholesale <= 0) continue; // no cost data -> can't judge margin
    if (retail < 5000) continue;                 // ignore trivial parts lines (<$50)
    const margin = ((retail - wholesale) / retail) * 100;
    if (margin >= marginTarget) continue;
    alerts.push({
      type: 'margin',
      ro: o.number != null ? String(o.number) : (o.id || ''),
      vehicle: o.generatedVehicleName || 'Vehicle',
      customer: o.generatedCustomerName || null,
      parts_margin: Math.round(margin * 10) / 10,
      parts_margin_target: marginTarget,
      location: locName
    });
  }

  alerts.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'stale' ? -1 : 1;
    if (a.type === 'stale') return b.days_on_site - a.days_on_site;
    return a.parts_margin - b.parts_margin;
  });
  return alerts;
}
// ---- end live alerts -------------------------------------------------------

module.exports = (pool) => {
  // syncAuth: machine-to-machine auth for scheduled refreshes (e.g. Make).
  // Accepts a valid X-Sync-Key header matching SYNC_SECRET as an alternative
  // to a JWT, but ONLY on the refresh routes it's attached to. Fails closed:
  // if SYNC_SECRET is unset, the key path is disabled and JWT is required.
  const syncAuth = (req, res, next) => {
    const secret = process.env.SYNC_SECRET;
    const provided = req.get('X-Sync-Key');
    if (secret && provided && provided === secret) {
      req.user = { role: 'owner', via: 'sync-key' };
      return next();
    }
    return authenticateToken(req, res, next);
  };
  const router = express.Router();

  // Read-only reconciliation: the MTD per-component breakdown (parts, labour,
  // shop supplies, tires, subcontracts) so the dashboard total can be matched
  // line-by-line against the Shopmonkey Sales Summary, same window the metric uses.
  router.get('/:locationId/reconcile', authenticateToken, async (req, res) => {
    const apiKey = process.env.SHOPMONKEY_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'SHOPMONKEY_API_KEY not configured' });
    try {
      const locResult = await pool.query('SELECT * FROM locations WHERE id = $1', [req.params.locationId]);
      if (!locResult.rows.length) return res.status(404).json({ error: 'Location not found' });
      const loc = locResult.rows[0];
      const now = new Date();
      const monthStart = monthStartFor(now);
      let orders;
      try { orders = await fetchOrdersSince(apiKey, monthStart); }
      catch (e) { return res.status(502).json({ error: e.message }); }

      const scoped = orders.filter(o => {
        if (!loc.shopmonkey_location_id) return false;
        if (o.locationId && o.locationId !== loc.shopmonkey_location_id) return false;
        const invoiced = parseShopmonkeyDate(o.invoicedDate);
        return invoiced && invoiced >= monthStart && invoiced <= now;
      });
      const counted = scoped.filter(o => !isComeback(o));
      const comebacks = scoped.filter(isComeback);
      const sumC = (arr, f) => Math.round(arr.reduce((s, o) => s + (f(o) || 0), 0)) / 100;
      const comp = {
        parts: sumC(counted, o => o.partsCents),
        labour: sumC(counted, o => o.laborCents),
        shop_supplies: sumC(counted, o => o.shopSuppliesCents),
        tires: sumC(counted, o => o.tiresCents),
        subcontracts: sumC(counted, o => o.subcontractsCents),
      };
      const revenue = +(comp.parts + comp.labour + comp.shop_supplies + comp.tires + comp.subcontracts).toFixed(2);
      res.json({
        window: { from: monthStart.toISOString(), to: now.toISOString(), basis: 'invoicedDate, shop-timezone (Mountain) month-to-date' },
        counted_orders: counted.length,
        comebacks_excluded: comebacks.length,
        components: comp,
        revenue_mtd: revenue,
        sample: counted.slice(0, 10).map(o => ({ order: o.number || o.id, invoiced: o.invoicedDate, subtotal: Math.round(orderSubtotalCents(o)) / 100 })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/:locationId/refresh', syncAuth, async (req, res) => {
    const apiKey = process.env.SHOPMONKEY_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'SHOPMONKEY_API_KEY not configured' });
    try {
      // Fire-and-forget: refresh Committed WIP cache alongside metrics (non-blocking; never affects this response).
      buildCommittedWip(pool, apiKey, req.params.locationId).then(w => pool.query(`INSERT INTO committed_wip_cache (location_id, payload, created_at) VALUES ($1,$2,NOW()) ON CONFLICT (location_id) DO UPDATE SET payload=EXCLUDED.payload, created_at=NOW()`, [req.params.locationId, JSON.stringify(w)])).catch(e => console.error('wip refresh (via /refresh) failed:', e.message));
      const locResult = await pool.query('SELECT * FROM locations WHERE id = $1', [req.params.locationId]);
      if (!locResult.rows.length) return res.status(404).json({ error: 'Location not found' });
      const loc = locResult.rows[0];
      const labourRate = parseFloat(loc.labour_rate) || 170;
      const techWage = parseFloat(process.env.TECH_WAGE) || 40;
      const partsMarginTarget = parseFloat(loc.parts_margin_target) || 55;

      const now = new Date();
      const monthStart = monthStartFor(now);

      let orders;
      try { orders = await fetchOrdersSince(apiKey, monthStart); }
      catch (e) { return res.status(502).json({ error: e.message }); }

      const mtdOrders = orders.filter(o => {
        if (!loc.shopmonkey_location_id) return false; // location not connected to Shopmonkey: never inherit account-wide orders
        if (o.locationId && o.locationId !== loc.shopmonkey_location_id) return false;
        const invoiced = parseShopmonkeyDate(o.invoicedDate);
        return invoiced && invoiced >= monthStart && invoiced <= now && !isComeback(o);
      });

      let revenue = 0, partsRetail = 0, labourRev = 0, totalProfit = 0;
      let partsRetailWithData = 0, partsWholesaleWithData = 0;
      let carCount = 0;

      for (const o of mtdOrders) {
        carCount++;
        // PRE-TAX revenue = five-component subtotal (validated $81,500.78).
        // Was previously totalCostCents (cost, not revenue). Tax excluded.
        const subtotal = centsToDollars(orderSubtotalCents(o));
        const parts = centsToDollars(o.partsCents);
        const labour = centsToDollars(o.laborCents);
        revenue += subtotal;
        labourRev += labour;
        partsRetail += parts;

        const prof = o.profitability && typeof o.profitability === 'object' ? o.profitability : null;
        const profParts = prof && prof.parts ? prof.parts : null;
        if (profParts && typeof profParts.wholesaleCents === 'number' && profParts.wholesaleCents > 0) {
          partsRetailWithData += centsToDollars(profParts.retailCents || o.partsCents);
          partsWholesaleWithData += centsToDollars(profParts.wholesaleCents);
        }
        if (prof && typeof prof.totalProfitCents === 'number') {
          totalProfit += centsToDollars(prof.totalProfitCents);
        }
      }

      // Rate-aware labour hours from line-level /service data (handles $170 + $200
      // vehicles, and comped $0 lines). Billed hours = hours on revenue-generating
      // lines (calculatedLaborCents > 0); worked hours = all labour-line hours.
      // PPH uses billed hours so comped/give-away time doesn't depress the metric.
      let labourHoursBilled = 0, labourHoursWorked = 0, svcFail = 0;
      for (const o of mtdOrders) {
        let lines = [];
        try {
          const sr = await fetch(`https://api.shopmonkey.cloud/v3/order/${o.id}/service?limit=100`, {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
          });
          if (!sr.ok) { svcFail++; continue; }
          const sj = await sr.json();
          lines = (sj && sj.data && sj.data.data) ? sj.data.data : (sj.data || []);
        } catch (e) { svcFail++; continue; }
        for (const ln of (lines || [])) {
          const lineGeneratedRevenue = (ln.calculatedLaborCents || 0) > 0;
          for (const lab of (ln.labors || [])) {
            const hrs = Number(lab.hours) || 0;
            if (hrs === 0) continue;
            labourHoursWorked += hrs;
            if (lineGeneratedRevenue) labourHoursBilled += hrs;
          }
        }
      }
      // If ANY per-order hours fetch failed (esp. a 429), the hours aggregate is
      // incomplete — writing it would poison labour_margin/pph/effective_rate (this
      // is what silently blanked efficiency). Bail so the cache keeps its last good
      // row instead of persisting a half-updated one.
      if (svcFail > 0) {
        return res.status(502).json({ error: `Labour-hours fetch incomplete (${svcFail}/${mtdOrders.length} orders failed, likely rate-limited) — kept last good metrics` });
      }
      const labourHoursComped = labourHoursWorked - labourHoursBilled;

      let partsMargin;
      if (partsWholesaleWithData > 0 && partsRetailWithData > 0) {
        partsMargin = ((partsRetailWithData - partsWholesaleWithData) / partsRetailWithData) * 100;
      } else {
        partsMargin = partsMarginTarget;
      }

      // Was: labourRev / labourRate (single $170 assumption -> wrong with $200 jobs
      // and comped hours). Now the real billed line hours, rate-agnostic.
      const labourHoursSold = labourHoursBilled;
      const labourCost = labourHoursSold * techWage;
      const labourMargin = labourRev > 0 ? ((labourRev - labourCost) / labourRev) * 100 : 0;

      const partsCost = partsRetail * (1 - partsMargin / 100);
      const partsProfit = partsRetail - partsCost;
      const labourProfit = labourRev - labourCost;
      if (totalProfit === 0) { totalProfit = partsProfit + labourProfit; }

      const hoursForPph = labourHoursSold > 0 ? labourHoursSold : 1;
      const pph = (labourProfit + partsProfit) / hoursForPph;
      const avgRoValue = carCount > 0 ? revenue / carCount : 0;
      // Effective labour rate = actual labour $ earned per billed hour. Compared to
      // the posted door rate (locations.labour_rate) it shows discount leakage:
      // e.g. $170 door vs $158 effective = $12/hr given away on every billed hour.
      const effectiveLabourRate = labourHoursSold > 0 ? labourRev / labourHoursSold : 0;

      // Live alerts (stale vehicles + per-RO margin flags). Best-effort: a failure
      // here must not break the metrics refresh, so it falls back to an empty list.
      let alerts = [];
      try { alerts = await buildAlerts(apiKey, loc, mtdOrders); }
      catch (e) { console.error('buildAlerts failed:', e.message); }

      const payload = {
        revenue_mtd: Math.round(revenue * 100) / 100,
        car_count_mtd: carCount,
        parts_margin: Math.round(partsMargin * 10) / 10,
        labour_margin: Math.round(labourMargin * 10) / 10,
        labour_revenue: Math.round(labourRev * 100) / 100,
        avg_ro_value: Math.round(avgRoValue * 100) / 100,
        labour_hours_sold: Math.round(labourHoursSold * 10) / 10,
        labour_hours_worked: Math.round(labourHoursWorked * 10) / 10,
        labour_hours_comped: Math.round(labourHoursComped * 10) / 10,
        effective_labour_rate: Math.round(effectiveLabourRate * 100) / 100,
        efficiency_avg: null,
        pph: Math.round(pph * 100) / 100,
        total_profit: Math.round(totalProfit * 100) / 100,
        alerts
      };

      await pool.query('ALTER TABLE metrics_cache ADD COLUMN IF NOT EXISTS labour_hours_worked NUMERIC');
      await pool.query('ALTER TABLE metrics_cache ADD COLUMN IF NOT EXISTS labour_revenue NUMERIC');
      await pool.query('ALTER TABLE metrics_cache ADD COLUMN IF NOT EXISTS labour_hours_comped NUMERIC');
      await pool.query('ALTER TABLE metrics_cache ADD COLUMN IF NOT EXISTS effective_labour_rate NUMERIC');
      await pool.query(
        `INSERT INTO metrics_cache (location_id, revenue_mtd, car_count_mtd, parts_margin, labour_margin, avg_ro_value, labour_hours_sold, labour_hours_worked, labour_hours_comped, labour_revenue, effective_labour_rate, efficiency_avg, pph, total_profit, alerts, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())`,
        [req.params.locationId, payload.revenue_mtd, payload.car_count_mtd, payload.parts_margin, payload.labour_margin, payload.avg_ro_value, payload.labour_hours_sold, payload.labour_hours_worked, payload.labour_hours_comped, payload.labour_revenue, payload.effective_labour_rate, payload.efficiency_avg, payload.pph, payload.total_profit, JSON.stringify(payload.alerts)]
      );

      res.json({ message: 'Metrics refreshed from Shopmonkey (pre-tax revenue)', orders_pulled: orders.length, mtd_orders: mtdOrders.length, profitability_data_available: partsWholesaleWithData > 0, metrics: payload });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Refresh tech efficiency using LINE-LEVEL attribution from /v3/order/{id}/service.
  // Validated penny-exact to Shopmonkey's "Summary by Technician" report:
  //   hours_billed  = sum of each labour line's `hours`, grouped by labors[].technicianId
  //   labour_revenue= each parent service line's calculatedLaborCents (already net of
  //                   discounts + lump-sum/matrix pricing), split across the line's techs
  //                   proportional to their hours
  //   vehicle_count = distinct vehicleId where the tech has any labour line
  // Includes ALL invoiced orders (even $0 comebacks carry real assigned labour hours).
  // hours_sold mirrors hours_billed at line level; worked hours / efficiency stay null
  // until QBO Time connects. Costs one extra API call per order.

  // Refresh tech efficiency using LINE-LEVEL attribution from /v3/order/{id}/service.
  // Validated penny-exact to Shopmonkey's "Summary by Technician" report:
  //   hours_sold    = sum of every labour line's `hours`, grouped by labors[].technicianId
  //                   (total 275.7 reconciles to the report's "Total Billed Hours" column)
  //   hours_billed  = hours ONLY on lines that generated revenue (calculatedLaborCents > 0);
  //                   a line comped 100% to $0 contributes to sold but NOT billed, so the
  //                   sold-vs-billed gap surfaces discounted/goodwill labour per tech
  //   labour_revenue= each parent line's calculatedLaborCents (net of discounts + lump-sum/
  //                   matrix pricing), split across the line's techs proportional to hours
  //   vehicle_count = distinct vehicleId where the tech has any labour line
  // Includes ALL invoiced orders (even $0 comebacks carry real assigned labour hours).
  // Techs with zero sold hours this month are omitted (they did no labour work).
  // Worked hours / efficiency stay null until QBO Time connects. Costs one extra API
  // call per order, so it is heavier than the order-level path.
  router.post('/:locationId/refresh-tech', syncAuth, async (req, res) => {
    const apiKey = process.env.SHOPMONKEY_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'SHOPMONKEY_API_KEY not configured' });

    try {
      const locResult = await pool.query('SELECT * FROM locations WHERE id = $1', [req.params.locationId]);
      if (!locResult.rows.length) return res.status(404).json({ error: 'Location not found' });
      const loc = locResult.rows[0];

      const techNames = await fetchTechNames(apiKey);

      const now = new Date();
      const monthStart = monthStartFor(now);
      let orders;
      try {
        orders = await fetchOrdersSince(apiKey, monthStart);
      } catch (e) {
        return res.status(502).json({ error: e.message });
      }

      const monthOrders = orders.filter(o => {
        if (!loc.shopmonkey_location_id) return false; // location not connected to Shopmonkey: never inherit account-wide orders
        if (o.locationId && o.locationId !== loc.shopmonkey_location_id) return false;
        const invoiced = parseShopmonkeyDate(o.invoicedDate);
        return invoiced && invoiced >= monthStart && invoiced <= now;
      });

      const byTech = {};
      const ensure = (id, name) => {
        if (!byTech[id]) byTech[id] = {
          tech_id: id,
          tech_name: name,
          hours_sold: 0,
          hours_billed: 0,
          labour_revenue: 0,
          _vehicles: new Set()
        };
        return byTech[id];
      };

      const monthVehicles = new Set();
      let svcFail = 0;
      for (const o of monthOrders) {
        if (o.vehicleId) monthVehicles.add(o.vehicleId);
        let lines = [];
        try {
          const sr = await fetch(`https://api.shopmonkey.cloud/v3/order/${o.id}/service?limit=100`, {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
          });
          if (!sr.ok) { svcFail++; continue; }
          const sj = await sr.json();
          lines = (sj && sj.data && sj.data.data) ? sj.data.data : (sj.data || []);
        } catch (e) { svcFail++; continue; }

        for (const ln of (lines || [])) {
          const labs = (ln.labors || []).filter(l => l.technicianId);
          if (!labs.length) continue;
          const lineLaborDollars = centsToDollars(ln.calculatedLaborCents);
          const lineHours = labs.reduce((s, l) => s + (Number(l.hours) || 0), 0);
          const lineGeneratedRevenue = lineLaborDollars > 0;
          for (const lab of labs) {
            const tid = lab.technicianId;
            const hrs = Number(lab.hours) || 0;
            const b = ensure(tid, techNames[tid] || `Tech ${String(tid).slice(0, 6)}`);
            b.hours_sold += hrs;
            if (lineGeneratedRevenue) b.hours_billed += hrs;
            b.labour_revenue += lineHours > 0
              ? lineLaborDollars * (hrs / lineHours)
              : lineLaborDollars / labs.length;
            if (o.vehicleId) b._vehicles.add(o.vehicleId);
          }
        }
      }

      // Incomplete hours -> don't wipe good per-tech rows with partial ones.
      if (svcFail > 0) {
        return res.status(502).json({ error: `Tech hours fetch incomplete (${svcFail}/${monthOrders.length} orders failed, likely rate-limited) — kept last good tech efficiency` });
      }

      // Worked hours = working days elapsed this month x 8 (holiday + province
      // aware), matching /hours/:loc/recompute-from-weekly so the 2h auto-refresh
      // and the manual recompute produce the same efficiency definition.
      const province = loc.province || 'ab';
      const workedHours = workingDaysElapsed(province, now) * 8;

      const techs = Object.values(byTech)
        .filter(t => t.hours_sold > 0)
        .map(t => ({
          tech_id: t.tech_id,
          tech_name: t.tech_name,
          hours_available: null,
          hours_worked: workedHours,
          hours_sold: Math.round(t.hours_sold * 10) / 10,
          hours_billed: Math.round(t.hours_billed * 10) / 10,
          vehicle_count: t._vehicles.size,
          efficiency: workedHours > 0 ? Math.round((t.hours_sold / workedHours) * 100) : null,
          labour_revenue: Math.round(t.labour_revenue * 100) / 100,
          parts_gp: null
        }));

      const date = new Date().toISOString().slice(0, 10);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE tech_efficiency ADD COLUMN IF NOT EXISTS period_type VARCHAR(8)');
        // Write rows as period_type='mtd' so the Technicians tab (which reads
        // only mtd rows) sees the 2h auto-refresh. Previously these were written
        // with period_type NULL — rows the reader could never see, so the tab
        // stayed frozen at the last manual recompute (and new techs never
        // appeared until someone pressed the button). Also sweep legacy NULL
        // rows for the same date.
        await client.query("DELETE FROM tech_efficiency WHERE location_id = $1 AND snapshot_date = $2 AND (period_type IS NULL OR period_type = 'mtd')", [req.params.locationId, date]);
        await client.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS distinct_vehicles_mtd INTEGER');
        await client.query('UPDATE locations SET distinct_vehicles_mtd = $1, updated_at = NOW() WHERE id = $2', [monthVehicles.size, req.params.locationId]);
        for (const t of techs) {
          await client.query(
            `INSERT INTO tech_efficiency (location_id, snapshot_date, period_type, tech_id, tech_name, hours_available, hours_worked, hours_sold, hours_billed, vehicle_count, efficiency, labour_revenue, parts_gp)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [req.params.locationId, date, 'mtd', t.tech_id, t.tech_name, t.hours_available, t.hours_worked, t.hours_sold, t.hours_billed, t.vehicle_count, t.efficiency, t.labour_revenue, t.parts_gp]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      res.json({
        message: 'Tech efficiency refreshed (line-level; sold = all hours, billed = revenue-generating hours)',
        orders_scanned: monthOrders.length,
        techs_found: techs.length,
        distinct_vehicles_mtd: monthVehicles.size,
        techs
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:locationId/refresh-comebacks', authenticateToken, async (req, res) => {
    const apiKey = process.env.SHOPMONKEY_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'SHOPMONKEY_API_KEY not configured' });
    try {
      const locResult = await pool.query('SELECT * FROM locations WHERE id = $1', [req.params.locationId]);
      if (!locResult.rows.length) return res.status(404).json({ error: 'Location not found' });
      const loc = locResult.rows[0];
      const techWage = parseFloat(process.env.TECH_WAGE) || 40;

      const techNames = await fetchTechNames(apiKey);

      const now = new Date();
      const monthStart = monthStartFor(now);
      let orders;
      try { orders = await fetchOrdersSince(apiKey, monthStart); }
      catch (e) { return res.status(502).json({ error: e.message }); }

      const comebacks = orders.filter(o => {
        if (!loc.shopmonkey_location_id) return false; // location not connected to Shopmonkey: never inherit account-wide orders
        if (o.locationId && o.locationId !== loc.shopmonkey_location_id) return false;
        const invoiced = parseShopmonkeyDate(o.invoicedDate);
        return invoiced && invoiced >= monthStart && invoiced <= now && isComeback(o);
      });

      const rows = comebacks.map(o => {
        const techIds = Array.isArray(o.assignedTechnicianIds) ? o.assignedTechnicianIds : [];
        const techId = techIds[0] || null;
        const techName = techId ? (techNames[techId] || `Tech ${String(techId).slice(0, 6)}`) : 'Unassigned';
        const hours = (typeof o.totalLaborHours === 'number' && o.totalLaborHours > 0) ? o.totalLaborHours : (typeof o.completedLaborHours === 'number' ? o.completedLaborHours : 0);
        return {
          order_number: o.number != null ? String(o.number) : null,
          order_id: o.id || null,
          invoiced_date: parseShopmonkeyDate(o.invoicedDate),
          customer_name: o.generatedCustomerName || null,
          vehicle_name: o.generatedVehicleName || null,
          tech_id: techId, tech_name: techName,
          labour_hours: Math.round(hours * 10) / 10,
          unbilled_wage_cost: Math.round(hours * techWage * 100) / 100,
          complaint: (o.complaint && o.complaint !== 'empty') ? String(o.complaint).slice(0, 500) : null
        };
      });

      const date = new Date().toISOString().slice(0, 10);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM comebacks WHERE location_id = $1 AND snapshot_date = $2', [req.params.locationId, date]);
        for (const r of rows) {
          await client.query(
            `INSERT INTO comebacks (location_id, snapshot_date, order_number, order_id, invoiced_date, customer_name, vehicle_name, tech_id, tech_name, labour_hours, unbilled_wage_cost, complaint)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [req.params.locationId, date, r.order_number, r.order_id, r.invoiced_date, r.customer_name, r.vehicle_name, r.tech_id, r.tech_name, r.labour_hours, r.unbilled_wage_cost, r.complaint]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK'); throw err;
      } finally { client.release(); }

      const totalHours = rows.reduce((s, r) => s + r.labour_hours, 0);
      const totalCost = rows.reduce((s, r) => s + r.unbilled_wage_cost, 0);
      res.json({ message: 'Comebacks refreshed', count: rows.length, total_unbilled_hours: Math.round(totalHours * 10) / 10, total_unbilled_wage_cost: Math.round(totalCost * 100) / 100, comebacks: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:locationId/comebacks', authenticateToken, async (req, res) => {
    try {
      const latest = await pool.query('SELECT MAX(snapshot_date) AS d FROM comebacks WHERE location_id = $1', [req.params.locationId]);
      const d = latest.rows[0] && latest.rows[0].d ? latest.rows[0].d : null;
      if (!d) return res.json({ snapshot_date: null, count: 0, comebacks: [], by_tech: [] });
      const rowsRes = await pool.query(
        `SELECT order_number, order_id, invoiced_date, customer_name, vehicle_name, tech_id, tech_name, labour_hours, unbilled_wage_cost, complaint
         FROM comebacks WHERE location_id = $1 AND snapshot_date = $2 ORDER BY invoiced_date DESC NULLS LAST`,
        [req.params.locationId, d]
      );
      const rows = rowsRes.rows;
      const totalHours = rows.reduce((s, r) => s + Number(r.labour_hours || 0), 0);
      const totalCost = rows.reduce((s, r) => s + Number(r.unbilled_wage_cost || 0), 0);
      const byTechMap = {};
      for (const r of rows) {
        const key = r.tech_name || 'Unassigned';
        if (!byTechMap[key]) byTechMap[key] = { tech_name: key, count: 0, hours: 0, cost: 0 };
        byTechMap[key].count++; byTechMap[key].hours += Number(r.labour_hours || 0); byTechMap[key].cost += Number(r.unbilled_wage_cost || 0);
      }
      res.json({
        snapshot_date: d, count: rows.length,
        total_unbilled_hours: Math.round(totalHours * 10) / 10,
        total_unbilled_wage_cost: Math.round(totalCost * 100) / 100,
        comebacks: rows,
        by_tech: Object.values(byTechMap).map(t => ({ tech_name: t.tech_name, count: t.count, hours: Math.round(t.hours * 10) / 10, cost: Math.round(t.cost * 100) / 100 }))
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
// // ---- Committed WIP routes (added) ----
      router.post('/:locationId/refresh-wip', syncAuth, async (req, res) => {
        const apiKey = process.env.SHOPMONKEY_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'SHOPMONKEY_API_KEY not configured' });
        const { locationId } = req.params;
        try {
          const wip = await buildCommittedWip(pool, apiKey, locationId);
          await pool.query(`INSERT INTO committed_wip_cache (location_id, payload, created_at) VALUES ($1, $2, NOW()) ON CONFLICT (location_id) DO UPDATE SET payload = EXCLUDED.payload, created_at = NOW()`, [locationId, JSON.stringify(wip)]);
          res.json({ ok: true, ...wip });
        } catch (err) {
          console.error('refresh-wip failed:', err);
          res.status(500).json({ error: String(err.message || err) });
        }
      });
      router.get('/:locationId/wip', authenticateToken, async (req, res) => {
        const { locationId } = req.params;
        try {
          const { rows } = await pool.query(`SELECT payload, created_at FROM committed_wip_cache WHERE location_id = $1`, [locationId]);
          if (!rows.length) return res.json({ total_count: 0, total_value: 0, active: [], aging: [], by_stage: [], cached: false });
          const payload = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
          res.json({ ...payload, cached: true, synced_at: rows[0].created_at });
        } catch (err) {
          console.error('GET wip failed:', err);
          res.status(500).json({ error: String(err.message || err) });
        }
      });
      
  return router;
};
