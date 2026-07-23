// Review-request texts: pure decision/formatting logic, no network and no DB.
// Kept side-effect free so scripts/test-review-requests.js can replay it —
// the route (routes/reviewRequests.js) owns Shopmonkey calls and the log table.
//
// CASL posture: this is a one-time, post-service ask to an active customer
// (existing business relationship), sent through Shopmonkey's own inbox. The
// template stays transactional-toned — no offers, no promo — and always
// carries an opt-out line. Warranty/comeback visits ($0 subtotal) are never
// asked: same order-value definition the revenue metrics use.

const DEFAULT_TEMPLATE =
  'Hi {first} — thanks for trusting {shop} with your vehicle. ' +
  'If we earned it, a quick Google review would mean a lot: {link} ' +
  'Reply STOP to opt out.';

// Send window: local daytime only. The 2h scheduler ticks around the clock;
// out-of-window ticks are cheap no-ops and eligible orders are picked up by
// the next in-window tick (the lookback is days, not hours).
const WINDOW_START_HOUR = 9;   // inclusive, local
const WINDOW_END_HOUR = 19;    // exclusive, local
const DEFAULT_TZ = 'America/Edmonton';

const subtotalCents = (o) =>
  (o.partsCents || 0) + (o.laborCents || 0) + (o.shopSuppliesCents || 0) +
  (o.subcontractsCents || 0) + (o.tiresCents || 0);

// Which invoiced orders deserve an ask this run. One ask per customer per run,
// oldest invoice first, capped — a burst of invoices never becomes a text blast.
function selectEligible(orders, { alreadyLogged, recentCustomerIds, now = new Date(), lookbackDays = 3, cap = 15 }) {
  const cutoff = now.getTime() - lookbackDays * 24 * 60 * 60 * 1000;
  const eligible = [];
  for (const o of orders || []) {
    if (!o || o.deleted) continue;
    if (!o.invoicedDate || o.invoicedDate === 'empty') continue;
    const inv = new Date(o.invoicedDate);
    if (isNaN(inv.getTime()) || inv.getTime() < cutoff) continue;
    if (subtotalCents(o) <= 0) continue;              // comeback/warranty — never ask
    if (!o.customerId) continue;
    if (alreadyLogged.has(o.id)) continue;            // one ask per order, ever
    if (recentCustomerIds.has(o.customerId)) continue; // cooldown across orders
    eligible.push(o);
  }
  eligible.sort((a, b) => new Date(a.invoicedDate) - new Date(b.invoicedDate));
  const seenCustomer = new Set();
  const out = [];
  for (const o of eligible) {
    if (seenCustomer.has(o.customerId)) continue;
    seenCustomer.add(o.customerId);
    out.push(o);
    if (out.length >= cap) break;
  }
  return out;
}

function inSendWindow(now = new Date(), tz = DEFAULT_TZ) {
  let hour;
  try {
    hour = parseInt(new Intl.DateTimeFormat('en-CA', { timeZone: tz || DEFAULT_TZ, hour12: false, hour: '2-digit' })
      .format(now), 10);
  } catch (e) {
    hour = parseInt(new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TZ, hour12: false, hour: '2-digit' })
      .format(now), 10);
  }
  return hour >= WINDOW_START_HOUR && hour < WINDOW_END_HOUR;
}

// Effective review link: explicit override wins; otherwise derived from the
// same google_place_id the reviews scorecard uses, so a configured scorecard
// means review requests need zero extra setup.
function deriveReviewLink({ review_req_link, google_place_id }) {
  const custom = (review_req_link || '').trim();
  if (custom) return { link: custom, source: 'custom' };
  const placeId = (google_place_id || '').trim();
  if (placeId) return { link: `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`, source: 'place_id' };
  return { link: null, source: null };
}

function renderTemplate(template, { name, shop, link }) {
  const full = (name || '').trim();
  const first = full.split(/\s+/)[0] || 'there';
  return (template || DEFAULT_TEMPLATE)
    .replace(/\{first\}/g, first)
    .replace(/\{name\}/g, full || 'there')
    .replace(/\{shop\}/g, shop || 'our shop')
    .replace(/\{link\}/g, link || '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Shopmonkey customer flags vary by account age/plan; treat ANY opt-out-ish
// flag as a hard no. Missing customer = no.
function customerOptedOut(c) {
  if (!c) return true;
  return ['optOutSms', 'smsOptOut', 'doNotContact', 'doNotText', 'marketingOptOut', 'optedOutOfSms']
    .some((f) => c[f] === true);
}

// Best number to text: skip per-number opt-outs, prefer primary then
// mobile/cell-labelled. Null when the customer has no textable number.
function pickPhone(c) {
  const phones = Array.isArray(c && c.phoneNumbers) ? c.phoneNumbers : [];
  const ok = phones.filter((p) => p && p.number && p.optOut !== true && p.smsOptOut !== true);
  if (!ok.length) return null;
  return ok.find((p) => p.primary === true) ||
    ok.find((p) => /mobile|cell/i.test(String(p.type || p.label || ''))) ||
    ok[0];
}

module.exports = {
  DEFAULT_TEMPLATE, DEFAULT_TZ, WINDOW_START_HOUR, WINDOW_END_HOUR,
  selectEligible, inSendWindow, deriveReviewLink, renderTemplate,
  customerOptedOut, pickPhone, subtotalCents,
};
