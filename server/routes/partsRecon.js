const express = require('express');
const { authenticateToken, requireRole, canAccessLocation, syncAuth } = require('../middleware/auth');
const { monthStartFor, fetchInvoicedOrdersForLocation, fetchOrderService } = require('../lib/shopmonkey');
const { ensurePartsReconTables } = require('../lib/partsReconSchema');
const { extractInvoice, extractStatement, roPartsCostCents, woParts, lineCheck, reconcileJob, matchInvoiceToRo, digits, splitPdfDocuments } = require('../lib/invoiceRecon');
const { fetchOrderByNumber } = require('../lib/shopmonkey');
const { fetchInvoiceEmails, markSeen, peekInbox } = require('../lib/invoiceInbox');
const { ingestCallsPdf, looksLikeCallReport } = require('../lib/callsIngest');

// Parts reconciliation — v1a: ShopMonkey-only parts margin / exposure per RO.
// For each invoiced order in the window, compare each part's wholesale cost
// (what we paid) to its retail (what we billed) and classify:
//   leak / under_billed / bundled / ok.  Flagged rows can be actioned:
//   opened in Shopmonkey (deep link) or marked reviewed (with a reason) so they
//   drop off the worklist. Read-only against ShopMonkey; owner/partner; scoped.
module.exports = (pool) => {
  const router = express.Router();
  const fail = (res, e, code = 500) => res.status(code).json({ error: String(e.message || e) });
  // Dollars → integer cents, or null for anything that doesn't parse (Make/manual
  // callers can post "n/a"/""); a raw NaN reaching an INTEGER column 500s the request.
  const toCents = (v) => { if (v == null || v === '') return null; const n = Math.round(Number(v) * 100); return Number.isFinite(n) ? n : null; };
  const scanningLocations = new Set();   // per-location inbox-scan mutex (manual + poller share it)
  const cache = new Map();
  const TTL = 10 * 60 * 1000;
  const MAX_ORDERS = 600;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const REASONS = ['warranty', 'rebilled', 'vendor_query', 'ignore'];
  // Confirmed from a real ShopMonkey session (2026-07-21): singular /order/, no
  // hash fragment. The earlier guess of '#/orders/{id}' silently dumped you on
  // the dashboard — a wrong hash loads the app root and the fragment is ignored.
  const ORDER_URL = process.env.SHOPMONKEY_ORDER_URL_TEMPLATE || 'https://app.shopmonkey.cloud/order/{id}';
  const MIN_CORE_CENTS = 500;   // ignore trivial "core" lines, same $5 floor as everything else
  // A reman part's refundable deposit, printed as its own line ("CORE CHARGE | R8311477BB").
  const CORE_RE = /\bcores?\b|core charge/i;

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

  // RETENTION: we only hold the scan while the invoice needs eyes. Once it's
  // matched AND reconciles clean with no line findings, drop the image —
  // Hubdoc/QBO is the system of record for the document itself. Anything still
  // unmatched, flagged, or on an open job keeps its scan so it can be viewed.
  const purgeResolvedFiles = async (locId) => {
    await pool.query(
      `UPDATE vendor_invoice SET file_data=NULL, file_mime=NULL
        WHERE location_id=$1 AND file_data IS NOT NULL
          AND match_status IN ('matched','confirmed')
          AND recon_status='ok'
          AND COALESCE(jsonb_array_length(line_findings), 0) = 0`, [locId]);
  };

  // JOB-TOTAL ROLL-UP: every supplier invoice matched to this RO vs the total
  // parts cost on the WO. Re-stamps ALL the job's invoices so adding one
  // re-reconciles the whole job. Returns the verdict.
  const rollUpJob = async (locId, orderId, woCostCents, orderInvoiced) => {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(COALESCE(subtotal_cents, total_cents) - COALESCE(core_cents, 0)), 0)::int AS paid
         FROM vendor_invoice WHERE location_id=$1 AND matched_order_id=$2`, [locId, orderId]);
    const jobPaid = rows[0].paid;
    const rec = reconcileJob(jobPaid, woCostCents, orderInvoiced);
    await pool.query(
      `UPDATE vendor_invoice SET recon_status=$3, recon_note=$4, job_paid_cents=$5,
              ro_parts_cost_cents=COALESCE($6, ro_parts_cost_cents)
         WHERE location_id=$1 AND matched_order_id=$2`,
      [locId, orderId, rec.status, rec.note, jobPaid, woCostCents]);
    await purgeResolvedFiles(locId);   // anything that just settled clean drops its scan
    return { rec, jobPaid };
  };

  // Match an extracted invoice, upsert it, then reconcile the whole job.
  // fileBase64/fileMime (when it came from a scan/upload) are kept so the owner
  // can pull the original up to eyeball a match.
  const processInvoice = async (locId, smLoc, apiKey, ex, source, fileBase64 = null, fileMime = null) => {
    const fileBuf = fileBase64 ? Buffer.from(fileBase64, 'base64') : null;
    // Something else off the same scanner stack — fuel, coffee, shop cleaning
    // supplies, postage. Kept (a parts supplier's own consumables invoice WILL
    // appear on their statement, so it must still count as captured) but parked:
    // no RO lookup, no roll-up, never in the worklist. match_status 'skipped'
    // keeps it out of the attention rail for free.
    if (ex.not_parts) {
      const { rows: nr } = await pool.query(
        `INSERT INTO vendor_invoice (location_id, vendor, invoice_number, invoice_date, total_cents, subtotal_cents, ro_ref,
                                     match_status, recon_status, recon_note, line_items, source, raw_extract, file_data, file_mime, not_parts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'skipped','not_parts',$8,$9,$10,$11,$12,$13,true)
         ON CONFLICT (location_id, COALESCE(vendor,''), COALESCE(invoice_number,''), COALESCE(total_cents,0))
         DO UPDATE SET invoice_date=EXCLUDED.invoice_date, subtotal_cents=EXCLUDED.subtotal_cents, line_items=EXCLUDED.line_items,
           match_status='skipped', recon_status='not_parts', recon_note=EXCLUDED.recon_note, not_parts=true,
           file_data=COALESCE(EXCLUDED.file_data, vendor_invoice.file_data), file_mime=COALESCE(EXCLUDED.file_mime, vendor_invoice.file_mime)
         RETURNING id`,
        [locId, ex.vendor, ex.invoice_number, ex.invoice_date, ex.total_cents, ex.subtotal_cents, ex.ro_ref,
          'Not a parts purchase — parked, so it never reaches the worklist. Tap “Is parts” if that’s wrong.',
          JSON.stringify(ex.line_items || []), source, JSON.stringify(ex.raw || ex), fileBuf, fileMime]);
      return { id: nr[0].id, vendor: ex.vendor, not_parts: true, match_status: 'skipped', recon_status: 'not_parts', line_findings: [] };
    }
    // If this exact invoice was already CONFIRMED to an RO by hand, a re-ingest
    // (re-forward, markSeen retry, manual+poller overlap) must NOT let the auto
    // matcher silently revert the owner's decision. Reuse the confirmed order.
    const existing = (await pool.query(
      `SELECT match_status, matched_order_id, matched_order_number FROM vendor_invoice
        WHERE location_id=$1 AND COALESCE(vendor,'')=COALESCE($2,'') AND COALESCE(invoice_number,'')=COALESCE($3,'') AND COALESCE(total_cents,0)=COALESCE($4,0)`,
      [locId, ex.vendor, ex.invoice_number, ex.total_cents])).rows[0];
    let m;
    if (existing && existing.match_status === 'confirmed' && existing.matched_order_id) {
      m = { status: 'confirmed', order: { order_id: existing.matched_order_id, order_number: existing.matched_order_number, invoiced: null }, candidates: [] };
    } else {
      m = await matchInvoiceToRo(apiKey, smLoc, { ro_ref: ex.ro_ref, invoice_date: ex.invoice_date });
    }
    let orderId = null, orderNum = null, orderInvoiced = null, wo = null;
    if ((m.status === 'matched' || m.status === 'confirmed') && m.order) {
      orderId = m.order.order_id; orderNum = m.order.order_number; orderInvoiced = m.order.invoiced;
      try { wo = await woParts(apiKey, orderId); } catch { /* leave null */ }
    }
    const roCost = wo ? wo.costCents : null;
    // Bonus precision: only where a real part number matches on both sides.
    const findings = wo ? lineCheck(ex.line_items, wo.parts, orderInvoiced === true) : [];
    // A core charge is a refundable deposit, not a part on the job — it's tracked
    // as its own claim, so it must not count as money paid toward the WO's parts
    // or every reman purchase reads as a false "possible unbilled".
    const coreCents = (ex.line_items || []).reduce((a, li) => {
      if (!(CORE_RE.test(String(li.part_number || '')) || CORE_RE.test(String(li.description || '')))) return a;
      const q = Number(li.qty);
      const v = li.amount != null ? Math.round(Number(li.amount) * 100)
        : (li.unit_cost != null ? Math.round(Number(li.unit_cost) * 100 * (Number.isFinite(q) && q !== 0 ? Math.abs(q) : 1)) * (Number.isFinite(q) && q < 0 ? -1 : 1) : 0);
      return a + (Number.isFinite(v) ? v : 0);
    }, 0);
    const { rows } = await pool.query(
      `INSERT INTO vendor_invoice (location_id, vendor, invoice_number, invoice_date, total_cents, subtotal_cents, ro_ref, matched_order_id, matched_order_number, match_status, match_candidates, ro_parts_cost_cents, recon_status, recon_note, line_items, source, raw_extract, line_findings, file_data, file_mime, core_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (location_id, COALESCE(vendor,''), COALESCE(invoice_number,''), COALESCE(total_cents,0))
       DO UPDATE SET invoice_date=EXCLUDED.invoice_date, subtotal_cents=EXCLUDED.subtotal_cents, ro_ref=EXCLUDED.ro_ref,
         matched_order_id=EXCLUDED.matched_order_id, matched_order_number=EXCLUDED.matched_order_number, match_status=EXCLUDED.match_status,
         match_candidates=EXCLUDED.match_candidates, ro_parts_cost_cents=EXCLUDED.ro_parts_cost_cents, recon_status=EXCLUDED.recon_status,
         recon_note=EXCLUDED.recon_note, line_items=EXCLUDED.line_items, line_findings=EXCLUDED.line_findings,
         file_data=COALESCE(EXCLUDED.file_data, vendor_invoice.file_data), file_mime=COALESCE(EXCLUDED.file_mime, vendor_invoice.file_mime), core_cents=EXCLUDED.core_cents
       RETURNING id`,
      [locId, ex.vendor, ex.invoice_number, ex.invoice_date, ex.total_cents, ex.subtotal_cents, ex.ro_ref, orderId, orderNum, m.status, JSON.stringify(m.candidates || []), roCost, 'pending', 'Reconciling…', JSON.stringify(ex.line_items || []), source, JSON.stringify(ex.raw || ex), JSON.stringify(findings), fileBuf, fileMime, coreCents]);
    const id = rows[0].id;
    let rec = { status: 'pending', note: 'Not matched to a work order yet.' }, jobPaid = null;
    if (orderId) ({ rec, jobPaid } = await rollUpJob(locId, orderId, roCost, orderInvoiced));
    else await pool.query('UPDATE vendor_invoice SET recon_status=$2, recon_note=$3 WHERE id=$1', [id, rec.status, rec.note]);
    return { id, vendor: ex.vendor, ro_ref: ex.ro_ref, match_status: m.status, matched_order_number: orderNum, recon_status: rec.status, recon_note: rec.note, candidates: m.candidates, job_paid_cents: jobPaid, wo_cost_cents: roCost, line_findings: findings };
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
      if (b.file) {
        // Auto-routes invoice vs statement (is_statement flag from the extractor);
        // a PDF holding several stacked documents is split and filed one by one.
        const out = await ingestFileMulti(req.params.locationId, smLoc, apiKey, b.file, b.media_type || 'image/jpeg', 'upload');
        return res.json({ ok: true, ...out });
      }
      const ex = {
        vendor: b.vendor || null, invoice_number: b.invoice_number || null,
        invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(b.invoice_date || '') ? b.invoice_date : null,
        subtotal_cents: toCents(b.subtotal),
        total_cents: toCents(b.total),
        ro_ref: (b.ro_ref || '').toString().trim() || null,
        line_items: Array.isArray(b.line_items) ? b.line_items : [], raw: b,
      };
      if (ex.total_cents == null && ex.subtotal_cents == null) return fail(res, 'Provide a file, or vendor + total (+ ro_ref)', 400);
      const out = await processInvoice(req.params.locationId, smLoc, apiKey, ex, b.source || 'make');
      // Open warranty/core claims the same way ingestFile does — a W-prefixed PO or
      // core lines arriving via Make were silently dropped before.
      if (out.id && !ex.not_parts) {
        const poFlag = /^\s*w/i.test(String(ex.ro_ref || ''));
        if (poFlag) { const expected = ex.subtotal_cents != null ? ex.subtotal_cents : ex.total_cents; await openClaim(req.params.locationId, out.id, ex, { kind: 'warranty', expectedCents: expected, source: 'po' }); }
        try { await handleCoreLines(req.params.locationId, out.id, ex); } catch (e) { /* best-effort */ }
      }
      res.json({ ok: true, type: 'invoice', extracted: { vendor: ex.vendor, invoice_date: ex.invoice_date, total: ex.total_cents != null ? ex.total_cents / 100 : null, ro_ref: ex.ro_ref }, ...out });
    } catch (e) { fail(res, e); }
  });

  // ══ SCAN FRONT DOOR — pull scanned invoices out of an email inbox ══════════
  // Each location has its own dedicated invoices mailbox, so mail routes to the
  // right shop's books + dashboard location with no tagging. ScanSnap "scan to
  // email" / forwarded supplier PDFs → that mailbox → this reads the PDF/image
  // attachments, runs each through the same extract→match→reconcile pipeline,
  // and marks the email read. Config (all env, dark until set):
  //   PARTS_INBOX_MAP  JSON, per location (preferred, multi-shop):
  //     [{"location":"<dash-loc-id>","user":"reddeer-invoices@…","pass":"<app-pw>"}]
  //   —or— single-location fallback:
  //   PARTS_IMAP_USER / PARTS_IMAP_PASS  dedicated invoice inbox, OR
  //   GMAIL_IMAP_USER / GMAIL_IMAP_PASS  the shared hub inbox — but then a
  //   PARTS_INTAKE_SUBJECT_TAG is REQUIRED so we only touch tagged scans and
  //   never hoover unrelated attachments out of the hub.
  const parseInboxMap = () => { try { const m = JSON.parse(process.env.PARTS_INBOX_MAP || '[]'); return Array.isArray(m) ? m : []; } catch (e) { return []; } };
  // Resolve the mailbox creds + subject filter for one location. A per-location
  // map entry is a dedicated mailbox by definition (no tag needed).
  const inboxConfigFor = (locationId) => {
    const hit = parseInboxMap().find((m) => m && m.location === locationId);
    if (hit && hit.user && hit.pass) return { user: hit.user, pass: hit.pass, tag: (hit.tag || '').trim(), dedicated: true };
    return {
      user: process.env.PARTS_IMAP_USER || process.env.GMAIL_IMAP_USER,
      pass: process.env.PARTS_IMAP_PASS || process.env.GMAIL_IMAP_PASS,
      tag: (process.env.PARTS_INTAKE_SUBJECT_TAG || '').trim(),
      dedicated: !!(process.env.PARTS_IMAP_USER && process.env.PARTS_IMAP_PASS),
    };
  };
  // Hubdoc fan-out — the DASHBOARD forwards each FILED document to the books,
  // replacing the blanket Gmail filter (which would forward a stacked scan as
  // one unreadable brick). Because this fires per document AFTER splitting,
  // Hubdoc receives individual invoices. Config: add "hubdoc":"<intake address>"
  // to the location's PARTS_INBOX_MAP entry; sends from that same mailbox.
  // One-shot per row: hubdoc_sent_at is claimed atomically before sending and
  // released on failure, so re-ingests never double-file but a failed send
  // retries on the next ingest of the same document.
  const forwardToHubdoc = async (locationId, table, rowId, fileBase64, mediaType, label) => {
    try {
      // Relay mode: Railway's SMTP egress proved unreliable (most sends time
      // out), so when a relay key is configured the server does NOT send —
      // rows simply stay pending (hubdoc_sent_at NULL) and the shop Mac's
      // relay drains the queue via /hubdoc-next + /hubdoc-mark every minute.
      if (process.env.HUBDOC_RELAY_KEY) return;
      if (!rowId || !fileBase64) return;
      const hit = parseInboxMap().find((m) => m && m.location === locationId);
      if (!hit || !hit.hubdoc || !hit.user || !hit.pass) return;
      const claim = await pool.query(`UPDATE ${table} SET hubdoc_sent_at=NOW() WHERE id=$1 AND hubdoc_sent_at IS NULL RETURNING id`, [rowId]);
      if (!claim.rows.length) return;   // already forwarded
      const nodemailer = require('nodemailer');
      // Railway egress: IPv6 to Gmail is unroutable (ENETUNREACH) and 465 has
      // timed out — resolve an IPv4 address explicitly and use the 587
      // submission port with STARTTLS, keeping the TLS servername so the cert
      // still validates against smtp.gmail.com.
      let smtpHost = 'smtp.gmail.com';
      try { const a = await require('dns').promises.resolve4('smtp.gmail.com'); if (a.length) smtpHost = a[0]; } catch (e) { /* fall back to hostname */ }
      const tx = nodemailer.createTransport({
        host: smtpHost, port: 587, secure: false, requireTLS: true,
        auth: { user: hit.user, pass: hit.pass },
        tls: { servername: 'smtp.gmail.com' },
        connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 30000,
      });
      const ext = /pdf/i.test(String(mediaType || '')) ? 'pdf' : 'jpg';
      const safe = String(label || 'document').replace(/[^\w.\- ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'document';
      try {
        await tx.sendMail({
          from: hit.user, to: hit.hubdoc, subject: safe,
          text: 'Filed by OPS parts intake.',
          attachments: [{ filename: `${safe}.${ext}`, content: Buffer.from(fileBase64, 'base64'), contentType: mediaType || 'application/pdf' }],
        });
        console.log(`[hubdoc] forwarded "${safe}" (${table} ${rowId})`);
      } catch (e) {
        await pool.query(`UPDATE ${table} SET hubdoc_sent_at=NULL WHERE id=$1`, [rowId]).catch(() => {});
        console.error('[hubdoc] send failed:', e.message);
      }
    } catch (e) { console.error('[hubdoc] forward error:', e.message); }
  };

  // Locations the always-on poller should sweep: every mapped location, else the
  // single fallback location.
  const pollLocations = () => {
    const mapped = parseInboxMap().map((m) => m && m.location).filter(Boolean);
    if (mapped.length) return mapped;
    return process.env.PARTS_INBOX_LOCATION ? [process.env.PARTS_INBOX_LOCATION] : [];
  };

  // One scan per location at a time, shared between the manual "Scan inbox" button
  // and the background poller. Without this they can fetch the SAME unseen UIDs
  // concurrently (neither has marked \Seen yet) and double-ingest — two rows on OCR
  // variance, a core credit settled twice. Skips (doesn't queue) an overlapping run.
  const scanInboxInto = async (locationId) => {
    if (scanningLocations.has(locationId)) return { ok: true, scanned: 0, processed: 0, more: false, results: [], busy: true };
    scanningLocations.add(locationId);
    try {
    const { user, pass, tag, dedicated } = inboxConfigFor(locationId);
    if (!user || !pass) return { ok: false, error: 'Invoice inbox not configured for this location (set PARTS_INBOX_MAP, or PARTS_IMAP_USER/PASS)', processed: 0, results: [] };
    if (!dedicated && !tag) return { ok: false, error: 'Refusing to scan the shared inbox without a filter — set PARTS_INTAKE_SUBJECT_TAG, or use a dedicated mailbox (PARTS_INBOX_MAP / PARTS_IMAP_USER/PASS)', processed: 0, results: [] };
    const { rows } = await pool.query('SELECT shopmonkey_location_id FROM locations WHERE id=$1', [locationId]);
    if (!rows.length) return { ok: false, error: 'Location not found', processed: 0, results: [] };
    const smLoc = rows[0].shopmonkey_location_id;
    // No ShopMonkey link (e.g. Hwy 97) still scans: call reports don't need SM.
    // Only INVOICE processing requires it — those messages are skipped (left
    // unread, no AI spend) until the location is connected.
    const canInvoices = !!smLoc;
    const apiKey = process.env.SHOPMONKEY_API_KEY;

    // PACING. Each document costs a Claude read plus 1-2 ShopMonkey lookups, and
    // ShopMonkey rate-limits hard when a burst lands alongside the metrics
    // scheduler (a throttled lookup silently returns "unmatched", so a burst
    // doesn't just run slow — it files invoices with wrong answers). So take a
    // bounded slice per run and breathe between documents. Anything left stays
    // UNREAD and the next cycle picks it up, which turns a 200-file month-end
    // catch-up into several calm passes instead of one throttled mess.
    const MAX_PER_RUN = Math.max(1, Number(process.env.PARTS_INBOX_MAX_PER_RUN || 15));
    const PACE_MS = Math.max(0, Number(process.env.PARTS_INBOX_PACE_MS || 1200));
    const inbox = await fetchInvoiceEmails({ user, pass, subjectTag: tag, max: MAX_PER_RUN });
    if (!inbox.ok) return { ok: false, error: inbox.error, processed: 0, results: [] };
    await ensurePartsReconTables(pool);
    const results = [];
    const doneUids = [];
    let first = true;
    for (const msg of inbox.messages) {
      if (!first) await sleep(PACE_MS);
      first = false;
      let anyOk = false, anyFail = false;
      // Marchex/Telmetrics call report forwarded to the same inbox: route its
      // PDF(s) to the marketing calls ingester, NOT the invoice pipeline —
      // Claude would otherwise gamely try to file a call report as a parts
      // invoice. Non-PDF attachments (logos in the signature) are skipped.
      if (looksLikeCallReport(msg.from, msg.subject)) {
        for (const att of msg.attachments) {
          if (!/pdf/i.test(att.mediaType || '')) continue;
          try {
            const out = await ingestCallsPdf(pool, locationId, att.base64, 'marchex');
            results.push({ from: msg.from, file: att.filename, type: 'call_report', period: out.period, totals: out.totals });
            anyOk = true;
            console.log(`[parts-inbox] routed call report ${att.filename} -> marketing calls (${out.period?.start})`);
          } catch (e) { anyFail = true; results.push({ from: msg.from, file: att.filename, error: `call report: ${String(e.message || e)}` }); }
        }
        if (anyOk && !anyFail) doneUids.push(msg.uid);
        continue;
      }
      // Invoice pipeline needs ShopMonkey for RO matching. Not connected → leave
      // the message unread (it processes once the location is wired up) and say so.
      if (!canInvoices) {
        results.push({ from: msg.from, file: (msg.attachments[0] || {}).filename, type: 'skipped', reason: 'invoice processing needs ShopMonkey — location not connected yet' });
        continue;
      }
      for (const att of msg.attachments) {
        try {
          // "WARRANTY" in the forwarded subject = the digital twin of the stamp.
          // Deliberately NOT matching "credit" here: suppliers routinely send
          // their own mail titled "Credit Note …", which would open a bogus
          // claim on every one. The typed subject stays the unambiguous word.
          const warrantySubject = /\bwarranty\b/i.test(msg.subject || '');
          const res0 = await ingestFileMulti(locationId, smLoc, apiKey, att.base64, att.mediaType, 'email', warrantySubject);
          const outs = res0.type === 'multi' ? res0.results : [res0];
          for (const out of outs) {
            const label = res0.type === 'multi' ? `${att.filename} (${out.pages})` : att.filename;
            if (out.type === 'error') { anyFail = true; results.push({ from: msg.from, file: label, error: out.error }); continue; }
            if (out.type === 'statement') results.push({ from: msg.from, file: label, type: 'statement', vendor: out.vendor, line_count: out.line_count, missing: out.missing });
            else if (out.type === 'skipped') results.push({ from: msg.from, file: label, type: 'skipped', reason: out.reason });
            else results.push({ from: msg.from, file: label, type: 'invoice', vendor: out.vendor, ro_ref: out.ro_ref, match_status: out.match_status, recon_status: out.recon_status });
            anyOk = true;
          }
        } catch (e) { anyFail = true; results.push({ from: msg.from, file: att.filename, error: String(e.message || e) }); }
      }
      // Mark read only when EVERY attachment filed. If any sibling failed (e.g. the
      // invoice PDF threw while the signature-logo skipped), leave the message
      // unread so the failed attachment is retried — don't lose it because a
      // different attachment on the same email succeeded.
      if (anyOk && !anyFail) doneUids.push(msg.uid);
    }
    if (doneUids.length) { try { await markSeen({ user, pass, uids: doneUids }); } catch (e) { /* leave unread to retry */ } }
    // Hitting the cap means more is very likely waiting — say so rather than
    // letting a partial pass look like "the inbox is empty now".
    const more = inbox.messages.length >= MAX_PER_RUN;
    return { ok: true, scanned: inbox.messages.length, processed: results.filter((r) => !r.error).length, more, results };
    } finally { scanningLocations.delete(locationId); }
  };

  // ── Hubdoc relay (shop-Mac courier) ────────────────────────────────────────
  // Railway can't reliably reach Gmail SMTP, so the shop Mac drains the queue:
  // GET /hubdoc-next hands it ONE pending document as raw bytes (metadata in
  // response headers — no JSON parsing needed in bash), the Mac emails it to
  // Hubdoc from the parts mailbox, then POST /hubdoc-mark/:id claims it sent.
  // Auth: scoped X-Relay-Key (HUBDOC_RELAY_KEY env) — can only read filed
  // invoice PDFs and flip their sent flag, nothing else.
  const relayAuth = (req, res, next) => {
    const want = process.env.HUBDOC_RELAY_KEY;
    if (!want) return res.status(503).json({ error: 'Relay not configured (HUBDOC_RELAY_KEY unset)' });
    const got = String(req.headers['x-relay-key'] || '');
    const crypto = require('crypto');
    const a = crypto.createHash('sha256').update(got).digest();
    const b = crypto.createHash('sha256').update(want).digest();
    if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Bad relay key' });
    next();
  };
  const asciiLabel = (s) => String(s || 'document').replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'document';
  router.get('/:locationId/hubdoc-next', relayAuth, async (req, res) => {
    try {
      await ensurePartsReconTables(pool);
      const hit = parseInboxMap().find((m) => m && m.location === req.params.locationId);
      if (!hit || !hit.hubdoc) return res.status(204).end();
      const { rows } = await pool.query(
        `SELECT id, vendor, invoice_number, file_data, file_mime FROM vendor_invoice
          WHERE location_id=$1 AND hubdoc_sent_at IS NULL AND file_data IS NOT NULL
          ORDER BY created_at LIMIT 1`, [req.params.locationId]);
      if (!rows.length) return res.status(204).end();
      const r = rows[0];
      res.set('X-Doc-Id', r.id);
      res.set('X-Doc-Label', asciiLabel(`${r.vendor || 'Invoice'} ${r.invoice_number || ''}`));
      res.set('X-Hubdoc-To', hit.hubdoc);
      res.set('Content-Type', r.file_mime || 'application/pdf');
      res.send(r.file_data);
    } catch (e) { fail(res, e); }
  });
  router.post('/:locationId/hubdoc-mark/:id', relayAuth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'UPDATE vendor_invoice SET hubdoc_sent_at=NOW() WHERE id=$1 AND location_id=$2 RETURNING id',
        [req.params.id, req.params.locationId]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      console.log(`[hubdoc] relay delivered ${rows[0].id}`);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Retry Hubdoc forwarding for anything filed but not yet sent (send failures
  // release the hubdoc_sent_at claim). Works off the stored file bytes, so no
  // re-extraction and no double-file risk. syncAuth like the other pipeline pokes.
  router.post('/:locationId/hubdoc-resend', syncAuth, async (req, res) => {
    try {
      if (!canAccessLocation(req.user, req.params.locationId)) return fail(res, 'Access denied for this location', 403);
      await ensurePartsReconTables(pool);
      const loc = req.params.locationId;
      const out = { invoices: 0, statements: 0, failed: 0 };
      const { rows: invs } = await pool.query(
        `SELECT id, vendor, invoice_number, file_data, file_mime FROM vendor_invoice
          WHERE location_id=$1 AND hubdoc_sent_at IS NULL AND file_data IS NOT NULL
          ORDER BY created_at DESC LIMIT 40`, [loc]);
      for (const r of invs) {
        await forwardToHubdoc(loc, 'vendor_invoice', r.id, r.file_data.toString('base64'), r.file_mime, `${r.vendor || 'Invoice'} ${r.invoice_number || ''}`.trim());
        const chk = await pool.query('SELECT hubdoc_sent_at FROM vendor_invoice WHERE id=$1', [r.id]);
        if (chk.rows[0] && chk.rows[0].hubdoc_sent_at) out.invoices++; else out.failed++;
      }
      const { rows: stms } = await pool.query(
        `SELECT id, vendor, period_label, statement_date, file_data, file_mime FROM vendor_statement
          WHERE location_id=$1 AND hubdoc_sent_at IS NULL AND file_data IS NOT NULL
          ORDER BY created_at DESC LIMIT 20`, [loc]).catch(() => ({ rows: [] }));
      for (const r of stms) {
        await forwardToHubdoc(loc, 'vendor_statement', r.id, r.file_data.toString('base64'), r.file_mime, `${r.vendor || 'Statement'} ${r.period_label || r.statement_date || ''}`.trim());
        const chk = await pool.query('SELECT hubdoc_sent_at FROM vendor_statement WHERE id=$1', [r.id]);
        if (chk.rows[0] && chk.rows[0].hubdoc_sent_at) out.statements++; else out.failed++;
      }
      res.json({ ok: true, ...out });
    } catch (e) { fail(res, e); }
  });

  // Manual "Scan inbox now" (owner/partner via JWT, or the automation's X-Sync-Key).
  router.post('/:locationId/scan-inbox', syncAuth, async (req, res) => {
    try {
      if (!canAccessLocation(req.user, req.params.locationId)) return fail(res, 'Access denied for this location', 403);
      const out = await scanInboxInto(req.params.locationId);
      if (!out.ok) return fail(res, out.error, 400);
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  // ══ v1e — WARRANTY CREDIT WATCH ════════════════════════════════════════════
  // Outstanding + settled warranty claims for a location.
  router.get('/:locationId/warranty', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    if (!canAccessLocation(req.user, req.params.locationId)) return fail(res, 'Access denied for this location', 403);
    try {
      await ensurePartsReconTables(pool);
      // Awaiting claims oldest-first — that's the chase order; settled history after.
      const { rows } = await pool.query(
        `SELECT w.*, w.invoice_date::text AS invoice_date, v.matched_order_number, (v.file_data IS NOT NULL) AS has_file
           FROM warranty_claim w LEFT JOIN vendor_invoice v ON v.id = w.invoice_id
          WHERE w.location_id=$1
          ORDER BY (w.status='awaiting') DESC,
                   CASE WHEN w.status='awaiting' THEN w.created_at END ASC,
                   w.created_at DESC
          LIMIT 200`, [req.params.locationId]);
      const now = Date.now();
      res.json({
        claims: rows.map((r) => ({
          ...r,
          expected: r.expected_cents != null ? r.expected_cents / 100 : null,
          credited: r.credited_cents != null ? r.credited_cents / 100 : null,
          age_days: Math.floor((now - new Date(r.created_at).getTime()) / 86400000),
        })),
      });
    } catch (e) { fail(res, e); }
  });

  // Featherweight credits glance — count / dollars / oldest age of claims still
  // awaiting. Drives the live badge on the "Credits due" tab so the money owed
  // back is visible from anywhere on the Parts page without opening the tab.
  router.get('/:locationId/credits-summary', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    if (!canAccessLocation(req.user, req.params.locationId)) return fail(res, 'Access denied for this location', 403);
    try {
      await ensurePartsReconTables(pool);
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(expected_cents),0)::bigint AS cents,
                COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400), 0)::int AS oldest_days
           FROM warranty_claim WHERE location_id=$1 AND status='awaiting'`, [req.params.locationId]);
      const r = rows[0];
      res.json({ count: r.n, expected: Number(r.cents) / 100, oldest_days: r.oldest_days });
    } catch (e) { fail(res, e); }
  });

  // Mark an invoice as warranty by hand (digital invoices, or part-warranty ones
  // where only some lines are claimed). Also used to adjust the expected amount.
  router.put('/invoice/:id/warranty', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    try {
      await ensurePartsReconTables(pool);
      const { rows: ir } = await pool.query('SELECT * FROM vendor_invoice WHERE id=$1', [req.params.id]);
      if (!ir.length) return fail(res, 'Invoice not found', 404);
      const inv = ir[0];
      if (!canAccessLocation(req.user, inv.location_id)) return fail(res, 'Access denied for this location', 403);
      const b = req.body || {};
      if (b.remove) {
        await pool.query("DELETE FROM warranty_claim WHERE invoice_id=$1 AND kind='warranty' AND status='awaiting'", [inv.id]);
        return res.json({ ok: true, removed: true });
      }
      const lines = Array.isArray(b.lines) ? b.lines : [];
      const expected = toCents(b.expected)
        ?? (lines.length ? lines.reduce((a, l) => a + (toCents(l.amount) || 0), 0)
          : (inv.subtotal_cents != null ? inv.subtotal_cents : inv.total_cents));
      await pool.query(
        `INSERT INTO warranty_claim (location_id, invoice_id, vendor, invoice_number, invoice_date, expected_cents, lines, kind, source, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'warranty','manual',$8,$9)
         ON CONFLICT (invoice_id, kind, COALESCE(part_number,''), COALESCE(expected_cents,0))
         WHERE invoice_id IS NOT NULL
         DO UPDATE SET lines=EXCLUDED.lines, note=EXCLUDED.note`,
        [inv.location_id, inv.id, inv.vendor, inv.invoice_number, inv.invoice_date, expected, JSON.stringify(lines), b.note || null, who(req)]);
      // Amount is part of the dedupe key, so changing it means replacing the row.
      await pool.query("DELETE FROM warranty_claim WHERE invoice_id=$1 AND kind='warranty' AND status='awaiting' AND expected_cents IS DISTINCT FROM $2", [inv.id, expected]);
      res.json({ ok: true, expected: expected / 100 });
    } catch (e) { fail(res, e); }
  });

  // Settle a claim by hand (credit arrived, or writing it off).
  router.put('/warranty/:id', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT location_id FROM warranty_claim WHERE id=$1', [req.params.id]);
      if (!rows.length) return fail(res, 'Claim not found', 404);
      if (!canAccessLocation(req.user, rows[0].location_id)) return fail(res, 'Access denied for this location', 403);
      const b = req.body || {};
      if (b.status === 'awaiting') {
        await pool.query("UPDATE warranty_claim SET status='awaiting', credited_cents=NULL, credited_number=NULL, credited_at=NULL WHERE id=$1", [req.params.id]);
        return res.json({ ok: true });
      }
      const st = b.status === 'closed' ? 'closed' : 'credited';
      await pool.query(
        `UPDATE warranty_claim SET status=$2, credited_cents=$3, credited_number=$4, credited_at=now(), note=COALESCE($5, note) WHERE id=$1`,
        [req.params.id, st, toCents(b.credited), b.credited_number || null, b.note || null]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Diagnostic: show what's sitting in the mailbox and how each message looks to
  // the poller (read state, attachment types) — metadata only, ingests nothing.
  router.get('/:locationId/inbox-peek', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    if (!canAccessLocation(req.user, req.params.locationId)) return fail(res, 'Access denied for this location', 403);
    try {
      const { user, pass } = inboxConfigFor(req.params.locationId);
      const out = await peekInbox({ user, pass, sinceDays: Number(req.query.days || 7) });
      if (!out.ok) return fail(res, out.error, 400);
      res.json({ mailbox: user, ...out });
    } catch (e) { fail(res, e); }
  });

  // ══ v1c — MONTH-END STATEMENT RECONCILIATION ═══════════════════════════════
  // A supplier's statement lists every invoice they billed. Match each line to
  // the invoices we captured (vendor_invoice) and surface the ones we're MISSING
  // — never received/entered — the likeliest hiding spot for an unbilled part.
  const normNum = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Two vendor names refer to the same supplier if the shorter folded name is a
  // prefix of the longer ("NAPA" ↔ "NAPA AUTO PARTS"). Empty on either side = no
  // opinion (don't over-restrict). Shared by statement matching + credit settling.
  const sameVendorName = (a, b) => {
    const x = normNum(a), y = normNum(b);
    if (!x || !y) return true;
    return x.length <= y.length ? y.startsWith(x) : x.startsWith(y);
  };
  const reconcileStatement = async (locationId, ex) => {
    const { rows: all } = await pool.query(
      `SELECT id, vendor, invoice_number, total_cents, invoice_date::text AS invoice_date, matched_order_number, match_status
         FROM vendor_invoice WHERE location_id=$1`, [locationId]);
    // SCOPE to the statement's supplier. Without this, a NAPA statement line
    // matches a Transtar invoice of the same number/amount and reports it "have",
    // hiding the genuinely-missing NAPA invoice — the exact unbilled part this
    // check exists to catch.
    const captured = all.filter((c) => sameVendorName(c.vendor, ex.vendor));
    const byNum = new Map(), byDig = new Map();
    for (const c of captured) {
      const n = normNum(c.invoice_number); if (n && !byNum.has(n)) byNum.set(n, c);
      const d = digits(c.invoice_number); if (d && !byDig.has(d)) byDig.set(d, c);
    }
    const claimed = new Set();
    const lines = (ex.invoices || []).map((li) => {
      const n = normNum(li.invoice_number), d = digits(li.invoice_number);
      let c = (n && byNum.get(n)) || (d && byDig.get(d)) || null;
      if (c && claimed.has(c.id)) c = null;   // a captured invoice can satisfy only ONE statement line
      // Number didn't match — try an exact-amount match not already claimed.
      // Compare magnitudes: a credit is negative here but may be captured either way.
      if (!c && li.amount_cents != null) c = captured.find((x) => !claimed.has(x.id) && x.total_cents != null && Math.abs(Math.abs(x.total_cents) - Math.abs(li.amount_cents)) <= 50) || null;
      let status = 'missing', matched_invoice_id = null, captured_cents = null, on_ro = null;
      if (c) {
        claimed.add(c.id); matched_invoice_id = c.id; captured_cents = c.total_cents;
        on_ro = c.matched_order_number || null;
        const tol = Math.max(100, Math.round((li.amount_cents || 0) * 0.01));
        const amtOk = li.amount_cents == null || c.total_cents == null || Math.abs(c.total_cents - li.amount_cents) <= tol;
        status = amtOk ? 'have' : 'amount_mismatch';
      }
      return { invoice_number: li.invoice_number, invoice_date: li.invoice_date, amount_cents: li.amount_cents, type: li.type || 'invoice', status, matched_invoice_id, captured_cents, on_ro };
    });
    const missing = lines.filter((l) => l.status === 'missing');
    const mismatch = lines.filter((l) => l.status === 'amount_mismatch');
    const found = lines.filter((l) => l.status === 'have');
    return { lines, found_count: found.length, missing_count: missing.length, mismatch_count: mismatch.length, missing, mismatch };
  };

  // Upsert a statement + its reconciliation; returns the summary.
  const saveStatement = async (locationId, sx, rec, source) => {
    const linesSum = (sx.invoices || []).reduce((a, i) => a + (i.amount_cents || 0), 0);
    const { rows } = await pool.query(
      `INSERT INTO vendor_statement (location_id, vendor, statement_date, period_label, total_cents, line_count, found_count, missing_count, mismatch_count, lines, raw_extract, source, lines_sum_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (location_id, COALESCE(vendor,''), COALESCE(statement_date, '1900-01-01'), COALESCE(total_cents,0))
       DO UPDATE SET period_label=EXCLUDED.period_label, line_count=EXCLUDED.line_count, found_count=EXCLUDED.found_count,
         missing_count=EXCLUDED.missing_count, mismatch_count=EXCLUDED.mismatch_count, lines=EXCLUDED.lines,
         raw_extract=EXCLUDED.raw_extract, created_at=now(), lines_sum_cents=EXCLUDED.lines_sum_cents
       RETURNING id`,
      [locationId, sx.vendor, sx.statement_date, sx.period, sx.total_cents, sx.invoices.length,
        rec.found_count, rec.missing_count, rec.mismatch_count, JSON.stringify(rec.lines), JSON.stringify(sx.raw || sx), source, linesSum]);
    // Tie-out FIRST: the lines we read must add up to the statement's printed
    // total. If they don't, the read is unreliable (a charge misread as a credit,
    // rows missed) — the "missing" list isn't fact AND we must NOT settle claims
    // off it (there's no unwind once a claim is closed).
    const ties = sx.total_cents == null || Math.abs(linesSum - sx.total_cents) <= Math.max(5000, Math.round(sx.total_cents * 0.02));
    // A credit on the statement closes a warranty/core claim — match each credit
    // line to an outstanding same-vendor claim by amount. Idempotent: a credit
    // NOTE NUMBER already applied never settles a second claim on re-upload.
    if (ties) try {
      const credits = (sx.invoices || []).filter((i) => i.type === 'credit' && i.amount_cents != null && i.invoice_number);
      if (credits.length) {
        const { rows: open } = await pool.query(
          "SELECT id, vendor, expected_cents FROM warranty_claim WHERE location_id=$1 AND status='awaiting' AND expected_cents IS NOT NULL", [locationId]);
        const { rows: applied } = await pool.query(
          "SELECT credited_number FROM warranty_claim WHERE location_id=$1 AND credited_number IS NOT NULL", [locationId]);
        const usedNums = new Set(applied.map((r) => normNum(r.credited_number)).filter(Boolean));
        const taken = new Set();
        for (const c of credits) {
          if (usedNums.has(normNum(c.invoice_number))) continue;   // this credit note already settled a claim
          const amt = Math.abs(c.amount_cents);
          const hit = open.find((w) => !taken.has(w.id) && sameVendorName(w.vendor || '', sx.vendor || '')
            && Math.abs(w.expected_cents - amt) <= Math.max(200, Math.round(amt * 0.05)));
          if (!hit) continue;
          taken.add(hit.id);
          await pool.query(
            `UPDATE warranty_claim SET status='credited', credited_cents=$2, credited_number=$3, credited_statement_id=$4, credited_at=now() WHERE id=$1`,
            [hit.id, amt, c.invoice_number, rows[0].id]);
        }
      }
    } catch (e) { /* settling is best-effort — never fail the statement upload */ }
    return { id: rows[0].id, vendor: sx.vendor, statement_date: sx.statement_date, period: sx.period,
      line_count: sx.invoices.length, found: rec.found_count, missing: rec.missing_count, mismatch: rec.mismatch_count,
      lines_sum: linesSum / 100, total: sx.total_cents != null ? sx.total_cents / 100 : null, ties_out: ties,
      missing_list: rec.missing, mismatch_list: rec.mismatch };
  };

  // Open a warranty claim for an invoice that came in marked (stamp on the scan,
  // or WARRANTY in a forwarded subject). Idempotent per invoice, so re-ingesting
  // the same stamped scan never duplicates it, and never clobbers a claim the
  // owner has already adjusted.
  const openClaim = async (locId, invoiceId, ex, { kind = 'warranty', expectedCents, partNumber = null, source = 'manual', by = null, note = null }) => {
    if (expectedCents == null) return;
    // A W-marked document with a NEGATIVE total is the supplier's credit note
    // itself — the credit has arrived, there is nothing left to wait for. A
    // claim expecting a negative credit is always junk, so never open one.
    if (expectedCents <= 0) { console.log(`[credits] skip claim on credit-note ${ex.vendor || ''} #${ex.invoice_number || ''} (${expectedCents}c)`); return; }
    await pool.query(
      `INSERT INTO warranty_claim (location_id, invoice_id, vendor, invoice_number, invoice_date, expected_cents, kind, part_number, source, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (invoice_id, kind, COALESCE(part_number,''), COALESCE(expected_cents,0))
       WHERE invoice_id IS NOT NULL DO NOTHING`,
      [locId, invoiceId, ex.vendor, ex.invoice_number, ex.invoice_date, expectedCents, kind, partNumber, source, note, by]);
  };

  // CORE CHARGES — a reman part carries a deposit that's refunded when the old
  // unit goes back. They're printed as their own line ("CORE CHARGE | R8311477BB")
  // so, unlike warranty, they need no stamp: a POSITIVE core line opens a claim,
  // and a NEGATIVE one (on a later credit invoice) settles it.
  const handleCoreLines = async (locId, invoiceId, ex) => {
    const lines = (ex.line_items || []).filter((li) => CORE_RE.test(String(li.part_number || '')) || CORE_RE.test(String(li.description || '')));
    for (const li of lines) {
      const qty = Number(li.qty);
      const amt = li.amount != null ? Math.round(Number(li.amount) * 100)
        : (li.unit_cost != null ? Math.round(Number(li.unit_cost) * 100 * (Number.isFinite(qty) && qty !== 0 ? Math.abs(qty) : 1)) * (Number.isFinite(qty) && qty < 0 ? -1 : 1) : null);
      if (amt == null || Math.abs(amt) < MIN_CORE_CENTS) continue;
      const part = (li.description || '').split('|').pop().trim() || li.part_number || null;
      if (amt > 0) {
        await openClaim(locId, invoiceId, ex, { kind: 'core', expectedCents: amt, partNumber: part, source: 'auto', note: li.description || 'Core charge' });
      } else {
        // A core coming back — close the matching open claim for this SUPPLIER.
        // Idempotent: if this credit invoice number already settled a core claim,
        // a re-ingest must not close a second one (silent loss of a real deposit).
        if (ex.invoice_number) {
          const { rows: apc } = await pool.query(
            "SELECT credited_number FROM warranty_claim WHERE location_id=$1 AND kind='core' AND credited_number IS NOT NULL", [locId]);
          const usedCore = new Set(apc.map((r) => normNum(r.credited_number)).filter(Boolean));
          if (usedCore.has(normNum(ex.invoice_number))) continue;
        }
        const { rows } = await pool.query(
          `SELECT id, vendor FROM warranty_claim
            WHERE location_id=$1 AND kind='core' AND status='awaiting' AND expected_cents IS NOT NULL
              AND abs(expected_cents - $2) <= GREATEST(200, (expected_cents * 5) / 100)
            ORDER BY created_at`, [locId, Math.abs(amt)]);
        const hit = rows.find((r) => sameVendorName(r.vendor || '', ex.vendor || ''));
        if (hit) {
          await pool.query(
            `UPDATE warranty_claim SET status='credited', credited_cents=$2, credited_number=$3, credited_at=now() WHERE id=$1`,
            [hit.id, Math.abs(amt), ex.invoice_number || null]);
        }
      }
    }
  };

  // Ingest one attachment/file, auto-routing invoice vs statement. The invoice
  // extractor flags is_statement (content-based, no reliance on subject/filename)
  // so you can email either kind to the same mailbox and it files correctly.
  const ingestFile = async (locationId, smLoc, apiKey, fileBase64, mediaType, source, warrantyHint = false, forceParts = false) => {
    const ex = await extractInvoice(fileBase64, mediaType);
    // "This IS parts" re-read: the classifier will deterministically re-flag the
    // same scan not_parts, so honour the owner's override and push it through matching.
    if (forceParts) ex.not_parts = false;
    if (ex.is_statement && forceParts) ex.is_statement = false;
    if (ex.is_statement) {
      const sx = await extractStatement(fileBase64, mediaType);
      if (sx.invoices && sx.invoices.length) {
        const rec = await reconcileStatement(locationId, sx);
        const s = await saveStatement(locationId, sx, rec, source);
        await forwardToHubdoc(locationId, 'vendor_statement', s.id, fileBase64, mediaType,
          `${sx.vendor || 'Statement'} ${sx.period_label || sx.statement_date || ''}`.trim());
        return { type: 'statement', ...s };
      }
      // Looked like a statement but nothing parsed — fall back to invoice.
    }
    // Nothing readable came off the page — no vendor, no number, no total, no
    // lines. This is almost always an email-signature logo or a stray graphic
    // riding along on a forwarded message, NOT an invoice. Skip it rather than
    // filing a blank row (and, before dollarsToCents was hardened, a NaN total
    // here 500'd the whole scan). Nothing to view, nothing to chase.
    // Deliberately NOT counting a vendor name as content: Claude will read
    // "Mister Transmission" (or any supplier logo) off an email-signature graphic
    // and hand back a vendor with nothing else. A real invoice ALWAYS carries a
    // number or a money total — require one of those before we file a row.
    const hasContent = ex.invoice_number || ex.total_cents != null
      || ex.subtotal_cents != null || (Array.isArray(ex.line_items) && ex.line_items.length);
    if (!hasContent) {
      return { type: 'skipped', reason: 'unreadable', vendor: ex.vendor || null, match_status: 'skipped' };
    }
    const out = await processInvoice(locationId, smLoc, apiKey, ex, source, fileBase64, mediaType);
    // Books copy — deliberately includes not_parts documents (fuel/consumable
    // receipts are still legitimate expenses for bookkeeping); only unreadable
    // junk (skipped above) never reaches Hubdoc.
    await forwardToHubdoc(locationId, 'vendor_invoice', out.id, fileBase64, mediaType,
      `${ex.vendor || 'Invoice'} ${ex.invoice_number || ''}`.trim());
    // Warranty can be declared three ways, in order of reliability:
    //  • a "W" prefix on the PO given to the supplier (W0508) — travels with the
    //    order, so it prints on THEIR invoice whether it comes back as paper, a
    //    PDF or an emailed one. Nothing to stamp, nothing to remember later.
    //  • a CREDIT/WARRANTY stamp on a scanned page
    //  • WARRANTY typed in a forwarded email's subject
    const poFlag = /^\s*w/i.test(String(ex.ro_ref || ''));
    const warranty = poFlag || ex.warranty_marked || warrantyHint;
    if (out.id && !ex.not_parts) {
      const expected = ex.subtotal_cents != null ? ex.subtotal_cents : ex.total_cents;
      const src = poFlag ? 'po' : ex.warranty_marked ? 'stamp' : 'subject';
      if (warranty) await openClaim(locationId, out.id, ex, { kind: 'warranty', expectedCents: expected, source: src });
      try { await handleCoreLines(locationId, out.id, ex); } catch (e) { /* core watch is best-effort */ }
    }
    return { type: 'invoice', warranty, extracted: { vendor: ex.vendor, invoice_date: ex.invoice_date, total: ex.total_cents != null ? ex.total_cents / 100 : null, ro_ref: ex.ro_ref }, ...out };
  };

  // A stack of SEPARATE invoices scanned in one job arrives as one PDF, and
  // extracting it whole records only the first document. Split first, ingest
  // each document on its own; a genuine multi-page invoice stays together.
  // Detection failure or a single-document PDF falls straight through to the
  // whole-file path, so this can add documents but never lose one.
  const ingestFileMulti = async (locationId, smLoc, apiKey, fileBase64, mediaType, source, warrantyHint = false, forceParts = false) => {
    if (/pdf/i.test(String(mediaType || ''))) {
      let parts = null;
      try { parts = await splitPdfDocuments(fileBase64); }
      catch (e) { console.error('[parts-split] boundary detection failed, ingesting whole PDF:', e.message); }
      if (parts && parts.length > 1) {
        console.log(`[parts-split] ${parts.length} documents found in one scan — ingesting individually`);
        const outs = [];
        for (const p of parts) {
          try { outs.push({ pages: p.pages, ...(await ingestFile(locationId, smLoc, apiKey, p.base64, 'application/pdf', source, warrantyHint, forceParts)) }); }
          catch (e) { outs.push({ pages: p.pages, type: 'error', error: String(e.message || e) }); }
        }
        return { type: 'multi', count: outs.length, results: outs };
      }
    }
    return ingestFile(locationId, smLoc, apiKey, fileBase64, mediaType, source, warrantyHint, forceParts);
  };

  // Upload/receive a statement (base64 file or pre-extracted). syncAuth so the
  // scan pipeline can post statements the same way it posts invoices.
  router.post('/:locationId/statement-intake', syncAuth, async (req, res) => {
    try {
      if (!canAccessLocation(req.user, req.params.locationId)) return fail(res, 'Access denied for this location', 403);
      await ensurePartsReconTables(pool);
      const b = req.body || {};
      if (!b.file) return fail(res, 'Provide a statement file (base64)', 400);
      const sx = await extractStatement(b.file, b.media_type || 'application/pdf');
      if (!sx.invoices || !sx.invoices.length) return fail(res, 'No invoices could be read off this statement', 422);
      const rec = await reconcileStatement(req.params.locationId, sx);
      const s = await saveStatement(req.params.locationId, sx, rec, b.file ? 'upload' : 'make');
      res.json({ ok: true, ...s });
    } catch (e) { fail(res, e); }
  });

  // Past statements for a location, newest first (lines inlined).
  router.get('/:locationId/statements', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    if (!canAccessLocation(req.user, req.params.locationId)) return fail(res, 'Access denied for this location', 403);
    try {
      await ensurePartsReconTables(pool);
      const { rows } = await pool.query(
        `SELECT id, vendor, statement_date::text AS statement_date, period_label, total_cents, line_count,
                found_count, missing_count, mismatch_count, lines, created_at, lines_sum_cents
           FROM vendor_statement WHERE location_id=$1 ORDER BY created_at DESC LIMIT 60`, [req.params.locationId]);
      res.json({
        statements: rows.map((r) => {
          // Statements saved before lines_sum_cents existed still tie out — add
          // their stored lines up on the fly rather than silently passing.
          const sum = r.lines_sum_cents != null
            ? r.lines_sum_cents
            : (Array.isArray(r.lines) ? r.lines.reduce((a, l) => a + (l.amount_cents || 0), 0) : null);
          return {
            ...r,
            total: r.total_cents != null ? r.total_cents / 100 : null,
            lines_sum: sum != null ? sum / 100 : null,
            // False = the lines we read don't add up to the printed total, so the
            // missing list can't be trusted until a human looks.
            ties_out: r.total_cents == null || sum == null
              || Math.abs(sum - r.total_cents) <= Math.max(5000, Math.round(r.total_cents * 0.02)),
          };
        }),
      });
    } catch (e) { fail(res, e); }
  });

  router.delete('/statement/:id', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT location_id FROM vendor_statement WHERE id=$1', [req.params.id]);
      if (!rows.length) return fail(res, 'Statement not found', 404);
      if (!canAccessLocation(req.user, rows[0].location_id)) return fail(res, 'Access denied for this location', 403);
      console.warn(`[parts-delete] STATEMENT ${req.params.id} deleted by ${req.user && req.user.email} (${req.user && req.user.role}) ip=${req.ip} ua=${(req.headers['user-agent'] || '').slice(0, 60)}`);
      await pool.query('DELETE FROM vendor_statement WHERE id=$1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  router.get('/:locationId/invoices', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    if (!canAccessLocation(req.user, req.params.locationId)) return fail(res, 'Access denied for this location', 403);
    try {
      await ensurePartsReconTables(pool);
      const { rows } = await pool.query(
        `SELECT id, vendor, invoice_number, invoice_date::text AS invoice_date, total_cents, subtotal_cents, ro_ref,
                matched_order_id, matched_order_number, match_status, match_candidates, ro_parts_cost_cents,
                recon_status, recon_note, source, created_at, job_paid_cents, line_findings,
                (file_data IS NOT NULL) AS has_file, file_mime, not_parts,
                EXISTS (SELECT 1 FROM warranty_claim w WHERE w.invoice_id = vendor_invoice.id) AS warranty
           FROM vendor_invoice WHERE location_id=$1 ORDER BY created_at DESC LIMIT 200`, [req.params.locationId]);
      // Records are never purged — the statement check matches against every
      // invoice ever captured, so deleting old ones would make them read as
      // MISSING on a later statement. Only the list is capped; report the true
      // total so "All" can't quietly pretend it's showing everything.
      const { rows: cnt } = await pool.query('SELECT COUNT(*)::int AS n FROM vendor_invoice WHERE location_id=$1', [req.params.locationId]);
      const base = ORDER_URL;
      res.json({
        total_count: cnt[0].n,
        invoices: rows.map((r) => ({
          ...r,
          total: r.total_cents != null ? r.total_cents / 100 : null,
          subtotal: r.subtotal_cents != null ? r.subtotal_cents / 100 : null,
          ro_parts_cost: r.ro_parts_cost_cents != null ? r.ro_parts_cost_cents / 100 : null,
          job_paid: r.job_paid_cents != null ? r.job_paid_cents / 100 : null,
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
      let orderId = null, orderNum = null, orderInvoiced = null, wo = null;
      if (m.status === 'matched' && m.order) {
        orderId = m.order.order_id; orderNum = m.order.order_number; orderInvoiced = m.order.invoiced;
        try { wo = await woParts(apiKey, orderId); } catch { /* null */ }
      }
      const roCost = wo ? wo.costCents : null;
      const findings = wo ? lineCheck(inv.line_items, wo.parts, orderInvoiced === true) : [];
      await pool.query('UPDATE vendor_invoice SET ro_ref=$2, matched_order_id=$3, matched_order_number=$4, match_status=$5, match_candidates=$6, ro_parts_cost_cents=$7, line_findings=$8 WHERE id=$1',
        [inv.id, ref, orderId, orderNum, m.status, JSON.stringify(m.candidates || []), roCost, JSON.stringify(findings)]);
      let rec = { status: 'pending', note: 'Not matched to a work order yet.' };
      if (orderId) ({ rec } = await rollUpJob(inv.location_id, orderId, roCost, orderInvoiced));
      else await pool.query('UPDATE vendor_invoice SET recon_status=$2, recon_note=$3 WHERE id=$1', [inv.id, rec.status, rec.note]);
      res.json({ ok: true, match_status: m.status, matched_order_number: orderNum, candidates: m.candidates, recon_status: rec.status, recon_note: rec.note, line_findings: findings });
    } catch (e) { fail(res, e); }
  });

  // Quick view: the original scan/PDF, so the owner can eyeball an invoice when
  // confirming a match. Auth'd + location-scoped; streamed, not inlined in the list.
  router.get('/invoice/:id/file', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    try {
      await ensurePartsReconTables(pool);
      const { rows } = await pool.query('SELECT location_id, file_data, file_mime, vendor, invoice_number FROM vendor_invoice WHERE id=$1', [req.params.id]);
      if (!rows.length) return fail(res, 'Invoice not found', 404);
      const r = rows[0];
      if (!canAccessLocation(req.user, r.location_id)) return fail(res, 'Access denied for this location', 403);
      if (!r.file_data) return fail(res, 'No scan stored for this invoice (it predates file storage, or came in as structured data).', 404);
      const name = `${(r.vendor || 'invoice').replace(/[^\w-]+/g, '-')}-${r.invoice_number || ''}`.replace(/-+$/, '');
      res.setHeader('Content-Type', r.file_mime || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${name}"`);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(r.file_data);
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
      const { rows: lr2 } = await pool.query('SELECT shopmonkey_location_id FROM locations WHERE id=$1', [inv.location_id]);
      const smLoc2 = lr2[0] && lr2[0].shopmonkey_location_id;
      // Need the RO's invoiced state first — an open job gets no verdict and no
      // per-line flags.
      let orderInvoiced = null;
      try { const o = await fetchOrderByNumber(apiKey, smLoc2, String(b.order_number)); if (o.length) orderInvoiced = !!o[0].invoiced; } catch { /* unknown */ }
      let wo = null; try { wo = await woParts(apiKey, b.order_id); } catch { /* null */ }
      const roCost = wo ? wo.costCents : null;
      const findings = wo ? lineCheck(inv.line_items, wo.parts, orderInvoiced === true) : [];
      await pool.query("UPDATE vendor_invoice SET matched_order_id=$2, matched_order_number=$3, match_status='confirmed', ro_parts_cost_cents=$4, line_findings=$5, decided_by=$6, decided_at=now() WHERE id=$1",
        [inv.id, b.order_id, String(b.order_number), roCost, JSON.stringify(findings), who(req)]);
      const { rec } = await rollUpJob(inv.location_id, b.order_id, roCost, orderInvoiced);
      res.json({ ok: true, recon_status: rec.status, recon_note: rec.note, line_findings: findings });
    } catch (e) { fail(res, e); }
  });

  // "Actually, this IS parts" — reclassify a parked document and run it through
  // the normal pipeline. Re-reads the stored scan so it gets a real match rather
  // than inheriting the extraction that mis-called it.
  router.put('/invoice/:id/is-parts', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    try {
      await ensurePartsReconTables(pool);
      const { rows } = await pool.query('SELECT * FROM vendor_invoice WHERE id=$1', [req.params.id]);
      if (!rows.length) return fail(res, 'Invoice not found', 404);
      const inv = rows[0];
      if (!canAccessLocation(req.user, inv.location_id)) return fail(res, 'Access denied for this location', 403);
      const { rows: lr } = await pool.query('SELECT shopmonkey_location_id FROM locations WHERE id=$1', [inv.location_id]);
      const smLoc = lr[0] && lr[0].shopmonkey_location_id;
      if (!smLoc) return fail(res, 'Location not connected to Shopmonkey', 400);
      if (inv.file_data) {
        const mime = inv.file_mime || 'application/pdf';
        const out = await ingestFile(inv.location_id, smLoc, process.env.SHOPMONKEY_API_KEY, inv.file_data.toString('base64'), mime, inv.source || 'upload', false, true);
        // The re-read supersedes the parked row unless it landed on the same one.
        if (out.id && out.id !== inv.id) { console.warn(`[parts-delete] INVOICE ${inv.id} superseded by re-read ${out.id} (is-parts) by ${req.user && req.user.email}`); await pool.query('DELETE FROM vendor_invoice WHERE id=$1', [inv.id]); }
        else await pool.query('UPDATE vendor_invoice SET not_parts=false WHERE id=$1', [inv.id]);
        return res.json({ ok: true, reread: true, ...out });
      }
      // No stored scan (it reconciled clean and the image was dropped) — just
      // un-park it and re-match on what we already extracted.
      await pool.query("UPDATE vendor_invoice SET not_parts=false, match_status='pending' WHERE id=$1", [inv.id]);
      res.json({ ok: true, reread: false });
    } catch (e) { fail(res, e); }
  });

  // Remove a claim outright (test data, or one raised in error).
  router.delete('/warranty/:id', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT location_id FROM warranty_claim WHERE id=$1', [req.params.id]);
      if (!rows.length) return fail(res, 'Claim not found', 404);
      if (!canAccessLocation(req.user, rows[0].location_id)) return fail(res, 'Access denied for this location', 403);
      await pool.query('DELETE FROM warranty_claim WHERE id=$1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  router.delete('/invoice/:id', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    try {
      const { rows: ir } = await pool.query('SELECT location_id FROM vendor_invoice WHERE id=$1', [req.params.id]);
      if (!ir.length) return res.json({ ok: true });
      if (!canAccessLocation(req.user, ir[0].location_id)) return fail(res, 'Access denied for this location', 403);
      console.warn(`[parts-delete] INVOICE ${req.params.id} deleted by ${req.user && req.user.email} (${req.user && req.user.role}) ip=${req.ip} ua=${(req.headers['user-agent'] || '').slice(0, 60)}`);
      await pool.query("DELETE FROM warranty_claim WHERE invoice_id=$1 AND status='awaiting'", [req.params.id]);
      await pool.query('DELETE FROM vendor_invoice WHERE id=$1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Always-on poller (dark until configured): every PARTS_INBOX_POLL_MIN minutes,
  // sweep each configured location's inbox into that location. Single Railway
  // instance, re-entrancy-guarded, and \Seen prevents double-ingest.
  const POLL_MIN = Number(process.env.PARTS_INBOX_POLL_MIN || 0);
  const anyInboxConfigured = !!(process.env.PARTS_INBOX_MAP || process.env.PARTS_IMAP_USER || process.env.GMAIL_IMAP_USER);
  if (POLL_MIN > 0 && pollLocations().length && anyInboxConfigured) {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        for (const loc of pollLocations()) {
          // Drain a backlog across several paced passes rather than trickling one
          // capped batch per interval — a month-end dump still clears in minutes,
          // without ever hammering ShopMonkey.
          for (let pass = 0; pass < 8; pass++) {
            const r = await scanInboxInto(loc);
            if (!r || !r.ok) { if (r) console.warn(`[parts-inbox] ${loc}:`, r.error); break; }
            if (r.processed) console.log(`[parts-inbox] filed ${r.processed} document(s) into ${loc}${r.more ? ' — more waiting' : ''}`);
            if (!r.more || !r.scanned) break;
            await sleep(15000);
          }
        }
      } catch (e) { console.error('[parts-inbox] poll error:', e.message); }
      finally { running = false; }
    };
    setInterval(tick, POLL_MIN * 60 * 1000).unref?.();
    setTimeout(tick, 20 * 1000).unref?.();   // first pass shortly after boot
    console.log(`[parts-inbox] poller on — every ${POLL_MIN}m across ${pollLocations().length} location(s)`);
  }

  return router;
};
