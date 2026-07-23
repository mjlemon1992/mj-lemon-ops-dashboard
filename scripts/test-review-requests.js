// Replay tests for the review-request decision logic (server/lib/reviewRequests.js).
// Pure logic only — no network, no DB. Run before touching the eligibility rules:
//   node scripts/test-review-requests.js

const assert = require('assert');
const {
  selectEligible, inSendWindow, deriveReviewLink, renderTemplate,
  customerOptedOut, pickPhone, DEFAULT_TEMPLATE,
} = require('../server/lib/reviewRequests');

let passed = 0;
const t = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

const NOW = new Date('2026-07-23T18:00:00Z');
const day = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const order = (over) => ({
  id: 'o1', customerId: 'c1', number: 1001, invoicedDate: day(1),
  laborCents: 50000, partsCents: 30000, ...over,
});
const noSets = { alreadyLogged: new Set(), recentCustomerIds: new Set(), now: NOW };

console.log('selectEligible');
t('picks a fresh invoiced order', () => {
  assert.strictEqual(selectEligible([order()], noSets).length, 1);
});
t('skips orders older than the lookback', () => {
  assert.strictEqual(selectEligible([order({ invoicedDate: day(5) })], noSets).length, 0);
});
t('skips $0 subtotal (comeback/warranty) orders', () => {
  assert.strictEqual(selectEligible([order({ laborCents: 0, partsCents: 0 })], noSets).length, 0);
});
t('skips deleted, missing-customer and never-invoiced orders', () => {
  const rows = [order({ deleted: true }), order({ id: 'o2', customerId: null }),
    order({ id: 'o3', invoicedDate: null }), order({ id: 'o4', invoicedDate: 'empty' })];
  assert.strictEqual(selectEligible(rows, noSets).length, 0);
});
t('never re-asks an order already in the log', () => {
  assert.strictEqual(selectEligible([order()], { ...noSets, alreadyLogged: new Set(['o1']) }).length, 0);
});
t('honours the per-customer cooldown', () => {
  assert.strictEqual(selectEligible([order()], { ...noSets, recentCustomerIds: new Set(['c1']) }).length, 0);
});
t('one ask per customer per run, oldest order wins', () => {
  const rows = [order({ id: 'newer', invoicedDate: day(0.5) }), order({ id: 'older', invoicedDate: day(2) })];
  const got = selectEligible(rows, noSets);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].id, 'older');
});
t('caps a burst of invoices', () => {
  const rows = Array.from({ length: 40 }, (_, i) => order({ id: `o${i}`, customerId: `c${i}` }));
  assert.strictEqual(selectEligible(rows, { ...noSets, cap: 15 }).length, 15);
});

console.log('inSendWindow');
t('open mid-day, closed early morning (Mountain)', () => {
  assert.strictEqual(inSendWindow(new Date('2026-07-23T18:00:00Z'), 'America/Edmonton'), true);  // 12:00 MDT
  assert.strictEqual(inSendWindow(new Date('2026-07-23T09:00:00Z'), 'America/Edmonton'), false); // 03:00 MDT
});
t('respects the location timezone', () => {
  // 01:30 UTC = 18:30 Pacific (open) but 19:30 Mountain (closed)
  const d = new Date('2026-07-24T01:30:00Z');
  assert.strictEqual(inSendWindow(d, 'America/Vancouver'), true);
  assert.strictEqual(inSendWindow(d, 'America/Edmonton'), false);
});
t('bad timezone falls back instead of throwing', () => {
  assert.doesNotThrow(() => inSendWindow(NOW, 'Not/AZone'));
});

console.log('deriveReviewLink');
t('custom link wins over place id', () => {
  const got = deriveReviewLink({ review_req_link: 'https://g.page/r/abc', google_place_id: 'PID' });
  assert.deepStrictEqual(got, { link: 'https://g.page/r/abc', source: 'custom' });
});
t('derives the write-review link from google_place_id', () => {
  const got = deriveReviewLink({ review_req_link: '', google_place_id: 'ChIJ123' });
  assert.strictEqual(got.source, 'place_id');
  assert.ok(got.link.includes('writereview?placeid=ChIJ123'));
});
t('null when nothing is configured', () => {
  assert.deepStrictEqual(deriveReviewLink({}), { link: null, source: null });
});

console.log('renderTemplate');
t('default template fills first name, shop and link', () => {
  const msg = renderTemplate(null, { name: 'Pat Smith', shop: 'Mister Transmission Kelowna', link: 'https://x' });
  assert.ok(msg.startsWith('Hi Pat —'));
  assert.ok(msg.includes('Mister Transmission Kelowna'));
  assert.ok(msg.includes('https://x'));
  assert.ok(/stop/i.test(msg));
});
t('missing name degrades to "there"', () => {
  assert.ok(renderTemplate(null, { name: '', shop: 'S', link: 'L' }).startsWith('Hi there'));
});
t('custom template placeholders all substitute', () => {
  const msg = renderTemplate('{name} / {first} / {shop} / {link}', { name: 'A B', shop: 'S', link: 'L' });
  assert.strictEqual(msg, 'A B / A / S / L');
});
t('default template mentions no offers or promos', () => {
  assert.ok(!/(\$|%|offer|deal|discount|book)/i.test(DEFAULT_TEMPLATE));
});

console.log('customerOptedOut / pickPhone');
t('any opt-out-ish flag blocks; missing customer blocks', () => {
  assert.strictEqual(customerOptedOut(null), true);
  assert.strictEqual(customerOptedOut({ smsOptOut: true }), true);
  assert.strictEqual(customerOptedOut({ doNotContact: true }), true);
  assert.strictEqual(customerOptedOut({ firstName: 'A' }), false);
});
t('prefers primary, then mobile-labelled; skips per-number opt-outs', () => {
  assert.strictEqual(pickPhone({ phoneNumbers: [] }), null);
  assert.strictEqual(pickPhone({ phoneNumbers: [{ number: '1', optOut: true }] }), null);
  assert.strictEqual(pickPhone({
    phoneNumbers: [{ id: 'a', number: '1' }, { id: 'b', number: '2', primary: true }],
  }).id, 'b');
  assert.strictEqual(pickPhone({
    phoneNumbers: [{ id: 'a', number: '1', type: 'Home' }, { id: 'b', number: '2', type: 'Mobile' }],
  }).id, 'b');
});

console.log(process.exitCode ? `\nFAILED (${passed} passed)` : `\nAll ${passed} tests passed.`);
