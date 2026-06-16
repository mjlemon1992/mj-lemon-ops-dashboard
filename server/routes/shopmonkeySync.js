const express = require('express');
const { authenticateToken } = require('../middleware/auth');

// Shopmonkey date format: "January 29, 2026 1:00 PM"
function parseShopmonkeyDate(str) {
  if (!str || str === 'empty') return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function centsToDollars(c) {
  return (typeof c === 'number' ? c : 0) / 100;
}

// Subtotal (pre-tax revenue) in cents for an order.
function orderSubtotalCents(o) {
  return (o.partsCents || 0) + (o.laborCents || 0) + (o.shopSuppliesCents || 0)
    + (o.subcontractsCents || 0) + (o.tiresCents || 0);
}

// A "comeback" is an invoiced order that carries no charge: warranty re-dos,
// goodwill work, internal tickets. Excluded from revenue (so metrics reconcile
// to the Shopmonkey report) but tracked separately as a quality + cost signal.
function isComeback(o) {
  return orderSubtotalCents(o) === 0;
}

// Fetch orders invoiced on/after sinceDate. We anchor on invoicedDate (NOT
// createdDate) because Shopmonkey's monthly report counts orders by when they
// were invoiced, and we deliberately apply NO status filter: completed big jobs
// move from "Invoice" to "Paid"/"Closed" status, and a status:'Invoice' filter
// would wrongly exclude exactly those high-value paid rebuilds. The working
// operator is `gte` (no $ prefix) with an ISO string. Note also that
// `where:{invoiced:true}` is unreliable on this account (collapses to ~4 rows),
// which is why we filter on invoicedDate presence in Node instead. Returns ALL
// invoiced, non-deleted orders (revenue AND comebacks); callers split as needed.
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
    if (batch.length < pageSize) break; // last page reached
  }
  // Keep non-deleted orders that carry an invoicedDate. We do NOT drop $0 orders
  // here anymore - callers decide: revenue path keeps subtotal>0, comeback path
  // keeps subtotal==0.
  return all.filter(o => !o.deleted && o.invoicedDate && o.invoicedDate !== 'empty');
}

module.exports = (pool) => {
  const router = express.Router();

  // Refresh metrics for a location by pulling live from Shopmonkey.
  // Trigger: Make scenario hits this on a schedule (1 op per run).
  // Requires SHOPMONKEY_API_KEY in env. Aggregation happens here in Node.
  router.post('/:locationId/refresh', authenticateToken, async (req, res) => {
    const apiKey = process.env.SHOPMONKEY_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'SHOPMONKEY_API_KEY not configured' });

    try {
      // Get location config (labour rate, tech wage, targets for fallback margin)
      const locResult = await pool.query('SELECT * FROM locations WHERE id = $1', [req.params.locationId]);
      if (!locResult.rows.length) return res.status(404).json({ error: 'Location not found' });
      const loc = locResult.rows[0];
      const labourRate = parseFloat(loc.labour_rate) || 170;
      const techWage = parseFloat(process.env.TECH_WAGE) || 40;
      const partsMarginTarget = parseFloat(loc.parts_margin_target) || 55;

      // Current month boundaries
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      // Pull invoiced orders newest-first, covering this month
      let orders;
      try {
        orders = await fetchOrdersSince(apiKey, monthStart);
      } catch (e) {
        return res.status(502).json({ error: e.message });
      }

      // Filter to this month's REVENUE orders for this location (subtotal > 0).
      // Comebacks ($0 invoices) are handled by the comebacks endpoint, not here.
      const mtdOrders = orders.filter(o => {
        if (o.locationId && loc.shopmonkey_location_id && o.locationId !== loc.shopmonkey_location_id) return false;
        const invoiced = parseShopmonkeyDate(o.invoicedDate);
        return invoiced && invoiced >= monthStart && invoiced <= now && !isComeback(o);
      });

      let revenue = 0, partsRetail = 0, partsWholesale = 0, labourRev = 0, totalProfit = 0;
      let partsRetailWithData = 0, partsWholesaleWithData = 0;
      let carCount = 0;

      for (const o of mtdOrders) {
        carCount++;
        const total = centsToDollars(o.totalCostCents);
        const parts = centsToDollars(o.partsCents);
        const labour = centsToDollars(o.laborCents);
        revenue += total;
        labourRev += labour;
        partsRetail += parts;

        // profitability may be empty on migrated orders - handle gracefully
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

      // Parts margin: use real wholesale data where available, else fall back to target
      let partsMargin;
      if (partsWholesaleWithData > 0 && partsRetailWithData > 0) {
        partsMargin = ((partsRetailWithData - partsWholesaleWithData) / partsRetailWithData) * 100;
      } else {
        partsMargin = partsMarginTarget; // fallback when profitability data absent
      }

      // Labour hours sold = labour revenue / labour rate
      const labourHoursSold = labourRate > 0 ? labourRev / labourRate : 0;

      // Labour margin = (labour rev - tech wages for those hours) / labour rev
      const labourCost = labourHoursSold * techWage;
      const labourMargin = labourRev > 0 ? ((labourRev - labourCost) / labourRev) * 100 : 0;

      // Parts profit (estimate from margin if no real data)
      const partsCost = partsRetail * (1 - partsMargin / 100);
      const partsProfit = partsRetail - partsCost;
      const labourProfit = labourRev - labourCost;

      // If profitability data was empty, estimate total profit
      if (totalProfit === 0) {
        totalProfit = partsProfit + labourProfit;
      }

      // PPH = (labour profit + parts profit) / hours worked.
      // Hours worked not available from Shopmonkey alone; use hours sold as proxy until QBO Time.
      const hoursForPph = labourHoursSold > 0 ? labourHoursSold : 1;
      const pph = (labourProfit + partsProfit) / hoursForPph;

      const avgRoValue = carCount > 0 ? revenue / carCount : 0;

      const payload = {
        revenue_mtd: Math.round(revenue * 100) / 100,
        car_count_mtd: carCount,
        parts_margin: Math.round(partsMargin * 10) / 10,
        labour_margin: Math.round(labourMargin * 10) / 10,
        avg_ro_value: Math.round(avgRoValue * 100) / 100,
        labour_hours_sold: Math.round(labourHoursSold * 10) / 10,
        efficiency_avg: null, // populated by tech efficiency feed
        pph: Math.round(pph * 100) / 100,
        total_profit: Math.round(totalProfit * 100) / 100,
        alerts: []
      };

      // Write to metrics_cache
      await pool.query(
        `INSERT INTO metrics_cache (location_id, revenue_mtd, car_count_mtd, parts_margin, labour_margin, avg_ro_value, labour_hours_sold, efficiency_avg, pph, total_profit, alerts, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
        [req.params.locationId, payload.revenue_mtd, payload.car_count_mtd, payload.parts_margin, payload.labour_margin, payload.avg_ro_value, payload.labour_hours_sold, payload.efficiency_avg, payload.pph, payload.total_profit, JSON.stringify(payload.alerts)]
      );

      res.json({
        message: 'Metrics refreshed from Shopmonkey',
        orders_pulled: orders.length,
        mtd_orders: mtdOrders.length,
        profitability_data_available: partsWholesaleWithData > 0,
        metrics: payload
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Refresh tech efficiency (Option A: hours SOLD only from Shopmonkey).
  // Hours worked stays null until QBO Time connects in Kelowna.
  router.post('/:locationId/refresh-tech', authenticateToken, async (req, res) => {
    const apiKey = process.env.SHOPMONKEY_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'SHOPMONKEY_API_KEY not configured' });

    try {
      const locResult = await pool.query('SELECT * FROM locations WHERE id = $1', [req.params.locationId]);
      if (!locResult.rows.length) return res.status(404).json({ error: 'Location not found' });
      const loc = locResult.rows[0];
      const labourRate = parseFloat(loc.labour_rate) || 170;

      // Pull technicians list from Shopmonkey for name mapping
      let techNames = {};
      try {
        const techRes = await fetch('https://api.shopmonkey.cloud/v3/user?limit=200', {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
        });
        if (techRes.ok) {
          const td = await techRes.json();
          const list = (td && td.data && td.data.data) ? td.data.data : (td.data || []);
          for (const t of list) {
            const name = t.name || [t.firstName, t.lastName].filter(Boolean).join(' ') || 'Unknown';
            techNames[t.id] = name;
          }
        }
      } catch (e) { /* technician endpoint optional - fall back to IDs */ }

      // Pull this month's invoiced orders (newest-first, paginated)
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      let orders;
      try {
        orders = await fetchOrdersSince(apiKey, monthStart);
      } catch (e) {
        return res.status(502).json({ error: e.message });
      }

      // Aggregate hours sold + labour revenue per technician
      const byTech = {};
      for (const o of orders) {
        if (o.locationId && loc.shopmonkey_location_id && o.locationId !== loc.shopmonkey_location_id) continue;
        const invoiced = parseShopmonkeyDate(o.invoicedDate);
        if (!invoiced || invoiced < monthStart || invoiced > now) continue;
        if (isComeback(o)) continue; // comebacks are $0 billed - not "hours sold"

        const techIds = Array.isArray(o.assignedTechnicianIdsArray) ? o.assignedTechnicianIdsArray : [];
        const labourHours = (typeof o.totalLaborHours === 'number' && o.totalLaborHours > 0)
          ? o.totalLaborHours
          : centsToDollars(o.laborCents) / labourRate;
        const labourRev = centsToDollars(o.laborCents);

        if (techIds.length === 0) {
          // unassigned bucket
          const key = 'unassigned';
          if (!byTech[key]) byTech[key] = { tech_id: null, tech_name: 'Unassigned', hours_sold: 0, labour_revenue: 0 };
          byTech[key].hours_sold += labourHours;
          byTech[key].labour_revenue += labourRev;
        } else {
          // split evenly across assigned techs
          const share = 1 / techIds.length;
          for (const tid of techIds) {
            if (!byTech[tid]) byTech[tid] = { tech_id: tid, tech_name: techNames[tid] || `Tech ${String(tid).slice(0, 6)}`, hours_sold: 0, labour_revenue: 0 };
            byTech[tid].hours_sold += labourHours * share;
            byTech[tid].labour_revenue += labourRev * share;
          }
        }
      }

      const techs = Object.values(byTech).map(t => ({
        tech_id: t.tech_id,
        tech_name: t.tech_name,
        hours_available: null,
        hours_worked: null, // pending QBO Time
        hours_sold: Math.round(t.hours_sold * 10) / 10,
        labour_revenue: Math.round(t.labour_revenue * 100) / 100,
        parts_gp: null
      }));

      const date = new Date().toISOString().slice(0, 10);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM tech_efficiency WHERE location_id = $1 AND snapshot_date = $2', [req.params.locationId, date]);
        for (const t of techs) {
          await client.query(
            `INSERT INTO tech_efficiency (location_id, snapshot_date, tech_id, tech_name, hours_available, hours_worked, hours_sold, efficiency, labour_revenue, parts_gp)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [req.params.locationId, date, t.tech_id, t.tech_name, t.hours_available, t.hours_worked, t.hours_sold, null, t.labour_revenue, t.parts_gp]
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
        message: 'Tech efficiency refreshed (hours sold only - hours worked pending QBO Time)',
        techs_found: techs.length,
        techs
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Refresh comebacks ($0 invoices) for a location.
  // These are invoiced orders carrying no charge: warranty re-dos, goodwill
  // work, internal tickets. Tracked as (a) a quality signal - the comeback rate
  // - and (b) cost leakage - unbilled labour hours x tech wage.
  router.post('/:locationId/refresh-comebacks', authenticateToken, async (req, res) => {
    const apiKey = process.env.SHOPMONKEY_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'SHOPMONKEY_API_KEY not configured' });

    try {
      const locResult = await pool.query('SELECT * FROM locations WHERE id = $1', [req.params.locationId]);
      if (!locResult.rows.length) return res.status(404).json({ error: 'Location not found' });
      const loc = locResult.rows[0];
      const labourRate = parseFloat(loc.labour_rate) || 170;
      const techWage = parseFloat(process.env.TECH_WAGE) || 40;

      // Technician name mapping
      let techNames = {};
      try {
        const techRes = await fetch('https://api.shopmonkey.cloud/v3/user?limit=200', {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
        });
        if (techRes.ok) {
          const td = await techRes.json();
          const list = (td && td.data && td.data.data) ? td.data.data : (td.data || []);
          for (const t of list) {
            techNames[t.id] = t.name || [t.firstName, t.lastName].filter(Boolean).join(' ') || 'Unknown';
          }
        }
      } catch (e) { /* optional */ }

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      let orders;
      try {
        orders = await fetchOrdersSince(apiKey, monthStart);
      } catch (e) {
        return res.status(502).json({ error: e.message });
      }

      // Keep this month's comebacks for this location
      const comebacks = orders.filter(o => {
        if (o.locationId && loc.shopmonkey_location_id && o.locationId !== loc.shopmonkey_location_id) return false;
        const invoiced = parseShopmonkeyDate(o.invoicedDate);
        return invoiced && invoiced >= monthStart && invoiced <= now && isComeback(o);
      });

      const rows = comebacks.map(o => {
        const techIds = Array.isArray(o.assignedTechnicianIdsArray) ? o.assignedTechnicianIdsArray : [];
        const techId = techIds[0] || null;
        const techName = techId ? (techNames[techId] || `Tech ${String(techId).slice(0, 6)}`) : 'Unassigned';
        // Labour hours on a $0 order: prefer recorded hours, else fall back to
        // completed/authorized labour hours if present.
        const hours = (typeof o.totalLaborHours === 'number' && o.totalLaborHours > 0)
          ? o.totalLaborHours
          : (typeof o.completedLaborHours === 'number' ? o.completedLaborHours : 0);
        return {
          order_number: o.number != null ? String(o.number) : null,
          order_id: o.id || null,
          invoiced_date: parseShopmonkeyDate(o.invoicedDate),
          customer_name: o.generatedCustomerName || null,
          vehicle_name: o.generatedVehicleName || null,
          tech_id: techId,
          tech_name: techName,
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
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      const totalHours = rows.reduce((s, r) => s + r.labour_hours, 0);
      const totalCost = rows.reduce((s, r) => s + r.unbilled_wage_cost, 0);
      res.json({
        message: 'Comebacks refreshed',
        count: rows.length,
        total_unbilled_hours: Math.round(totalHours * 10) / 10,
        total_unbilled_wage_cost: Math.round(totalCost * 100) / 100,
        comebacks: rows
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Read the latest comebacks snapshot for a location (current month).
  router.get('/:locationId/comebacks', authenticateToken, async (req, res) => {
    try {
      const latest = await pool.query(
        'SELECT MAX(snapshot_date) AS d FROM comebacks WHERE location_id = $1',
        [req.params.locationId]
      );
      const d = latest.rows[0] && latest.rows[0].d;
      if (!d) return res.json({ snapshot_date: null, count: 0, total_unbilled_hours: 0, total_unbilled_wage_cost: 0, comebacks: [] });

      const result = await pool.query(
        `SELECT order_number, order_id, invoiced_date, customer_name, vehicle_name, tech_name, labour_hours, unbilled_wage_cost, complaint
         FROM comebacks WHERE location_id = $1 AND snapshot_date = $2
         ORDER BY unbilled_wage_cost DESC, invoiced_date DESC`,
        [req.params.locationId, d]
      );
      const totalHours = result.rows.reduce((s, r) => s + Number(r.labour_hours || 0), 0);
      const totalCost = result.rows.reduce((s, r) => s + Number(r.unbilled_wage_cost || 0), 0);

      // per-tech rollup (which tech has the most comebacks)
      const byTech = {};
      for (const r of result.rows) {
        const k = r.tech_name || 'Unassigned';
        if (!byTech[k]) byTech[k] = { tech_name: k, count: 0, hours: 0, cost: 0 };
        byTech[k].count++;
        byTech[k].hours += Number(r.labour_hours || 0);
        byTech[k].cost += Number(r.unbilled_wage_cost || 0);
      }

      res.json({
        snapshot_date: d,
        count: result.rows.length,
        total_unbilled_hours: Math.round(totalHours * 10) / 10,
        total_unbilled_wage_cost: Math.round(totalCost * 100) / 100,
        by_tech: Object.values(byTech).sort((a, b) => b.count - a.count),
        comebacks: result.rows
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
