// Vendor-invoice extraction + RO matching + reconciliation (parts recon v1b).
const { fetchOrderService, fetchOrderByNumber, fetchRecentInvoicedOrders } = require('./shopmonkey');

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
    vendor: x.vendor || null, invoice_number: x.invoice_number || null,
    invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(x.invoice_date || '') ? x.invoice_date : null,
    subtotal_cents: dollarsToCents(x.subtotal), total_cents: dollarsToCents(x.total),
    ro_ref: (x.ro_ref || '').toString().trim() || null,
    line_items: Array.isArray(x.line_items) ? x.line_items : [],
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

// Match an invoice to its RO by the ref stamped on it: full RO number = exact,
// else last-4 disambiguated by invoice-date proximity. Scoped to the shop.
async function matchInvoiceToRo(apiKey, smLocationId, { ro_ref, invoice_date }) {
  const ref = digits(ro_ref);
  if (!ref) return { status: 'unmatched', candidates: [] };
  const invDate = invoice_date ? new Date(invoice_date + 'T12:00:00Z') : new Date();
  const retry = async (fn) => { let e; for (let a = 0; a < 3; a++) { try { return await fn(); } catch (x) { e = x; await new Promise((r) => setTimeout(r, 500 * (a + 1))); } } throw e; };

  // Full RO number → exact lookup (1 cheap call). Last-4/partial → the most
  // recent invoiced orders (single page, not a full sweep) filtered by suffix.
  let exact = [], pool = [];
  try {
    if (ref.length >= 7) {
      exact = await retry(() => fetchOrderByNumber(apiKey, smLocationId, ref));
      pool = exact;
    } else {
      const recent = await retry(() => fetchRecentInvoicedOrders(apiKey, smLocationId, 200));
      const last4 = ref.slice(-4);
      exact = recent.filter((o) => digits(o.number) === ref);
      pool = exact.length ? exact : recent.filter((o) => digits(o.number).endsWith(last4));
    }
  } catch (e) { return { status: 'unmatched', candidates: [], error: e.message }; }
  if (!pool.length) return { status: 'unmatched', candidates: [] };
  const scored = pool.map((o) => {
    const od = o.invoicedDate ? new Date(o.invoicedDate).getTime() : 0;
    return { order_id: o.id, order_number: String(o.number), invoiced_date: o.invoicedDate, day_gap: Math.round(Math.abs(od - invDate.getTime()) / 86400000) };
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

module.exports = { extractInvoice, roPartsCostCents, matchInvoiceToRo, reconcile, digits };
