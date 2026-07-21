// Vendor-invoice extraction + RO matching + reconciliation (parts recon v1b).
const { fetchOrderService, fetchOrderByNumber, fetchRecentInvoicedOrders, fetchRecentOrders } = require('./shopmonkey');

const digits = (s) => String(s || '').replace(/\D/g, '');
const dollarsToCents = (v) => (v == null ? null : Math.round(Number(v) * 100));

// AI-extract a scanned supplier invoice into structured fields via Claude vision
// with a forced tool call. Accepts a base64 image or PDF.
async function extractInvoice(fileBase64, mediaType) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured');
  const isPdf = /pdf/i.test(mediaType || '');
  const block = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: fileBase64 } };
  const tool = {
    name: 'record_invoice',
    description: 'Record the structured data read from this supplier/vendor parts invoice.',
    input_schema: {
      type: 'object',
      properties: {
        is_statement: { type: 'boolean', description: 'TRUE only if this document is actually a monthly ACCOUNT STATEMENT that lists many invoices / an aging summary — not a single invoice. If unsure, false.' },
        vendor: { type: 'string', description: 'Supplier/vendor business name' },
        invoice_number: { type: 'string', description: "The vendor's invoice number" },
        invoice_date: { type: 'string', description: 'Invoice date as YYYY-MM-DD' },
        subtotal: { type: 'number', description: 'Pre-tax parts subtotal in dollars (before GST/PST/freight)' },
        total: { type: 'number', description: 'Grand total in dollars' },
        ro_ref: { type: 'string', description: 'The repair-order / work-order / PO reference the shop wrote on the invoice — often just the last 4 digits of the RO number. Empty string if none is present.' },
        line_items: {
          type: 'array',
          items: { type: 'object', properties: { part_number: { type: 'string' }, description: { type: 'string' }, qty: { type: 'number' }, unit_cost: { type: 'number' }, amount: { type: 'number' } } },
        },
      },
      required: ['vendor', 'total'],
    },
  };
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  if (isPdf) headers['anthropic-beta'] = 'pdfs-2024-09-25';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers,
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 1500,
      tool_choice: { type: 'tool', name: 'record_invoice' }, tools: [tool],
      messages: [{ role: 'user', content: [block, { type: 'text', text: 'Extract this parts invoice. The RO/PO reference is the work-order number the shop handwrote or stamped on it (frequently only the last 4 digits). All amounts in dollars.' }] }],
    }),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`invoice extract ${r.status}: ${t.slice(0, 200)}`); }
  const j = await r.json();
  const use = (j.content || []).find((c) => c.type === 'tool_use');
  if (!use) throw new Error('No structured extraction returned');
  const x = use.input || {};
  return {
    is_statement: !!x.is_statement,
    vendor: x.vendor || null, invoice_number: x.invoice_number || null,
    invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(x.invoice_date || '') ? x.invoice_date : null,
    subtotal_cents: dollarsToCents(x.subtotal), total_cents: dollarsToCents(x.total),
    ro_ref: (x.ro_ref || '').toString().trim() || null,
    line_items: Array.isArray(x.line_items) ? x.line_items : [],
    raw: x,
  };
}

// AI-extract a monthly vendor STATEMENT — the list of every invoice the supplier
// billed us in the period — via Claude vision + forced tool call. Statements can
// be long (many rows), so give it room.
async function extractStatement(fileBase64, mediaType) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured');
  const isPdf = /pdf/i.test(mediaType || '');
  const block = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: fileBase64 } };
  const tool = {
    name: 'record_statement',
    description: 'Record the list of invoices from a monthly vendor/supplier account STATEMENT.',
    input_schema: {
      type: 'object',
      properties: {
        vendor: { type: 'string', description: 'Supplier/vendor business name on the statement' },
        statement_date: { type: 'string', description: 'Statement date as YYYY-MM-DD' },
        period: { type: 'string', description: 'Statement period label, e.g. "June 2026"' },
        total: { type: 'number', description: 'Statement grand total / balance in dollars, if shown' },
        invoices: {
          type: 'array',
          description: 'One entry per INVOICE line on the statement. Include only invoices/charges — skip payment, credit, and running-balance rows.',
          items: {
            type: 'object',
            properties: {
              invoice_number: { type: 'string', description: 'The invoice/document number' },
              invoice_date: { type: 'string', description: 'Date as YYYY-MM-DD' },
              amount: { type: 'number', description: 'Invoice amount in dollars (the charge, positive)' },
            },
            required: ['invoice_number'],
          },
        },
      },
      required: ['vendor', 'invoices'],
    },
  };
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  if (isPdf) headers['anthropic-beta'] = 'pdfs-2024-09-25';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers,
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 8000,
      tool_choice: { type: 'tool', name: 'record_statement' }, tools: [tool],
      messages: [{ role: 'user', content: [block, { type: 'text', text: 'This is a monthly account statement from a parts supplier. List every INVOICE it shows (number, date, amount in dollars). Skip payment, credit, finance-charge, and balance-forward rows — only actual invoices.' }] }],
    }),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`statement extract ${r.status}: ${t.slice(0, 200)}`); }
  const j = await r.json();
  const use = (j.content || []).find((c) => c.type === 'tool_use');
  if (!use) throw new Error('No structured statement extraction returned');
  const x = use.input || {};
  const invoices = (Array.isArray(x.invoices) ? x.invoices : []).map((it) => ({
    invoice_number: (it.invoice_number || '').toString().trim() || null,
    invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(it.invoice_date || '') ? it.invoice_date : null,
    amount_cents: dollarsToCents(it.amount),
  })).filter((it) => it.invoice_number || it.amount_cents != null);
  return {
    vendor: x.vendor || null,
    statement_date: /^\d{4}-\d{2}-\d{2}$/.test(x.statement_date || '') ? x.statement_date : null,
    period: (x.period || '').toString().trim() || null,
    total_cents: dollarsToCents(x.total),
    invoices,
    raw: x,
  };
}

// Sum of wholesale parts cost captured on a repair order (what ShopMonkey has).
async function roPartsCostCents(apiKey, orderId) {
  const lines = await fetchOrderService(apiKey, orderId);
  let c = 0;
  for (const ln of lines) for (const p of (ln.parts || [])) c += (Number(p.wholesaleCostCents || p.originalWholesaleCostCents || 0)) * (Number(p.quantity) || 1);
  return Math.round(c);
}

// The parts on a work order + their total cost, in one fetch.
async function woParts(apiKey, orderId) {
  const lines = await fetchOrderService(apiKey, orderId);
  const parts = [];
  let cost = 0;
  for (const ln of lines) for (const p of (ln.parts || [])) {
    const qty = Number(p.quantity) || 1;
    const wc = Number(p.wholesaleCostCents || p.originalWholesaleCostCents || 0);
    parts.push({ partNumber: p.partNumber || null, name: p.name || null, quantity: qty, wholesaleCostCents: wc });
    cost += wc * qty;
  }
  return { parts, costCents: Math.round(cost) };
}

// Placeholder part numbers the shop types when there isn't a real one — never
// force a match on these, or every generic line false-flags.
const GENERIC_PART = new Set(['NPN', 'MISC', 'NA', 'N', 'NONE', 'TBD', 'VARIOUS', 'SHOP', 'FREIGHT', '']);
const normPart = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// PER-LINE CHECK — only runs once the work order is COMPLETE/CLOSED (invoiced).
// For each part on the invoice, prove it's attached to the WO at the right cost:
//   1. Part number matches a real part number on the WO → the cost must agree,
//      else flag `cost_off` (cost entered wrong).
//   2. No part-number match → fingerprint by COST. The shop enters most WO parts
//      generically (npn / MISC / blank), but the cost still lines up — verified
//      live: invoice S277201BK $189 is on the WO as "bearing kit / npn / $189".
//      A cost hit means it IS attached and costed right, so stay quiet.
//   3. Neither → flag `not_accounted`: we paid for it and can't find it on the
//      WO at that cost (missing line, or the cost is wrong).
// Each WO part can only be claimed once, so two invoice lines can't both match it.
function lineCheck(lineItems, parts, orderClosed) {
  if (!orderClosed) return [];
  const list = parts || [];
  const byNum = new Map();
  list.forEach((p, i) => {
    const n = normPart(p.partNumber);
    if (n && !GENERIC_PART.has(n) && !byNum.has(n)) byNum.set(n, i);
  });
  const claimed = new Set();
  const out = [];
  for (const li of (lineItems || [])) {
    const inv = li.unit_cost != null ? Math.round(Number(li.unit_cost) * 100)
      : (li.amount != null ? Math.round(Number(li.amount) * 100) : null);
    const n = normPart(li.part_number);
    // 1) real part number on both sides → the cost has to be right
    if (n && !GENERIC_PART.has(n) && byNum.has(n)) {
      const idx = byNum.get(n); const p = list[idx];
      claimed.add(idx);
      if (inv != null && p.wholesaleCostCents) {
        const diff = inv - p.wholesaleCostCents;
        const tol = Math.max(200, Math.round(p.wholesaleCostCents * 0.05));
        if (Math.abs(diff) > tol) out.push({ part_number: li.part_number, status: 'cost_off', invoice_cost_cents: inv, wo_cost_cents: p.wholesaleCostCents, diff_cents: diff });
      }
      continue;
    }
    if (inv == null) continue;                    // no cost to fingerprint with → can't judge
    // 2) generic on the WO → match by cost
    const hit = list.findIndex((p, i) => !claimed.has(i) && p.wholesaleCostCents
      && Math.abs(p.wholesaleCostCents - inv) <= Math.max(100, Math.round(inv * 0.01)));
    if (hit >= 0) { claimed.add(hit); continue; }
    // 3) not attached at that cost
    out.push({ part_number: li.part_number || null, description: li.description || null, status: 'not_accounted', invoice_cost_cents: inv });
  }
  return out;
}

// JOB-TOTAL ROLL-UP — the primary flag. Compare every supplier invoice matched
// to a work order against the total parts cost on that WO. Needs no part-number
// matching, so it survives generic/blank part entry. Only a final verdict once
// the job is invoiced; while it's open we're still collecting invoices.
function reconcileJob(paidCents, woCostCents, orderInvoiced) {
  const d = (c) => '$' + (c / 100).toFixed(2);
  if (woCostCents == null || paidCents == null) return { status: 'pending', note: 'Not matched to a work order yet.' };
  if (orderInvoiced === false) return { status: 'pending', note: `Job still open — invoices so far ${d(paidCents)} vs ${d(woCostCents)} of parts on the WO. Settles when it's invoiced.` };
  const gap = paidCents - woCostCents;
  const tol = Math.max(5000, Math.round(woCostCents * 0.10));   // $50 or 10%
  if (gap > tol) return { status: 'underlogged', note: `Paid ${d(paidCents)} in supplier invoices but only ${d(woCostCents)} of parts cost is on this WO — ${d(gap)} may not be billed out.` };
  if (gap < -tol) return { status: 'variance', note: `WO shows ${d(woCostCents)} of parts but only ${d(paidCents)} of invoices are in — an invoice may still be missing (the statement check will confirm).` };
  return { status: 'ok', note: `Supplier invoices ${d(paidCents)} ≈ ${d(woCostCents)} of parts cost on the WO.` };
}

// Match an invoice to its RO by the ref stamped on it: full RO number = exact,
// else last-4 disambiguated by invoice-date proximity. Scoped to the shop.
async function matchInvoiceToRo(apiKey, smLocationId, { ro_ref, invoice_date }) {
  const ref = digits(ro_ref);
  if (!ref) return { status: 'unmatched', candidates: [] };
  const invDate = invoice_date ? new Date(invoice_date + 'T12:00:00Z') : new Date();
  const retry = async (fn) => { let e; for (let a = 0; a < 3; a++) { try { return await fn(); } catch (x) { e = x; await new Promise((r) => setTimeout(r, 500 * (a + 1))); } } throw e; };

  // Full RO number → exact lookup (1 cheap call). Short "PO" (the last-N digits
  // the shop writes, e.g. 0549 for RO 10600549) → reconstruct the full number by
  // borrowing the constant prefix from a sample order and look it up EXACTLY.
  // Exact lookup finds OPEN estimates too (a parts invoice usually arrives before
  // the RO is invoiced) and dodges the list endpoint's flakiness. Suffix-scan is
  // only a fallback for oddballs.
  let exact = [], pool = [];
  try {
    if (ref.length >= 7) {
      exact = await retry(() => fetchOrderByNumber(apiKey, smLocationId, ref));
      pool = exact;
    } else {
      // Learn the RO-number prefix from INVOICED orders — they always carry a
      // clean fixed-width number (10600549). (The all-status list is mostly
      // negative junk numbers from unsaved draft estimates, useless for this.)
      const sample = await retry(() => fetchRecentInvoicedOrders(apiKey, smLocationId, 100));
      const reals = sample.filter((o) => Number(o.number) > 0).map((o) => digits(o.number)).filter((dn) => dn.length > ref.length);
      const fulls = [...new Set(reals.map((dn) => dn.slice(0, dn.length - ref.length) + ref))].slice(0, 4);
      for (const full of fulls) {   // prefix + PO → full RO number, look up exactly
        const hit = await retry(() => fetchOrderByNumber(apiKey, smLocationId, full));
        if (hit.length) { exact = hit; pool = hit; break; }
      }
      if (!pool.length) {   // fallback: suffix-scan recent orders (real numbers only)
        const recent = await retry(() => fetchRecentOrders(apiKey, smLocationId, 400));
        const last4 = ref.slice(-4);
        const real = recent.filter((o) => Number(o.number) > 0);
        exact = real.filter((o) => digits(o.number) === ref);
        pool = exact.length ? exact : real.filter((o) => digits(o.number).endsWith(last4));
      }
    }
  } catch (e) { return { status: 'unmatched', candidates: [], error: e.message }; }
  if (!pool.length) return { status: 'unmatched', candidates: [] };
  const scored = pool.map((o) => {
    const dstr = o.invoicedDate && o.invoicedDate !== 'empty' ? o.invoicedDate : o.createdDate;
    const od = dstr ? new Date(dstr).getTime() : 0;
    return { order_id: o.id, order_number: String(o.number), invoiced: !!o.invoiced, invoiced_date: o.invoicedDate, day_gap: Math.round(Math.abs(od - invDate.getTime()) / 86400000) };
  }).sort((a, b) => a.day_gap - b.day_gap);
  if (exact.length === 1) return { status: 'matched', order: scored[0], candidates: scored.slice(0, 5) };
  const clear = scored.length === 1 || (scored[0].day_gap <= 30 && (scored.length < 2 || scored[1].day_gap - scored[0].day_gap >= 14));
  return { status: clear ? 'matched' : 'ambiguous', order: clear ? scored[0] : null, candidates: scored.slice(0, 6) };
}

// Compare what we paid (invoice, pre-tax where available) to what the RO
// captured. Generous tolerance — the signal is a WHOLE part missing, not tax
// noise. A flag, not a verdict; the human confirms.
function reconcile(invoicePaidCents, roCostCents) {
  if (roCostCents == null || invoicePaidCents == null) return { status: 'pending', note: 'Not matched to an RO yet.' };
  const gap = invoicePaidCents - roCostCents;   // + = paid more than captured
  const tol = Math.max(5000, Math.round(invoicePaidCents * 0.25));   // $50 or 25%
  const d = (c) => '$' + (c / 100).toFixed(2);
  if (gap > tol) return { status: 'underlogged', note: `Paid ${d(invoicePaidCents)} but only ${d(roCostCents)} of parts cost is on the RO — ${d(gap)} may not have been billed out. Worth a look.` };
  if (gap < -tol) return { status: 'variance', note: `The RO's parts cost (${d(roCostCents)}) is higher than this invoice (${d(invoicePaidCents)}) — likely multiple invoices on the job or matrix pricing.` };
  return { status: 'ok', note: `Invoice ${d(invoicePaidCents)} ≈ ${d(roCostCents)} captured on the RO.` };
}

module.exports = { extractInvoice, extractStatement, roPartsCostCents, woParts, lineCheck, reconcileJob, matchInvoiceToRo, reconcile, digits };
