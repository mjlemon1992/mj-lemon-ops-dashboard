const express = require('express');
const { authenticateToken, requireRole, canAccessLocation, syncAuth } = require('../middleware/auth');
const { monthStartFor, fetchInvoicedOrdersForLocation, fetchOrderService } = require('../lib/shopmonkey');
const { ensurePartsReconTables } = require('../lib/partsReconSchema');
const { extractInvoice, roPartsCostCents, matchInvoiceToRo, reconcile } = require('../lib/invoiceRecon');

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

  // ══ v1b — VENDOR INVOICE INGESTION + RECONCILIATION ════════════════════
  const who = (req) => req.user.email || req.user.name || req.user.role;
  const paidCentsOf = (inv) => (inv.subtotal_cents != null ? inv.subtotal_cents : inv.total_cents);

  // Match + reconcile an extracted invoice, then upsert it.
  const processInvoice = async (locId, smLoc, apiKey, ex, source) => {
    const m = await matchInvoiceToRo(apiKey, smLoc, { ro_ref: ex.ro_ref, invoice_date: ex.invoice_date });
    let roCost = null, orderId = null, orderNum = null;
    if (m.status === 'matched' && m.order) { orderId = m.order.order_id; orderNum = m.order.order_number; try { roCost = await roPartsCostCents(apiKey, orderId); } catch { /* leave null */ } }
    const paid = ex.subtotal_cents != null ? ex.subtotal_cents : ex.total_cents;
    const rec = reconcile(orderId ? paid : null, roCost);
    const { rows } = await pool.query(
      `INSERT INTO vendor_invoice (location_id, vendor, invoice_number, invoice_date, total_cents, subtotal_cents, ro_ref, matched_order_id, matched_order_number, match_status, match_candidates, ro_parts_cost_cents, recon_status, recon_note, line_items, source, raw_extract)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (location_id, COALESCE(vendor,''), COALESCE(invoice_number,''), COALESCE(total_cents,0))
       DO UPDATE SET invoice_date=EXCLUDED.invoice_date, subtotal_cents=EXCLUDED.subtotal_cents, ro_ref=EXCLUDED.ro_ref,
         matched_order_id=EXCLUDED.matched_order_id, matched_order_number=EXCLUDED.matched_order_number, match_status=EXCLUDED.match_status,
         match_candidates=EXCLUDED.match_candidates, ro_parts_cost_cents=EXCLUDED.ro_parts_cost_cents, recon_status=EXCLUDED.recon_status,
         recon_note=EXCLUDED.recon_note, line_items=EXCLUDED.line_items
       RETURNING id`,
      [locId, ex.vendor, ex.invoice_number, ex.invoice_date, ex.total_cents, ex.subtotal_cents, ex.ro_ref, orderId, orderNum, m.status, JSON.stringify(m.candidates || []), roCost, rec.status, rec.note, JSON.stringify(ex.line_items || []), source, JSON.stringify(ex.raw || ex)]);
    return { id: rows[0].id, vendor: ex.vendor, ro_ref: ex.ro_ref, match_status: m.status, matched_order_number: orderNum, recon_status: rec.status, recon_note: rec.note, candidates: m.candidates };
  };

  // Intake — fed by the scan pipeline (email/Make) or a direct upload. Accepts a
  // base64 file (AI-extracted here) OR pre-extracted structured fields.
  // syncAuth = owner JWT or the X-Sync-Key the automation already uses.
  router.post('/:locationId/invoice-intake', syncAuth, async (req, res) => {
    try {
      if (!canAccessLocation(req.user, req.params.locationId)) return fail(res, 'Access denied for this location', 403);
      await ensurePartsReconTables(pool);
      const { rows } = await pool.query('SELECT shopmonkey_location_id FROM locations WHERE id=$1', [req.params.locationId]);
      if (!rows.length) return fail(res, 'Location not found', 404);
      const smLoc = rows[0].shopmonkey_location_id;
      if (!smLoc) return fail(res, 'Location not connected to Shopmonkey', 400);
      const apiKey = process.env.SHOPMONKEY_API_KEY;
      const b = req.body || {};
      let ex;
      if (b.file) {
        ex = await extractInvoice(b.file, b.media_type || 'image/jpeg');
      } else {
        ex = {
          vendor: b.vendor || null, invoice_number: b.invoice_number || null,
          invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(b.invoice_date || '') ? b.invoice_date : null,
          subtotal_cents: b.subtotal != null ? Math.round(Number(b.subtotal) * 100) : null,
          total_cents: b.total != null ? Math.round(Number(b.total) * 100) : null,
          ro_ref: (b.ro_ref || '').toString().trim() || null,
          line_items: Array.isArray(b.line_items) ? b.line_items : [], raw: b,
        };
        if (ex.total_cents == null && ex.subtotal_cents == null) return fail(res, 'Provide a file, or vendor + total (+ ro_ref)', 400);
      }
      const out = await processInvoice(req.params.locationId, smLoc, apiKey, ex, b.file ? 'upload' : (b.source || 'make'));
      res.json({ ok: true, extracted: { vendor: ex.vendor, invoice_date: ex.invoice_date, total: ex.total_cents != null ? ex.total_cents / 100 : null, ro_ref: ex.ro_ref }, ...out });
    } catch (e) { fail(res, e); }
  });

  router.get('/:locationId/invoices', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    if (!canAccessLocation(req.user, req.params.locationId)) return fail(res, 'Access denied for this location', 403);
    try {
      await ensurePartsReconTables(pool);
      const { rows } = await pool.query(
        `SELECT id, vendor, invoice_number, invoice_date::text AS invoice_date, total_cents, subtotal_cents, ro_ref,
                matched_order_id, matched_order_number, match_status, match_candidates, ro_parts_cost_cents,
                recon_status, recon_note, source, created_at
           FROM vendor_invoice WHERE location_id=$1 ORDER BY created_at DESC LIMIT 200`, [req.params.locationId]);
      const base = ORDER_URL;
      res.json({
        invoices: rows.map((r) => ({
          ...r,
          total: r.total_cents != null ? r.total_cents / 100 : null,
          subtotal: r.subtotal_cents != null ? r.subtotal_cents / 100 : null,
          ro_parts_cost: r.ro_parts_cost_cents != null ? r.ro_parts_cost_cents / 100 : null,
          sm_url: r.matched_order_id ? base.replace('{id}', r.matched_order_id) : null,
        })),
      });
    } catch (e) { fail(res, e); }
  });

  // Re-run the match for an invoice (refreshes candidates after a transient
  // scan failure, or after the ro_ref is corrected).
  router.put('/invoice/:id/rematch', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    try {
      await ensurePartsReconTables(pool);
      const { rows: ir } = await pool.query('SELECT * FROM vendor_invoice WHERE id=$1', [req.params.id]);
      if (!ir.length) return fail(res, 'Invoice not found', 404);
      const inv = ir[0];
      if (!canAccessLocation(req.user, inv.location_id)) return fail(res, 'Access denied for this location', 403);
      const { rows: lr } = await pool.query('SELECT shopmonkey_location_id FROM locations WHERE id=$1', [inv.location_id]);
      const smLoc = lr[0] && lr[0].shopmonkey_location_id;
      const apiKey = process.env.SHOPMONKEY_API_KEY;
      const ref = (req.body || {}).ro_ref != null ? String(req.body.ro_ref).trim() : inv.ro_ref;
      const m = await matchInvoiceToRo(apiKey, smLoc, { ro_ref: ref, invoice_date: inv.invoice_date });
      let roCost = null, orderId = null, orderNum = null;
      if (m.status === 'matched' && m.order) { orderId = m.order.order_id; orderNum = m.order.order_number; try { roCost = await roPartsCostCents(apiKey, orderId); } catch { /* null */ } }
      const rec = reconcile(orderId ? paidCentsOf(inv) : null, roCost);
      await pool.query('UPDATE vendor_invoice SET ro_ref=$2, matched_order_id=$3, matched_order_number=$4, match_status=$5, match_candidates=$6, ro_parts_cost_cents=$7, recon_status=$8, recon_note=$9 WHERE id=$1',
        [inv.id, ref, orderId, orderNum, m.status, JSON.stringify(m.candidates || []), roCost, rec.status, rec.note]);
      res.json({ ok: true, match_status: m.status, matched_order_number: orderNum, candidates: m.candidates, recon_status: rec.status });
    } catch (e) { fail(res, e); }
  });

  // Owner picks the right RO for an ambiguous/unmatched invoice (or unmatches).
  router.put('/invoice/:id/confirm-match', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    try {
      await ensurePartsReconTables(pool);
      const { rows: ir } = await pool.query('SELECT * FROM vendor_invoice WHERE id=$1', [req.params.id]);
      if (!ir.length) return fail(res, 'Invoice not found', 404);
      const inv = ir[0];
      if (!canAccessLocation(req.user, inv.location_id)) return fail(res, 'Access denied for this location', 403);
      const b = req.body || {};
      if (b.unmatch) {
        await pool.query("UPDATE vendor_invoice SET matched_order_id=NULL, matched_order_number=NULL, match_status='unmatched', ro_parts_cost_cents=NULL, recon_status='pending', recon_note='Unmatched', decided_by=$2, decided_at=now() WHERE id=$1", [inv.id, who(req)]);
        return res.json({ ok: true, unmatched: true });
      }
      if (!b.order_id || !b.order_number) return fail(res, 'order_id + order_number required', 400);
      const apiKey = process.env.SHOPMONKEY_API_KEY;
      let roCost = null; try { roCost = await roPartsCostCents(apiKey, b.order_id); } catch { /* null */ }
      const rec = reconcile(paidCentsOf(inv), roCost);
      await pool.query("UPDATE vendor_invoice SET matched_order_id=$2, matched_order_number=$3, match_status='confirmed', ro_parts_cost_cents=$4, recon_status=$5, recon_note=$6, decided_by=$7, decided_at=now() WHERE id=$1",
        [inv.id, b.order_id, String(b.order_number), roCost, rec.status, rec.note, who(req)]);
      res.json({ ok: true, recon_status: rec.status, recon_note: rec.note });
    } catch (e) { fail(res, e); }
  });

  router.delete('/invoice/:id', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    try {
      const { rows: ir } = await pool.query('SELECT location_id FROM vendor_invoice WHERE id=$1', [req.params.id]);
      if (!ir.length) return res.json({ ok: true });
      if (!canAccessLocation(req.user, ir[0].location_id)) return fail(res, 'Access denied for this location', 403);
      await pool.query('DELETE FROM vendor_invoice WHERE id=$1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  return router;
};
