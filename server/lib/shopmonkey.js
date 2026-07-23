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

// Most-recent orders for a location across ALL statuses (open estimates too),
// createdDate desc. Used to sample the RO-number format and as a suffix-scan
// fallback when matching a short "PO" to its full work-order number.
async function fetchRecentOrders(apiKey, smLocationId, limit = 100) {
  const sort = JSON.stringify([{ name: 'createdDate', order: 'desc' }]);
  const where = JSON.stringify({ createdDate: { gte: '2000-01-01T00:00:00.000Z' } });
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
  return out.filter((o) => !o.deleted && (!o.locationId || o.locationId === smLocationId));
}

// First instant (UTC) of a 'YYYY-MM' month, anchored to the shop timezone.
function monthStartUtcFor(ym, tz = 'America/Edmonton') {
  const [y, m] = String(ym).split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const local = new Date(guess.toLocaleString('en-US', { timeZone: tz }));
  return new Date(guess.getTime() + (guess.getTime() - local.getTime()));
}
// Same 5-component pre-tax subtotal the MTD metric + bonus target check use.
const _subtotalCents = (o) => (o.partsCents || 0) + (o.laborCents || 0) + (o.shopSuppliesCents || 0) + (o.subcontractsCents || 0) + (o.tiresCents || 0);

// Actual revenue bucketed by shop-tz invoiced month, for [startYm, endYmExclusive).
// One sweep from startYm; comebacks ($0 subtotal) excluded, matching the sales
// definition everywhere else. Returns { 'YYYY-MM': dollars, ... } (missing month = absent).
async function actualRevenueByMonth(apiKey, smLocationId, startYm, endYmExclusive, tz = 'America/Edmonton') {
  const start = monthStartUtcFor(startYm, tz);
  const end = monthStartUtcFor(endYmExclusive, tz);
  const { orders } = await sweepOrders(apiKey, { where: { invoicedDate: { gte: start.toISOString() } }, locationId: smLocationId });
  const monthKey = (d) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(d);
    return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}`;
  };
  const cents = {};
  for (const o of orders) {
    if (o.deleted || !o.invoicedDate || o.invoicedDate === 'empty') continue;
    if (o.locationId && o.locationId !== smLocationId) continue;
    const inv = new Date(o.invoicedDate);
    if (isNaN(inv) || inv < start || inv >= end) continue;
    const sub = _subtotalCents(o);
    if (sub === 0) continue;
    const k = monthKey(inv);
    cents[k] = (cents[k] || 0) + sub;
  }
  const out = {};
  for (const k of Object.keys(cents)) out[k] = Math.round(cents[k]) / 100;
  return out;
}

// Same sweep as actualRevenueByMonth but returns { 'YYYY-MM': { revenue, cars } }
// — cars = invoiced order count, the dashboard's car-count definition. One sweep
// covers any span (e.g. last year + this year for the Goals board), so callers
// batch the whole range rather than sweeping per month.
async function actualsByMonth(apiKey, smLocationId, startYm, endYmExclusive, tz = 'America/Edmonton') {
  const start = monthStartUtcFor(startYm, tz);
  const end = monthStartUtcFor(endYmExclusive, tz);
  const { orders } = await sweepOrders(apiKey, { where: { invoicedDate: { gte: start.toISOString() } }, locationId: smLocationId });
  const monthKey = (d) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(d);
    return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}`;
  };
  const agg = {};
  for (const o of orders) {
    if (o.deleted || !o.invoicedDate || o.invoicedDate === 'empty') continue;
    if (o.locationId && o.locationId !== smLocationId) continue;
    const inv = new Date(o.invoicedDate);
    if (isNaN(inv) || inv < start || inv >= end) continue;
    const sub = _subtotalCents(o);
    if (sub === 0) continue;
    const k = monthKey(inv);
    if (!agg[k]) agg[k] = { cents: 0, cars: 0 };
    agg[k].cents += sub;
    agg[k].cars += 1;
  }
  const out = {};
  for (const k of Object.keys(agg)) out[k] = { revenue: Math.round(agg[k].cents) / 100, cars: agg[k].cars };
  return out;
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

module.exports = { parseShopmonkeyDate, centsToDollars, monthStartFor, monthStartUtcFor, actualRevenueByMonth, actualsByMonth, sweepOrders, fetchInvoicedOrdersForLocation, fetchOrderService, fetchOrderByNumber, fetchRecentInvoicedOrders, fetchRecentOrders };
