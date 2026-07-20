// Shared ShopMonkey read helpers for features beyond the metrics sync.
// The core fetchers (sweepOrders pagination, date/cents helpers) mirror the
// proven versions in server/routes/shopmonkeySync.js — kept as separate copies
// here to avoid touching the live money-math file; de-dupe into one module in a
// later dedicated pass (with full metrics verification). Read-only.

const SM = 'https://api.shopmonkey.cloud/v3';
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseShopmonkeyDate(str) {
  if (!str || str === 'empty') return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}
const centsToDollars = (c) => (typeof c === 'number' ? c : 0) / 100;

// Month start anchored to the shop's timezone (Mountain), not the server's UTC.
function monthStartFor(now, tz = 'America/Edmonton') {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric' }).formatToParts(now);
  const y = +parts.find((p) => p.type === 'year').value;
  const m = +parts.find((p) => p.type === 'month').value;
  const guess = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const local = new Date(guess.toLocaleString('en-US', { timeZone: tz }));
  return new Date(guess.getTime() + (guess.getTime() - local.getTime()));
}

// ShopMonkey's /v3/order query is flaky (varying partial subsets, page cap 100,
// skip gaps); the UNION of repeated sweeps converges to meta.total. Sweep+union
// by id until complete, then complete-or-throw so callers never get partial data.
async function sweepOrders(apiKey, { where, locationId, maxSweeps = 5 }) {
  const whereStr = JSON.stringify(where);
  const sort = JSON.stringify([{ name: 'createdDate', order: 'asc' }]);
  const byId = new Map();
  let total = null;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    for (let skip = 0; skip < 5000; skip += 100) {
      const params = { where: whereStr, limit: '100', skip: String(skip), sort };
      if (locationId) params.locationId = locationId;
      const res = await fetch(`${SM}/order?${new URLSearchParams(params)}`, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      });
      if (!res.ok) { const txt = await res.text(); throw new Error(`Shopmonkey API error ${res.status}: ${txt.slice(0, 200)}`); }
      const b = await res.json();
      const meta = b.meta || (b.data && b.data.meta) || null;
      if (meta && typeof meta.total === 'number') total = meta.total;
      const batch = Array.isArray(b.data) ? b.data : (b.data && b.data.data) || [];
      for (const o of batch) if (o && o.id) byId.set(o.id, o);
      if (batch.length < 100) break;
      await _sleep(120);
    }
    if (total !== null && byId.size >= total) break;
    await _sleep(200);
  }
  if (total === null && byId.size === 0) throw new Error('Shopmonkey returned no orders and no meta (throttled/failed)');
  if (total !== null && byId.size < total) throw new Error(`Shopmonkey incomplete: ${byId.size}/${total} orders (throttled?)`);
  return { orders: [...byId.values()], total };
}

// Invoiced, non-deleted orders for ONE shopmonkey location since a date.
async function fetchInvoicedOrdersForLocation(apiKey, smLocationId, sinceDate) {
  const { orders, total } = await sweepOrders(apiKey, { where: { invoicedDate: { gte: sinceDate.toISOString() } }, locationId: smLocationId });
  const filtered = orders.filter((o) => !o.deleted && o.invoicedDate && o.invoicedDate !== 'empty'
    && (!o.locationId || o.locationId === smLocationId));
  if (filtered.length === 0 && total !== 0) throw new Error(`Shopmonkey returned no invoiced orders (total=${total}) — refusing to report empty`);
  return filtered;
}

// Exact order lookup by its number (string — integer 400s). Cheap, 1 call.
async function fetchOrderByNumber(apiKey, smLocationId, number) {
  const p = new URLSearchParams({ where: JSON.stringify({ number: String(number) }), limit: '5' });
  const r = await fetch(`${SM}/order?${p}`, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`order by number ${r.status}`);
  const b = await r.json();
  const d = Array.isArray(b.data) ? b.data : (b.data && b.data.data) || [];
  return d.filter((o) => !o.deleted && (!o.locationId || o.locationId === smLocationId));
}

// Most-recent invoiced orders for a location (single/few pages, NOT a full
// sweep) — used to resolve a last-4 RO ref without the heavy sweep. Sort JSON
// (separate sort/order params are ignored and return garbage).
async function fetchRecentInvoicedOrders(apiKey, smLocationId, limit = 150) {
  const sort = JSON.stringify([{ name: 'invoicedDate', order: 'desc' }]);
  const where = JSON.stringify({ invoicedDate: { gte: '2000-01-01T00:00:00.000Z' } });
  const out = [];
  for (let skip = 0; skip < limit; skip += 100) {
    const p = new URLSearchParams({ where, limit: '100', skip: String(skip), sort, locationId: smLocationId });
    const r = await fetch(`${SM}/order?${p}`, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error(`recent orders ${r.status}`);
    const b = await r.json();
    const batch = Array.isArray(b.data) ? b.data : (b.data && b.data.data) || [];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out.filter((o) => !o.deleted && o.invoicedDate && (!o.locationId || o.locationId === smLocationId));
}

// One order's service lines (each carries labors[] + parts[]). limit 100.
async function fetchOrderService(apiKey, orderId) {
  const res = await fetch(`${SM}/order/${orderId}/service?limit=100`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`service ${res.status}`);
  const j = await res.json();
  return (j && j.data && j.data.data) ? j.data.data : (j.data || []);
}

module.exports = { parseShopmonkeyDate, centsToDollars, monthStartFor, sweepOrders, fetchInvoicedOrdersForLocation, fetchOrderService, fetchOrderByNumber, fetchRecentInvoicedOrders };
