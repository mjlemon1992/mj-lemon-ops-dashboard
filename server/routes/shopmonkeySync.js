const express = require('express');
const { authenticateToken } = require('../middleware/auth');

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

// ---- Committed WIP helpers (added) ----------------------------------------
let _wfCache = { at: 0, map: {} };
async function fetchWorkflowStatusMap(apiKey, locationId) {
  if (Date.now() - _wfCache.at < 10 * 60 * 1000 && Object.keys(_wfCache.map).length) return _wfCache.map;
  const params = new URLSearchParams({ locationId, limit: '50' });
  const res = await fetch(`https://api.shopmonkey.cloud/v3/workflow_status?${params}`, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
  if (!res.ok) return _wfCache.map;
  const data = await res.json();
  const rows = (data && data.data && data.data.data) ? data.data.data : (data.data || []);
  const map = {};
  rows.forEach((w) => { map[w.id] = w.name; });
  _wfCache = { at: Date.now(), map };
  return map;
}
async function fetchCommittedOrders(apiKey, locationId) {
  const pageSize = 100;
  let all = [];
  for (let page = 0; page < 12; page++) {
    const params = new URLSearchParams({ locationId, where: JSON.stringify({ authorized: true, invoicedDate: null, archived: false }), limit: String(pageSize), skip: String(page * pageSize) });
    const res = await fetch(`https://api.shopmonkey.cloud/v3/order?${params}`, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
    if (!res.ok) { const txt = await res.text(); throw new Error(`Shopmonkey API error ${res.status}: ${txt.slice(0, 200)}`); }
    const data = await res.json();
    const batch = (data && data.data && data.data.data) ? data.data.data : (data.data || []);
    if (!batch.length) break;
    all = all.concat(batch);
    if (batch.length < pageSize) break;
  }
  const seen = new Map();
  for (const o of all) { const key = o.number || o.id; if (!seen.has(key)) seen.set(key, o); }
  return [...seen.values()];
}
async function buildCommittedWip(apiKey, locationId) {
  const AGING_DAYS = 14;
  const now = Date.now();
  const DAY = 86400000;
  const wf = await fetchWorkflowStatusMap(apiKey, locationId);
  const stageOf = (o) => wf[o.workflowStatusId] || o.status || 'Unknown';
  const committed = await fetchCommittedOrders(apiKey, locationId);
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
async function fetchOrdersSince(apiKey, sinceDate, maxPages = 12) {
  const pageSize = 100;
  const iso = sinceDate.toISOString();
  let all = [];
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      where: JSON.stringify({ invoicedDate: { gte: iso } }),
      limit: String(pageSize),
      skip: String(page * pageSize)
    });
    const res = await fetch(`https://api.shopmonkey.cloud/v3/order?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Shopmonkey API error ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    const batch = (data && data.data && data.data.data) ? data.data.data : (data.data || []);
    if (!batch.length) break;
    all = all.concat(batch);
    if (batch.length < pageSize) break;
  }
  return all.filter(o => !o.deleted && o.invoicedDate && o.invoicedDate !== 'empty');
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

  router.post('/:locationId/refresh', syncAuth, async (req, res) => {
    const apiKey = process.env.SHOPMONKEY_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'SHOPMONKEY_API_KEY not configured' });
    try {
      // Fire-and-forget: refresh Committed WIP cache alongside metrics (non-blocking; never affects this response).
      buildCommittedWip(apiKey, req.params.locationId).then(w => pool.query(`INSERT INTO committed_wip_cache (location_id, payload, created_at) VALUES ($1,$2,NOW()) ON CONFLICT (location_id) DO UPDATE SET payload=EXCLUDED.payload, created_at=NOW()`, [req.params.locationId, JSON.stringify(w)])).catch(e => console.error('wip refresh (via /refresh) failed:', e.message));
      const locResult = await pool.query('SELECT * FROM locations WHERE id = $1', [req.params.locationId]);
      if (!locResult.rows.length) return res.status(404).json({ error: 'Location not found' });
      const loc = locResult.rows[0];
      const labourRate = parseFloat(loc.labour_rate) || 170;
      const techWage = parseFloat(process.env.TECH_WAGE) || 40;
      const partsMarginTarget = parseFloat(loc.parts_margin_target) || 55;

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      let orders;
      try { orders = await fetchOrdersSince(apiKey, monthStart); }
      catch (e) { return res.status(502).json({ error: e.message }); }

      const mtdOrders = orders.filter(o => {
        if (o.locationId && loc.shopmonkey_location_id && o.locationId !== loc.shopmonkey_location_id) return false;
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
      let labourHoursBilled = 0, labourHoursWorked = 0;
      for (const o of mtdOrders) {
        let lines = [];
        try {
          const sr = await fetch(`https://api.shopmonkey.cloud/v3/order/${o.id}/service?limit=100`, {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
          });
          if (!sr.ok) continue;
          const sj = await sr.json();
          lines = (sj && sj.data && sj.data.data) ? sj.data.data : (sj.data || []);
        } catch (e) { continue; }
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
        efficiency_avg: null,
        pph: Math.round(pph * 100) / 100,
        total_profit: Math.round(totalProfit * 100) / 100,
        alerts: []
      };

      await pool.query('ALTER TABLE metrics_cache ADD COLUMN IF NOT EXISTS labour_hours_worked NUMERIC');
      await pool.query('ALTER TABLE metrics_cache ADD COLUMN IF NOT EXISTS labour_revenue NUMERIC');
      await pool.query('ALTER TABLE metrics_cache ADD COLUMN IF NOT EXISTS labour_hours_comped NUMERIC');
      await pool.query(
        `INSERT INTO metrics_cache (location_id, revenue_mtd, car_count_mtd, parts_margin, labour_margin, avg_ro_value, labour_hours_sold, labour_hours_worked, labour_hours_comped, labour_revenue, efficiency_avg, pph, total_profit, alerts, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())`,
        [req.params.locationId, payload.revenue_mtd, payload.car_count_mtd, payload.parts_margin, payload.labour_margin, payload.avg_ro_value, payload.labour_hours_sold, payload.labour_hours_worked, payload.labour_hours_comped, payload.labour_revenue, payload.efficiency_avg, payload.pph, payload.total_profit, JSON.stringify(payload.alerts)]
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
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      let orders;
      try {
        orders = await fetchOrdersSince(apiKey, monthStart);
      } catch (e) {
        return res.status(502).json({ error: e.message });
      }

      const monthOrders = orders.filter(o => {
        if (o.locationId && loc.shopmonkey_location_id && o.locationId !== loc.shopmonkey_location_id) return false;
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
      for (const o of monthOrders) {
        if (o.vehicleId) monthVehicles.add(o.vehicleId);
        let lines = [];
        try {
          const sr = await fetch(`https://api.shopmonkey.cloud/v3/order/${o.id}/service?limit=100`, {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
          });
          if (!sr.ok) continue;
          const sj = await sr.json();
          lines = (sj && sj.data && sj.data.data) ? sj.data.data : (sj.data || []);
        } catch (e) { continue; }

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

      const techs = Object.values(byTech)
        .filter(t => t.hours_sold > 0)
        .map(t => ({
          tech_id: t.tech_id,
          tech_name: t.tech_name,
          hours_available: null,
          hours_worked: null,
          hours_sold: Math.round(t.hours_sold * 10) / 10,
          hours_billed: Math.round(t.hours_billed * 10) / 10,
          vehicle_count: t._vehicles.size,
          labour_revenue: Math.round(t.labour_revenue * 100) / 100,
          parts_gp: null
        }));

      const date = new Date().toISOString().slice(0, 10);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM tech_efficiency WHERE location_id = $1 AND snapshot_date = $2', [req.params.locationId, date]);
        await client.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS distinct_vehicles_mtd INTEGER');
        await client.query('UPDATE locations SET distinct_vehicles_mtd = $1, updated_at = NOW() WHERE id = $2', [monthVehicles.size, req.params.locationId]);
        for (const t of techs) {
          await client.query(
            `INSERT INTO tech_efficiency (location_id, snapshot_date, tech_id, tech_name, hours_available, hours_worked, hours_sold, hours_billed, vehicle_count, efficiency, labour_revenue, parts_gp)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [req.params.locationId, date, t.tech_id, t.tech_name, t.hours_available, t.hours_worked, t.hours_sold, t.hours_billed, t.vehicle_count, null, t.labour_revenue, t.parts_gp]
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
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      let orders;
      try { orders = await fetchOrdersSince(apiKey, monthStart); }
      catch (e) { return res.status(502).json({ error: e.message }); }

      const comebacks = orders.filter(o => {
        if (o.locationId && loc.shopmonkey_location_id && o.locationId !== loc.shopmonkey_location_id) return false;
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
          const wip = await buildCommittedWip(apiKey, locationId);
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
