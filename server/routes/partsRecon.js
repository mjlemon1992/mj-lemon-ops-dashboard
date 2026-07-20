const express = require('express');
const { authenticateToken, requireRole, canAccessLocation } = require('../middleware/auth');
const { monthStartFor, fetchInvoicedOrdersForLocation, fetchOrderService } = require('../lib/shopmonkey');

// Parts reconciliation — v1a: ShopMonkey-only parts margin / exposure per RO.
// For each invoiced order in the window, compare each part's wholesale cost
// (what we paid) to its retail (what we billed) and classify:
//   leak / under_billed / bundled / ok.  Flagged rows can be actioned:
//   opened in Shopmonkey (deep link) or marked reviewed (with a reason) so they
//   drop off the worklist. Read-only against ShopMonkey; owner/partner; scoped.
module.exports = (pool) => {
  const router = express.Router();
  const fail = (res, e, code = 500) => res.status(code).json({ error: String(e.message || e) });
  const cache = new Map();
  const TTL = 10 * 60 * 1000;
  const MAX_ORDERS = 600;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const REASONS = ['warranty', 'rebilled', 'vendor_query', 'ignore'];
  const ORDER_URL = process.env.SHOPMONKEY_ORDER_URL_TEMPLATE || 'https://app.shopmonkey.cloud/#/orders/{id}';

  let _ensured;
  const ensure = () => {
    if (!_ensured) _ensured = pool.query(`CREATE TABLE IF NOT EXISTS parts_flag_review (
      location_id UUID NOT NULL,
      order_id TEXT NOT NULL,
      part_id TEXT NOT NULL,
      part_number TEXT,
      part_name TEXT,
      reason VARCHAR(20),
      reviewed_by VARCHAR(200),
      reviewed_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (location_id, order_id, part_id)
    )`).catch((e) => { _ensured = null; throw e; });
    return _ensured;
  };

  // Build (or reuse cached) the raw flagged-parts scan from ShopMonkey.
  const rawScan = async (loc, apiKey, since) => {
    const ckey = `${loc.id}|${since.toISOString().slice(0, 10)}`;
    const hit = cache.get(ckey);
    if (hit && Date.now() - hit.at < TTL) return hit.data;

    const orders = await fetchInvoicedOrdersForLocation(apiKey, loc.shopmonkey_location_id, since);
    const scan = orders.slice(0, MAX_ORDERS);
    const items = [];
    let svcFail = 0;
    for (const o of scan) {
      let lines;
      try { lines = await fetchOrderService(apiKey, o.id); } catch { svcFail++; continue; }
      for (const ln of lines) {
        const parentPriced = !!(ln.lumpSum || (ln.fixedPriceCents || 0) > 0 || (ln.totalCents || 0) > 0);
        for (const p of (ln.parts || [])) {
          const qty = Number(p.quantity) || 1;
          const cost = (Number(p.wholesaleCostCents || p.originalWholesaleCostCents || 0)) * qty;
          const retail = (Number(p.retailCostCents || 0)) * qty;
          if (cost <= 0 && retail <= 0) continue;
          let cls = 'ok', exposure = 0;
          if (cost > 0 && retail <= 0) { if (parentPriced) cls = 'bundled'; else { cls = 'leak'; exposure = cost; } }
          else if (cost > 0 && retail > 0 && retail < cost) { cls = 'under_billed'; exposure = cost - retail; }
          if (cls === 'ok') continue;
          items.push({
            order_number: o.number != null ? String(o.number) : o.id, order_id: o.id,
            part_id: p.id || `${o.id}:${p.partNumber || p.name}`,
            invoiced_date: o.invoicedDate, service: ln.name || null,
            part_name: p.name || 'Part', part_number: p.partNumber || p.number || null, qty,
            cost: Math.round(cost) / 100, retail: Math.round(retail) / 100,
            margin_pct: retail > 0 ? Math.round(((retail - cost) / retail) * 100) : null,
            class: cls, exposure: Math.round(exposure) / 100,
          });
        }
      }
      await sleep(80);
    }
    const data = {
      window: { since: since.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
      orders_scanned: scan.length, orders_total: orders.length, capped: orders.length > MAX_ORDERS,
      service_fetch_failed: svcFail, raw_items: items, generated_at: new Date().toISOString(),
    };
    cache.set(ckey, { at: Date.now(), data });
    return data;
  };

  router.get('/:locationId/margin', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    if (!canAccessLocation(req.user, req.params.locationId)) return fail(res, 'Access denied for this location', 403);
    try {
      await ensure();
      const { rows } = await pool.query('SELECT id, name, shopmonkey_location_id FROM locations WHERE id=$1', [req.params.locationId]);
      if (!rows.length) return fail(res, 'Location not found', 404);
      const loc = rows[0];
      if (!loc.shopmonkey_location_id) return res.json({ connected: false, location: loc.name, message: `${loc.name} isn't connected to Shopmonkey yet — no parts data to reconcile.` });
      const apiKey = process.env.SHOPMONKEY_API_KEY;
      if (!apiKey) return fail(res, 'SHOPMONKEY_API_KEY not configured');

      const since = /^\d{4}-\d{2}-\d{2}$/.test(req.query.since || '') ? new Date(req.query.since + 'T00:00:00Z') : monthStartFor(new Date());
      if (req.query.fresh != null) cache.delete(`${loc.id}|${since.toISOString().slice(0, 10)}`);
      const scan = await rawScan(loc, apiKey, since);

      // Reviews are applied per-request (cheap) so dismissing is instant even
      // while the expensive ShopMonkey scan stays cached.
      const { rows: rv } = await pool.query('SELECT order_id, part_id, reason FROM parts_flag_review WHERE location_id=$1', [loc.id]);
      const reviewedBy = new Map(rv.map((r) => [`${r.order_id}|${r.part_id}`, r.reason]));
      const active = [], reviewed = [];
      for (const it of scan.raw_items) {
        const rr = reviewedBy.get(`${it.order_id}|${it.part_id}`);
        const row = { ...it, sm_url: ORDER_URL.replace('{id}', it.order_id) };
        if (rr) reviewed.push({ ...row, reason: rr }); else active.push(row);
      }
      const summary = { parts: scan.raw_items.length, leak_count: 0, leak_exposure: 0, underbilled_count: 0, underbilled_exposure: 0, bundled_count: 0 };
      for (const it of active) {
        if (it.class === 'leak') { summary.leak_count++; summary.leak_exposure += it.exposure; }
        else if (it.class === 'under_billed') { summary.underbilled_count++; summary.underbilled_exposure += it.exposure; }
        else if (it.class === 'bundled') summary.bundled_count++;
      }
      summary.leak_exposure = Math.round(summary.leak_exposure * 100) / 100;
      summary.underbilled_exposure = Math.round(summary.underbilled_exposure * 100) / 100;
      active.sort((a, b) => (b.exposure - a.exposure) || (a.class === 'leak' ? -1 : 1));

      res.json({
        connected: true, location: loc.name, window: scan.window,
        orders_scanned: scan.orders_scanned, orders_total: scan.orders_total, capped: scan.capped,
        service_fetch_failed: scan.service_fetch_failed, generated_at: scan.generated_at,
        summary, items: active.slice(0, 300), reviewed: reviewed.slice(0, 300), reviewed_count: reviewed.length,
      });
    } catch (e) { fail(res, e, /incomplete|throttl|refusing|no orders/i.test(String(e.message)) ? 502 : 500); }
  });

  // Mark a flagged part reviewed (with a reason) so it clears the worklist, or undo.
  router.put('/:locationId/review', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    if (!canAccessLocation(req.user, req.params.locationId)) return fail(res, 'Access denied for this location', 403);
    try {
      await ensure();
      const b = req.body || {};
      if (!b.order_id || !b.part_id) return fail(res, 'order_id + part_id required', 400);
      if (b.undo) {
        await pool.query('DELETE FROM parts_flag_review WHERE location_id=$1 AND order_id=$2 AND part_id=$3', [req.params.locationId, String(b.order_id), String(b.part_id)]);
        return res.json({ ok: true, undone: true });
      }
      const reason = REASONS.includes(b.reason) ? b.reason : 'ignore';
      await pool.query(
        `INSERT INTO parts_flag_review (location_id, order_id, part_id, part_number, part_name, reason, reviewed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (location_id, order_id, part_id) DO UPDATE SET reason=EXCLUDED.reason, reviewed_by=EXCLUDED.reviewed_by, reviewed_at=now()`,
        [req.params.locationId, String(b.order_id), String(b.part_id), b.part_number || null, b.part_name || null, reason, req.user.email || req.user.name || 'owner']);
      res.json({ ok: true, reason });
    } catch (e) { fail(res, e); }
  });

  return router;
};
