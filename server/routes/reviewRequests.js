const express = require('express');
const { syncAuth, authenticateToken, requireOwner, requireRole, canAccessLocation } = require('../middleware/auth');
const { fetchRecentInvoicedOrders } = require('../lib/shopmonkey');
const {
  DEFAULT_TEMPLATE, DEFAULT_TZ, selectEligible, inSendWindow, deriveReviewLink,
  renderTemplate, customerOptedOut, pickPhone,
} = require('../lib/reviewRequests');

// Marketing: post-service Google review request texts — the one Shopmonkey CRM
// feature we actually used, rebuilt in-house (2026-07: skipped the $175/mo CRM
// add-on for Kelowna).
//
// TWO MODES (per location):
//   manual (default) — the pickup workflow: advisor asks the customer how the
//     visit went; on a good answer, hits Send on that RO's queue row. Nothing
//     goes out without a human click. Skip consumes the RO so it's never asked.
//   auto — the 2h scheduler batches eligible invoiced orders itself (the
//     hands-off flow). Owner opt-in via review_req_auto.
// Both modes send one SMS per customer via Shopmonkey's own inbox
// (POST /v3/message) so replies land where the advisors already work.
//
// SAFETY: ships dark. Sends happen only when BOTH are true:
//   1. the location's review_req_enabled flag is on (owner-set, default off)
//   2. env REVIEW_REQUESTS_LIVE=1 (global kill switch)
// Enabled-but-not-live logs dry_run rows with the exact message that WOULD
// have gone out — the burn-in mode to eyeball before flipping live.
// Owner/partner everywhere; managers get the pickup queue for THEIR location
// (it's a front-counter workflow). Config stays owner-only.

const SM = 'https://api.shopmonkey.cloud/v3';
const LOOKBACK_DAYS = 3;        // auto mode: ask window after invoicing
const QUEUE_LOOKBACK_DAYS = 7;  // manual queue: pickup can lag invoicing
const RUN_CAP = 15;             // auto mode: max asks per run — never a blast
const QUEUE_CAP = 25;
const COOLDOWN_DAYS = 90;       // one ask per customer per quarter, max
const LIVE = /^(1|true|yes)$/i.test(process.env.REVIEW_REQUESTS_LIVE || '');

const apiKey = () => (process.env.SHOPMONKEY_API_KEY || '').trim();

async function smFetch(method, path, body) {
  const res = await fetch(SM + path, {
    method,
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Shopmonkey ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch (e) { return {}; }
}

// Customer record with phone numbers. GET /customer/{id} embeds phoneNumbers on
// some accounts; when absent, the phone_number sub-resource fills them in.
async function fetchCustomer(id) {
  const b = await smFetch('GET', `/customer/${id}`);
  const c = (b && b.data && !Array.isArray(b.data)) ? b.data : b;
  if (c && !Array.isArray(c.phoneNumbers)) {
    try {
      const pb = await smFetch('GET', `/customer/${id}/phone_number?limit=10`);
      c.phoneNumbers = Array.isArray(pb.data) ? pb.data : (pb.data && pb.data.data) || [];
    } catch (e) { c.phoneNumbers = []; }
  }
  return c;
}

async function fetchOrder(id) {
  const b = await smFetch('GET', `/order/${id}`);
  return (b && b.data && !Array.isArray(b.data)) ? b.data : b;
}

const customerName = (c) => (c && (c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' '))) || '';

const sendSms = ({ customerId, phoneNumberId, text }) =>
  smFetch('POST', '/message', {
    customerId, text, sendSms: true, sendEmail: false,
    ...(phoneNumberId ? { phoneNumberId } : {}),
  });

module.exports = (pool) => {
  const router = express.Router();

  let _init = false;
  const ensure = async () => {
    if (_init) return;
    await pool.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS review_req_enabled BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS review_req_auto BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS review_req_link TEXT');
    await pool.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS review_req_template TEXT');
    await pool.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS timezone VARCHAR(64)');
    // One row per considered order — the UNIQUE is the "never text twice for the
    // same RO" guarantee. Full phone number is deliberately NOT stored.
    await pool.query(`CREATE TABLE IF NOT EXISTS review_request_log (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      order_id VARCHAR(64) NOT NULL,
      order_number VARCHAR(32),
      customer_id VARCHAR(64),
      customer_name VARCHAR(255),
      phone_last4 VARCHAR(8),
      status VARCHAR(16) NOT NULL,
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (location_id, order_id))`);
    _init = true;
  };

  const fail = (res, e) => res.status(e.status || 500).json({ error: String(e.message || e) });

  // Upsert: the manual flow may legitimately re-decide an order (skip -> send,
  // dry_run burn-in -> live send). The send route refuses to touch a row whose
  // status is already 'sent', so a real text can never be overwritten or doubled.
  const logRow = (locId, o, cust, status, detail, phoneLast4) =>
    pool.query(`INSERT INTO review_request_log
        (location_id, order_id, order_number, customer_id, customer_name, phone_last4, status, detail)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (location_id, order_id) DO UPDATE SET
        status = EXCLUDED.status,
        detail = EXCLUDED.detail,
        customer_name = COALESCE(EXCLUDED.customer_name, review_request_log.customer_name),
        phone_last4 = COALESCE(EXCLUDED.phone_last4, review_request_log.phone_last4),
        created_at = NOW()`,
      [locId, o.id, o.number != null ? String(o.number) : null, o.customerId || null,
        (customerName(cust) || o.generatedCustomerName || '').slice(0, 255) || null,
        phoneLast4 || null, status, (detail || '').slice(0, 1000) || null]);

  // One order end-to-end: opt-out check -> phone -> render -> send (or dry-run
  // log). Shared by the auto batch and the pickup Send button.
  const askOrder = async (locId, loc, o, link) => {
    const cust = await fetchCustomer(o.customerId);
    if (customerOptedOut(cust)) {
      await logRow(locId, o, cust, 'skipped', 'customer opted out');
      return { status: 'skipped', reason: 'customer opted out' };
    }
    const phone = pickPhone(cust);
    if (!phone) {
      await logRow(locId, o, cust, 'skipped', 'no textable phone number');
      return { status: 'skipped', reason: 'no textable phone number' };
    }
    const last4 = String(phone.number).replace(/\D/g, '').slice(-4);
    const text = renderTemplate(loc.review_req_template, { name: customerName(cust), shop: loc.name, link });
    if (!LIVE) {
      await logRow(locId, o, cust, 'dry_run', text, last4);
      return { status: 'dry_run', customer: customerName(cust), text };
    }
    await sendSms({ customerId: o.customerId, phoneNumberId: phone.id, text });
    await logRow(locId, o, cust, 'sent', text, last4);
    return { status: 'sent', customer: customerName(cust), text };
  };

  const loadLocation = async (id) => {
    const { rows } = await pool.query(
      `SELECT name, shopmonkey_location_id, review_req_enabled, review_req_auto,
              review_req_link, review_req_template, timezone, google_place_id
       FROM locations WHERE id=$1`, [id]);
    return rows[0] || null;
  };

  // Managers run the pickup queue for THEIR location; owner/partner everywhere.
  const gate = [authenticateToken, requireRole('owner', 'partner', 'manager')];
  const assertLoc = (req, res) => {
    if (canAccessLocation(req.user, req.params.locationId)) return true;
    res.status(403).json({ error: 'Access denied for this location' });
    return false;
  };

  router.get('/status', ...gate, (req, res) =>
    res.json({ configured: !!apiKey(), live: LIVE }));

  // Config + 30-day stats + recent activity for the Marketing card.
  router.get('/:locationId', ...gate, async (req, res) => {
    if (!assertLoc(req, res)) return;
    try {
      await ensure();
      const id = req.params.locationId;
      const loc = await loadLocation(id);
      if (!loc) return res.status(404).json({ error: 'Location not found' });
      const { link, source } = deriveReviewLink(loc);
      const { rows: stats } = await pool.query(
        `SELECT status, COUNT(*)::int AS n, MAX(created_at) AS last_at
         FROM review_request_log
         WHERE location_id=$1 AND created_at > NOW() - INTERVAL '30 days'
         GROUP BY status`, [id]);
      const { rows: recent } = await pool.query(
        `SELECT order_number, customer_name, status, detail, created_at
         FROM review_request_log WHERE location_id=$1
         ORDER BY created_at DESC LIMIT 10`, [id]);
      const byStatus = Object.fromEntries(stats.map((s) => [s.status, s.n]));
      const lastAt = stats.reduce((m, s) => (!m || s.last_at > m ? s.last_at : m), null);
      res.json({
        enabled: !!loc.review_req_enabled, auto: !!loc.review_req_auto,
        live: LIVE, configured: !!apiKey(),
        link, link_source: source, custom_link: loc.review_req_link || '',
        template: loc.review_req_template || DEFAULT_TEMPLATE,
        is_default_template: !loc.review_req_template,
        timezone: loc.timezone || DEFAULT_TZ,
        stats: { sent30: byStatus.sent || 0, dry30: byStatus.dry_run || 0, failed30: byStatus.failed || 0, last_at: lastAt },
        recent,
      });
    } catch (e) { fail(res, e); }
  });

  // The pickup queue: recent invoiced ROs not yet decided (sent/skipped/asked).
  // Names come from the order itself — no per-customer fetches until Send.
  router.get('/:locationId/queue', ...gate, async (req, res) => {
    if (!assertLoc(req, res)) return;
    try {
      await ensure();
      const id = req.params.locationId;
      const loc = await loadLocation(id);
      if (!loc) return res.status(404).json({ error: 'Location not found' });
      if (!loc.review_req_enabled || !apiKey() || !loc.shopmonkey_location_id)
        return res.json({ queue: [] });
      const orders = await fetchRecentInvoicedOrders(apiKey(), loc.shopmonkey_location_id, 100);
      const { rows: logged } = await pool.query(
        'SELECT order_id FROM review_request_log WHERE location_id=$1', [id]);
      const { rows: recentCust } = await pool.query(
        `SELECT DISTINCT customer_id FROM review_request_log
         WHERE location_id=$1 AND status IN ('sent','dry_run')
           AND created_at > NOW() - INTERVAL '${COOLDOWN_DAYS} days'`, [id]);
      const picked = selectEligible(orders, {
        alreadyLogged: new Set(logged.map((r) => r.order_id)),
        recentCustomerIds: new Set(recentCust.map((r) => r.customer_id).filter(Boolean)),
        lookbackDays: QUEUE_LOOKBACK_DAYS, cap: QUEUE_CAP,
      });
      res.json({
        queue: picked.map((o) => ({
          order_id: o.id,
          number: o.number != null ? String(o.number) : null,
          customer_name: o.generatedCustomerName || null,
          invoiced_at: o.invoicedDate,
        })).reverse(), // newest first — the car being picked up right now
      });
    } catch (e) { fail(res, e); }
  });

  // Pickup "Send now" — the customer just said the visit went well. No time
  // window (they're standing at the counter); dry-run/live gating still applies.
  // ?force=1 overrides the 90-day cooldown when the human decides it's fine.
  router.post('/:locationId/orders/:orderId/send', ...gate, async (req, res) => {
    if (!assertLoc(req, res)) return;
    try {
      await ensure();
      const id = req.params.locationId, orderId = req.params.orderId;
      const force = req.query.force === '1' || (req.body && req.body.force === true);
      const loc = await loadLocation(id);
      if (!loc) return res.status(404).json({ error: 'Location not found' });
      if (!loc.review_req_enabled) return res.status(400).json({ error: 'Review requests are disabled for this location' });
      if (!apiKey()) return res.status(503).json({ error: 'SHOPMONKEY_API_KEY not set' });
      const { link } = deriveReviewLink(loc);
      if (!link) return res.status(400).json({ error: 'No review link configured' });

      const { rows: prior } = await pool.query(
        'SELECT status FROM review_request_log WHERE location_id=$1 AND order_id=$2', [id, orderId]);
      if (prior.length && prior[0].status === 'sent')
        return res.status(409).json({ error: 'A review request was already sent for this RO' });

      const o = await fetchOrder(orderId);
      if (!o || !o.id) return res.status(404).json({ error: 'Order not found in Shopmonkey' });
      if (o.locationId && loc.shopmonkey_location_id && o.locationId !== loc.shopmonkey_location_id)
        return res.status(400).json({ error: 'Order belongs to a different location' });
      if (!o.customerId) return res.status(400).json({ error: 'Order has no customer' });

      if (!force) {
        const { rows: cool } = await pool.query(
          `SELECT 1 FROM review_request_log
           WHERE location_id=$1 AND customer_id=$2 AND status IN ('sent','dry_run')
             AND order_id <> $3 AND created_at > NOW() - INTERVAL '${COOLDOWN_DAYS} days' LIMIT 1`,
          [id, o.customerId, orderId]);
        if (cool.length)
          return res.status(409).json({ error: 'This customer was already asked in the last 90 days', cooldown: true });
      }

      const out = await askOrder(id, loc, o, link);
      res.json({ ok: true, live: LIVE, ...out });
    } catch (e) { fail(res, e); }
  });

  // Pickup "Skip" — visit didn't go well (or any reason): consume the RO so
  // neither the queue nor auto mode ever asks. Reversible only by Send (which
  // upserts over a skipped row).
  router.post('/:locationId/orders/:orderId/skip', ...gate, async (req, res) => {
    if (!assertLoc(req, res)) return;
    try {
      await ensure();
      const id = req.params.locationId, orderId = req.params.orderId;
      const { rows: prior } = await pool.query(
        'SELECT status FROM review_request_log WHERE location_id=$1 AND order_id=$2', [id, orderId]);
      if (prior.length && prior[0].status === 'sent')
        return res.status(409).json({ error: 'Already sent for this RO — nothing to skip' });
      const b = req.body || {};
      const o = { id: orderId, number: b.number, customerId: b.customer_id || null, generatedCustomerName: b.customer_name };
      await logRow(id, o, null, 'skipped', 'skipped at pickup');
      res.json({ ok: true, status: 'skipped' });
    } catch (e) { fail(res, e); }
  });

  // Owner-only config. Template must keep {link} (a review ask without the link
  // is a wasted text) — everything else is free-form.
  router.put('/:locationId/config', authenticateToken, requireOwner, async (req, res) => {
    try {
      await ensure();
      const id = req.params.locationId;
      const { enabled, auto, link, template, timezone } = req.body || {};
      if (link != null && String(link).trim() && !/^https:\/\//i.test(String(link).trim()))
        return res.status(400).json({ error: 'Review link must be an https:// URL' });
      if (template != null && String(template).trim() && !String(template).includes('{link}'))
        return res.status(400).json({ error: 'Template must include {link}' });
      if (timezone != null && String(timezone).trim()) {
        try { new Intl.DateTimeFormat('en-CA', { timeZone: String(timezone).trim() }); }
        catch (e) { return res.status(400).json({ error: 'Unknown timezone' }); }
      }
      const { rows } = await pool.query(
        `UPDATE locations SET
           review_req_enabled = COALESCE($2, review_req_enabled),
           review_req_auto = COALESCE($3, review_req_auto),
           review_req_link = CASE WHEN $4::text IS NULL THEN review_req_link ELSE NULLIF(TRIM($4), '') END,
           review_req_template = CASE WHEN $5::text IS NULL THEN review_req_template ELSE NULLIF(TRIM($5), '') END,
           timezone = CASE WHEN $6::text IS NULL THEN timezone ELSE NULLIF(TRIM($6), '') END
         WHERE id=$1
         RETURNING review_req_enabled, review_req_auto, review_req_link, review_req_template, timezone`,
        [id, typeof enabled === 'boolean' ? enabled : null,
          typeof auto === 'boolean' ? auto : null,
          link != null ? String(link) : null,
          template != null ? String(template) : null,
          timezone != null ? String(timezone) : null]);
      if (!rows.length) return res.status(404).json({ error: 'Location not found' });
      res.json({ ok: true, ...rows[0] });
    } catch (e) { fail(res, e); }
  });

  // The AUTO-mode batch worker. Machine (X-Sync-Key, via the 2h scheduler) or
  // owner/partner JWT. Manual-mode locations no-op here — pickup Send is their
  // only send path. ?force=1 bypasses the local-daytime window for testing —
  // dry-run/live gating still applies; force never turns a dry run into a send.
  router.post('/:locationId/run', syncAuth, requireRole('owner', 'partner'), async (req, res) => {
    try {
      await ensure();
      const id = req.params.locationId;
      const force = req.query.force === '1' || (req.body && req.body.force === true);
      const loc = await loadLocation(id);
      if (!loc) return res.status(404).json({ error: 'Location not found' });

      if (!loc.review_req_enabled) return res.json({ ran: false, reason: 'disabled' });
      if (!loc.review_req_auto) return res.json({ ran: false, reason: 'manual mode — send from the pickup queue' });
      if (!apiKey()) return res.json({ ran: false, reason: 'SHOPMONKEY_API_KEY not set' });
      if (!loc.shopmonkey_location_id) return res.json({ ran: false, reason: 'shopmonkey_location_id not set' });
      const { link } = deriveReviewLink(loc);
      if (!link) return res.json({ ran: false, reason: 'no review link (set google_place_id or a custom link)' });
      if (!force && !inSendWindow(new Date(), loc.timezone || DEFAULT_TZ))
        return res.json({ ran: false, reason: 'outside send window' });

      const orders = await fetchRecentInvoicedOrders(apiKey(), loc.shopmonkey_location_id, 100);

      const { rows: logged } = await pool.query(
        'SELECT order_id FROM review_request_log WHERE location_id=$1', [id]);
      const alreadyLogged = new Set(logged.map((r) => r.order_id));
      const { rows: recentCust } = await pool.query(
        `SELECT DISTINCT customer_id FROM review_request_log
         WHERE location_id=$1 AND status IN ('sent','dry_run')
           AND created_at > NOW() - INTERVAL '${COOLDOWN_DAYS} days'`, [id]);
      const recentCustomerIds = new Set(recentCust.map((r) => r.customer_id).filter(Boolean));

      const picked = selectEligible(orders, { alreadyLogged, recentCustomerIds, lookbackDays: LOOKBACK_DAYS, cap: RUN_CAP });

      const out = { ran: true, live: LIVE, considered: orders.length, picked: picked.length, sent: 0, dry_run: 0, skipped: 0, failed: 0 };
      for (const o of picked) {
        try {
          const r = await askOrder(id, loc, o, link);
          out[r.status] = (out[r.status] || 0) + 1;
        } catch (e) {
          await logRow(id, o, null, 'failed', String(e.message || e));
          out.failed++;
        }
      }
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  return router;
};
