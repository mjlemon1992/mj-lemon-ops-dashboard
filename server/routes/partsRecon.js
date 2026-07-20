const express = require('express');
const { authenticateToken, requireRole, canAccessLocation } = require('../middleware/auth');
const { monthStartFor, fetchInvoicedOrdersForLocation, fetchOrderService } = require('../lib/shopmonkey');

// Parts reconciliation — v1a: ShopMonkey-only parts margin / exposure per RO.
// For each invoiced order in the window, compare each part's wholesale cost
// (what we paid) to its retail (what we billed) and classify:
//   leak         — paid, $0 retail, NOT under a priced/flat-rate service
//   under_billed — billed below cost (losing money on the part)
//   bundled      — $0 retail but under a lump-sum/flat-rate service (legit; informational)
//   ok           — healthy margin
// Read-only; owner/partner; location-scoped. 10-min in-memory cache per shop+window.
module.exports = (pool) => {
  const router = express.Router();
  const fail = (res, e, code = 500) => res.status(code).json({ error: String(e.message || e) });
  const cache = new Map();
  const TTL = 10 * 60 * 1000;
  const MAX_ORDERS = 600;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  router.get('/:locationId/margin', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    if (!canAccessLocation(req.user, req.params.locationId)) return fail(res, 'Access denied for this location', 403);
    try {
      const { rows } = await pool.query('SELECT id, name, shopmonkey_location_id FROM locations WHERE id=$1', [req.params.locationId]);
      if (!rows.length) return fail(res, 'Location not found', 404);
      const loc = rows[0];
      if (!loc.shopmonkey_location_id) {
        return res.json({ connected: false, location: loc.name, message: `${loc.name} isn't connected to Shopmonkey yet — no parts data to reconcile.` });
      }
      const apiKey = process.env.SHOPMONKEY_API_KEY;
      if (!apiKey) return fail(res, 'SHOPMONKEY_API_KEY not configured');

      const since = /^\d{4}-\d{2}-\d{2}$/.test(req.query.since || '')
        ? new Date(req.query.since + 'T00:00:00Z') : monthStartFor(new Date());
      const ckey = `${loc.id}|${since.toISOString().slice(0, 10)}`;
      const hit = cache.get(ckey);
      if (hit && Date.now() - hit.at < TTL && req.query.fresh == null) return res.json({ ...hit.data, cached: true });

      const orders = await fetchInvoicedOrdersForLocation(apiKey, loc.shopmonkey_location_id, since);
      const scan = orders.slice(0, MAX_ORDERS);
      const items = [];
      const summary = { parts: 0, leak_count: 0, leak_exposure: 0, underbilled_count: 0, underbilled_exposure: 0, bundled_count: 0, ok_count: 0 };
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
            if (cost <= 0 && retail <= 0) continue;   // no data to judge
            summary.parts++;
            let cls = 'ok', exposure = 0;
            if (cost > 0 && retail <= 0) {
              if (parentPriced) { cls = 'bundled'; summary.bundled_count++; }
              else { cls = 'leak'; exposure = cost; summary.leak_count++; summary.leak_exposure += cost; }
            } else if (cost > 0 && retail > 0 && retail < cost) {
              cls = 'under_billed'; exposure = cost - retail; summary.underbilled_count++; summary.underbilled_exposure += exposure;
            } else { summary.ok_count++; }
            if (cls !== 'ok') {
              items.push({
                order_number: o.number != null ? String(o.number) : o.id,
                order_id: o.id, invoiced_date: o.invoicedDate,
                service: ln.name || null, part_name: p.name || 'Part',
                part_number: p.partNumber || p.number || null, qty,
                cost: Math.round(cost) / 100, retail: Math.round(retail) / 100,
                margin_pct: retail > 0 ? Math.round(((retail - cost) / retail) * 100) : null,
                class: cls, exposure: Math.round(exposure) / 100,
              });
            }
          }
        }
        await sleep(80);   // gentle on the rate limiter across ~40+ service calls
      }
      items.sort((a, b) => (b.exposure - a.exposure) || (a.class === 'leak' ? -1 : 1));

      const data = {
        connected: true, location: loc.name,
        window: { since: since.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
        orders_scanned: scan.length, orders_total: orders.length, capped: orders.length > MAX_ORDERS,
        service_fetch_failed: svcFail,
        summary: {
          ...summary,
          leak_exposure: Math.round(summary.leak_exposure) / 100,
          underbilled_exposure: Math.round(summary.underbilled_exposure) / 100,
        },
        items: items.slice(0, 300),
        generated_at: new Date().toISOString(),
      };
      cache.set(ckey, { at: Date.now(), data });
      res.json(data);
    } catch (e) {
      fail(res, e, /incomplete|throttl|refusing|no orders/i.test(String(e.message)) ? 502 : 500);
    }
  });

  return router;
};
