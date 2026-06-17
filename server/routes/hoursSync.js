const express = require('express');
const { authenticateToken } = require('../middleware/auth');

const centsToDollars = (c) => (Number(c) || 0) / 100;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const HOLIDAYS = {
  ab: { 2026: ['2026-01-01','2026-02-16','2026-04-03','2026-05-18','2026-07-01','2026-09-07','2026-10-12','2026-11-11','2026-12-25','2026-12-28'] },
  bc: { 2026: ['2026-01-01','2026-02-16','2026-04-03','2026-05-18','2026-07-01','2026-08-03','2026-09-07','2026-09-30','2026-10-12','2026-11-11','2026-12-25','2026-12-28'] }
};
function holidaySetSrv(province, year) {
  const prov = (province || 'ab').toLowerCase();
  const list = (HOLIDAYS[prov] && HOLIDAYS[prov][year]) || (HOLIDAYS.ab[year] || []);
  return new Set(list);
}
// Working days (Mon-Fri minus stat holidays) in [startStr..endStr] inclusive.
// Spans months/years; province-aware. Worked hours = result x 8 (40/wk over 5 days).
function workingDaysInRange(province, startStr, endStr) {
  const start = new Date(startStr + 'T00:00:00Z');
  const end = new Date(endStr + 'T00:00:00Z');
  let n = 0; const hy = {};
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const d = new Date(t); const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const y = d.getUTCFullYear();
    if (!hy[y]) hy[y] = holidaySetSrv(province, y);
    const iso = `${y}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    if (hy[y].has(iso)) continue;
    n++;
  }
  return n;
}

// Resilient Shopmonkey fetch: retries on 429/5xx with backoff (honouring
// Retry-After), and ultimately throws rather than letting a caller silently
// skip an order. This is what stops the recompute from quietly undercounting.
async function smFetch(url, opts, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, opts);
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get('retry-after'));
      const wait = ra > 0 ? ra * 1000 : Math.min(8000, 400 * Math.pow(2, i));
      await sleep(wait);
      continue;
    }
    return res;
  }
  throw new Error(`Shopmonkey rate-limited after ${tries} retries: ${url}`);
}

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
    const res = await smFetch(`https://api.shopmonkey.cloud/v3/order?${params}`, {
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
    const sr = await smFetch(`https://api.shopmonkey.cloud/v3/order/${o.id}/service?limit=100`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });
    if (sr.status === 404) { await sleep(60); continue; }
    if (!sr.ok) throw new Error(`service fetch ${sr.status} for order ${o.id}`);
    const sj = await sr.json();
    lines = (sj && sj.data && sj.data.data) ? sj.data.data : (sj.data || []);
    await sleep(60);
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
      let { period_start, period_end, period_type } = req.body || {};
      period_type = (period_type === 'ytd') ? 'ytd' : 'mtd';
      const now = new Date();
      if (!period_start || !period_end) {
        const y = now.getUTCFullYear();
        const m0 = (period_type === 'ytd') ? 0 : now.getUTCMonth();
        period_start = new Date(Date.UTC(y, m0, 1)).toISOString().slice(0, 10);
        period_end = now.toISOString().slice(0, 10);
      }
      const startIso = new Date(period_start + 'T00:00:00.000Z').toISOString();
      const endIso = new Date(period_end + 'T23:59:59.999Z').toISOString();

      // Worked hours = working days elapsed in [start..end] x 8 (holiday + province aware, uniform per tech).
      const locRes = await pool.query('SELECT province FROM locations WHERE id = $1', [req.params.locationId]);
      const province = (locRes.rows[0] && locRes.rows[0].province) || 'ab';
      const workedHours = workingDaysInRange(province, period_start, period_end) * 8;

      const techNames = await fetchTechNames(pool, req.params.locationId);
      const orders = await fetchInvoicedOrdersBetween(apiKey, startIso, endIso);
      const sold = await computeTechSold(apiKey, orders, techNames);

      const written = [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE tech_efficiency ADD COLUMN IF NOT EXISTS period_type VARCHAR(8)');
        await client.query('DELETE FROM tech_efficiency WHERE location_id = $1 AND snapshot_date = $2 AND period_type = $3', [req.params.locationId, period_end, period_type]);
        for (const t of sold) {
          const efficiency = workedHours > 0 ? Math.round((t.hours_sold / workedHours) * 100) : null;
          await client.query(
            `INSERT INTO tech_efficiency
               (location_id, snapshot_date, period_type, tech_id, tech_name, hours_available, hours_worked, hours_sold, hours_billed, vehicle_count, efficiency, labour_revenue, parts_gp)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [req.params.locationId, period_end, period_type, t.tech_id || null, t.tech_name, null, workedHours, t.hours_sold, t.hours_billed, t.vehicle_count, efficiency, t.labour_revenue, null]
          );
          written.push({ tech_name: t.tech_name, hours_sold: t.hours_sold, hours_worked: workedHours, efficiency });
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      res.json({ ok: true, period_type, period_start, period_end, worked_hours: workedHours, count: written.length, written });
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  return router;
};
