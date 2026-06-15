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

      // Pull invoiced, non-archived orders from Shopmonkey
      const params = new URLSearchParams({
        where: JSON.stringify({ invoiced: true, archived: false, deleted: false }),
        limit: '100'
      });
      const smRes = await fetch(`https://api.shopmonkey.cloud/v3/order?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
      });
      if (!smRes.ok) {
        const txt = await smRes.text();
        return res.status(502).json({ error: `Shopmonkey API error ${smRes.status}`, detail: txt.slice(0, 300) });
      }
      const smData = await smRes.json();
      const orders = (smData && smData.data && smData.data.data) ? smData.data.data : (smData.data || []);

      // Current month boundaries
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      // Filter to this month's invoiced orders for this location
      const mtdOrders = orders.filter(o => {
        if (o.locationId && loc.shopmonkey_location_id && o.locationId !== loc.shopmonkey_location_id) return false;
        const created = parseShopmonkeyDate(o.createdDate);
        return created && created >= monthStart && created <= now;
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
        const techRes = await fetch('https://api.shopmonkey.cloud/v3/technician?limit=100', {
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

      // Pull this month's invoiced orders
      const params = new URLSearchParams({
        where: JSON.stringify({ invoiced: true, archived: false, deleted: false }),
        limit: '100'
      });
      const smRes = await fetch(`https://api.shopmonkey.cloud/v3/order?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
      });
      if (!smRes.ok) {
        const txt = await smRes.text();
        return res.status(502).json({ error: `Shopmonkey API error ${smRes.status}`, detail: txt.slice(0, 300) });
      }
      const smData = await smRes.json();
      const orders = (smData && smData.data && smData.data.data) ? smData.data.data : (smData.data || []);

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      // Aggregate hours sold + labour revenue per technician
      const byTech = {};
      for (const o of orders) {
        if (o.locationId && loc.shopmonkey_location_id && o.locationId !== loc.shopmonkey_location_id) continue;
        const created = parseShopmonkeyDate(o.createdDate);
        if (!created || created < monthStart || created > now) continue;

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

  return router;
};
