const express = require('express');
const { authenticateToken } = require('../middleware/auth');

const centsToDollars = (c) => (Number(c) || 0) / 100;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

async function fetchTechNames(pool, locationId) {
  const map = {};
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (tech_id) tech_id, tech_name
         FROM tech_efficiency
        WHERE location_id = $1 AND tech_id IS NOT NULL
        ORDER BY tech_id, snapshot_date DESC`,
      [locationId]
    );
    for (const r of rows) if (r.tech_id && r.tech_name) map[r.tech_id] = r.tech_name;
  } catch (e) { /* fall back to ids */ }
  return map;
}

async function fetchInvoicedOrdersBetween(apiKey, startIso, endIso, maxPages = 40) {
  const pageSize = 100;
  let all = [];
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      where: JSON.stringify({ invoicedDate: { gte: startIso, lte: endIso } }),
      limit: String(pageSize),
      skip: String(page * pageSize)
    });
    const res = await fetch(`https://api.shopmonkey.cloud/v3/order?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error(`order list ${res.status}: ${await res.text()}`);
    const j = await res.json();
    const rows = (j && j.data && j.data.data) ? j.data.data : (j.data || []);
    all = all.concat(rows);
    const meta = j.meta || (j.data && j.data.meta) || {};
    if (!meta.hasMore || rows.length === 0) break;
  }
  return all;
}

async function computeTechSold(apiKey, orders, techNames) {
  const byTech = {};
  const ensure = (id, name) => {
    if (!byTech[id]) byTech[id] = {
      tech_id: id, tech_name: name, hours_sold: 0, hours_billed: 0,
      labour_revenue: 0, _vehicles: new Set()
    };
    return byTech[id];
  };
  for (const o of orders) {
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
  return Object.values(byTech).map(t => ({
    tech_id: t.tech_id,
    tech_name: t.tech_name,
    hours_sold: Math.round(t.hours_sold * 100) / 100,
    hours_billed: Math.round(t.hours_billed * 100) / 100,
    labour_revenue: Math.round(t.labour_revenue * 100) / 100,
    vehicle_count: t._vehicles.size
  }));
}

module.exports = (pool) => {
  const router = express.Router();

  const syncAuth = (req, res, next) => {
    const secret = process.env.SYNC_SECRET;
    const provided = req.get('X-Sync-Key');
    if (secret && provided && provided === secret) {
      req.user = { role: 'owner', via: 'sync-key' };
      return next();
    }
    return authenticateToken(req, res, next);
  };

  router.get('/:locationId/sold-probe', syncAuth, async (req, res) => {
    const apiKey = process.env.SHOPMONKEY_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'SHOPMONKEY_API_KEY not configured' });
    try {
      const { start, end } = req.query;
      if (!start || !end) return res.status(400).json({ error: 'start & end (YYYY-MM-DD) required' });
      const startIso = new Date(start + 'T00:00:00.000Z').toISOString();
      const endIso = new Date(end + 'T23:59:59.999Z').toISOString();
      const techNames = await fetchTechNames(pool, req.params.locationId);
      const orders = await fetchInvoicedOrdersBetween(apiKey, startIso, endIso);
      const sold = await computeTechSold(apiKey, orders, techNames);
      const totalSold = Math.round(sold.reduce((s, t) => s + t.hours_sold, 0) * 100) / 100;
      res.json({ start, end, orders: orders.length, totalSold, techs: sold.sort((a, b) => b.hours_sold - a.hours_sold) });
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  router.post('/:locationId/import', syncAuth, async (req, res) => {
    const apiKey = process.env.SHOPMONKEY_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'SHOPMONKEY_API_KEY not configured' });
    try {
      const { period_start, period_end, rows } = req.body || {};
      if (!period_start || !period_end || !Array.isArray(rows) || !rows.length)
        return res.status(400).json({ error: 'period_start, period_end, rows[{tech_name,hours_worked}] required' });
      const startIso = new Date(period_start + 'T00:00:00.000Z').toISOString();
      const endIso = new Date(period_end + 'T23:59:59.999Z').toISOString();

      const techNames = await fetchTechNames(pool, req.params.locationId);
      const orders = await fetchInvoicedOrdersBetween(apiKey, startIso, endIso);
      const sold = await computeTechSold(apiKey, orders, techNames);
      const soldByName = {};
      for (const t of sold) soldByName[norm(t.tech_name)] = t;

      const matched = [], unmatched = [];
      for (const r of rows) {
        const s = soldByName[norm(r.tech_name)];
        const worked = Number(r.hours_worked) || 0;
        if (!s) { unmatched.push(r.tech_name); continue; }
        const efficiency = worked > 0 ? Math.round((s.hours_sold / worked) * 100) : null;
        matched.push({ ...s, hours_worked: worked, efficiency });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'DELETE FROM tech_efficiency WHERE location_id = $1 AND snapshot_date = $2',
          [req.params.locationId, period_end]
        );
        for (const m of matched) {
          await client.query(
            `INSERT INTO tech_efficiency
               (location_id, snapshot_date, tech_id, tech_name, hours_available, hours_worked, hours_sold, hours_billed, vehicle_count, efficiency, labour_revenue, parts_gp)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [req.params.locationId, period_end, m.tech_id || null, m.tech_name, null, m.hours_worked, m.hours_sold, m.hours_billed, m.vehicle_count, m.efficiency, m.labour_revenue, null]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      res.json({ ok: true, period_start, period_end, written: matched.length, unmatched, matched });
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  // Recompute efficiency from stored weekly hours (model A).
  // worked = weekly_hours x weeks_in_period; sold/billed/vehicles computed over
  // the same window; joined to weekly hours by tech_id. Defaults to current month.
  router.post('/:locationId/recompute-from-weekly', syncAuth, async (req, res) => {
    const apiKey = process.env.SHOPMONKEY_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'SHOPMONKEY_API_KEY not configured' });
    try {
      let { period_start, period_end } = req.body || {};
      if (!period_start || !period_end) {
        const now = new Date();
        period_start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
        period_end = now.toISOString().slice(0, 10);
      }
      const startIso = new Date(period_start + 'T00:00:00.000Z').toISOString();
      const endIso = new Date(period_end + 'T23:59:59.999Z').toISOString();
      const days = Math.max(1, Math.round((new Date(endIso) - new Date(startIso)) / 86400000) + 1);
      const weeks = days / 7;

      const whRes = await pool.query('SELECT tech_id, hours_per_week FROM tech_weekly_hours WHERE location_id = $1', [req.params.locationId]);
      const weeklyByTech = {};
      for (const r of whRes.rows) if (r.hours_per_week != null) weeklyByTech[r.tech_id] = Number(r.hours_per_week);

      const techNames = await fetchTechNames(pool, req.params.locationId);
      const orders = await fetchInvoicedOrdersBetween(apiKey, startIso, endIso);
      const sold = await computeTechSold(apiKey, orders, techNames);

      const written = [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM tech_efficiency WHERE location_id = $1 AND snapshot_date = $2', [req.params.locationId, period_end]);
        for (const t of sold) {
          const weekly = weeklyByTech[t.tech_id];
          const worked = weekly != null ? Math.round(weekly * weeks * 100) / 100 : null;
          const efficiency = worked && worked > 0 ? Math.round((t.hours_sold / worked) * 100) : null;
          await client.query(
            `INSERT INTO tech_efficiency
               (location_id, snapshot_date, tech_id, tech_name, hours_available, hours_worked, hours_sold, hours_billed, vehicle_count, efficiency, labour_revenue, parts_gp)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [req.params.locationId, period_end, t.tech_id || null, t.tech_name, null, worked, t.hours_sold, t.hours_billed, t.vehicle_count, efficiency, t.labour_revenue, null]
          );
          written.push({ tech_name: t.tech_name, hours_sold: t.hours_sold, hours_worked: worked, efficiency });
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      res.json({ ok: true, period_start, period_end, weeks: Math.round(weeks * 100) / 100, count: written.length, written });
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  return router;
};
