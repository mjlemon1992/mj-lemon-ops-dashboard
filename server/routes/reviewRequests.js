const express = require('express');
const { syncAuth, authenticateToken, requireOwner, requireOwnerOrPartner } = require('../middleware/auth');
const { fetchRecentInvoicedOrders } = require('../lib/shopmonkey');
const {
  DEFAULT_TEMPLATE, DEFAULT_TZ, selectEligible, inSendWindow, deriveReviewLink,
  renderTemplate, customerOptedOut, pickPhone,
} = require('../lib/reviewRequests');

// Marketing: post-service Google review request texts — the one Shopmonkey CRM
// feature we actually used, rebuilt in-house (2026-07: skipped the $175/mo CRM
// add-on for Kelowna). Flow: 2h scheduler (or owner "Run now") hits /run →
// recent invoiced orders → lib/reviewRequests eligibility → one SMS per
// customer via Shopmonkey's own inbox (POST /v3/message) so replies land where
// the advisors already work.
//
// SAFETY: ships dark. Sends happen only when BOTH are true:
//   1. the location's review_req_enabled flag is on (owner-set, default off)
//   2. env REVIEW_REQUESTS_LIVE=1 (global kill switch)
// Enabled-but-not-live logs dry_run rows with the exact message that WOULD
// have gone out — the burn-in mode to eyeball before flipping live.
// Owner/partner only; managers don't see this surface.

const SM = 'https://api.shopmonkey.cloud/v3';
const LOOKBACK_DAYS = 3;      // ask window after invoicing
const RUN_CAP = 15;           // max asks per run — never a blast
const COOLDOWN_DAYS = 90;     // one ask per customer per quarter, max
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

  const logRow = (locId, o, cust, status, detail, phoneLast4) =>
    pool.query(`INSERT INTO review_request_log
        (location_id, order_id, order_number, customer_id, customer_name, phone_last4, status, detail)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (location_id, order_id) DO NOTHING`,
      [locId, o.id, o.number != null ? String(o.number) : null, o.customerId || null,
        (customerName(cust) || o.generatedCustomerName || '').slice(0, 255) || null,
        phoneLast4 || null, status, (detail || '').slice(0, 1000) || null]);

  router.get('/status', authenticateToken, requireOwnerOrPartner, (req, res) =>
    res.json({ configured: !!apiKey(), live: LIVE }));

  // Config + 30-day stats + recent activity for the Marketing card.
  router.get('/:locationId', authenticateToken, requireOwnerOrPartner, async (req, res) => {
    try {
      await ensure();
      const id = req.params.locationId;
      const { rows } = await pool.query(
        `SELECT name, review_req_enabled, review_req_link, review_req_template, timezone, google_place_id
         FROM locations WHERE id=$1`, [id]);
      if (!rows.length) return res.status(404).json({ error: 'Location not found' });
      const loc = rows[0];
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
        enabled: !!loc.review_req_enabled, live: LIVE, configured: !!apiKey(),
        link, link_source: source, custom_link: loc.review_req_link || '',
        template: loc.review_req_template || DEFAULT_TEMPLATE,
        is_default_template: !loc.review_req_template,
        timezone: loc.timezone || DEFAULT_TZ,
        stats: { sent30: byStatus.sent || 0, dry30: byStatus.dry_run || 0, failed30: byStatus.failed || 0, last_at: lastAt },
        recent,
      });
    } catch (e) { fail(res, e); }
  });

  // Owner-only config. Template must keep {link} (a review ask without the link
  // is a wasted text) — everything else is free-form.
  router.put('/:locationId/config', authenticateToken, requireOwner, async (req, res) => {
    try {
      await ensure();
      const id = req.params.locationId;
      const { enabled, link, template, timezone } = req.body || {};
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
           review_req_link = CASE WHEN $3::text IS NULL THEN review_req_link ELSE NULLIF(TRIM($3), '') END,
           review_req_template = CASE WHEN $4::text IS NULL THEN review_req_template ELSE NULLIF(TRIM($4), '') END,
           timezone = CASE WHEN $5::text IS NULL THEN timezone ELSE NULLIF(TRIM($5), '') END
         WHERE id=$1
         RETURNING review_req_enabled, review_req_link, review_req_template, timezone`,
        [id, typeof enabled === 'boolean' ? enabled : null,
          link != null ? String(link) : null,
          template != null ? String(template) : null,
          timezone != null ? String(timezone) : null]);
      if (!rows.length) return res.status(404).json({ error: 'Location not found' });
      res.json({ ok: true, ...rows[0] });
    } catch (e) { fail(res, e); }
  });

  // The worker. Machine (X-Sync-Key, via the 2h scheduler) or owner/partner JWT
  // ("Run now"). ?force=1 bypasses the local-daytime window for testing —
  // dry-run/live gating still applies; force never turns a dry run into a send.
  router.post('/:locationId/run', syncAuth, requireOwnerOrPartner, async (req, res) => {
    try {
      await ensure();
      const id = req.params.locationId;
      const force = req.query.force === '1' || (req.body && req.body.force === true);
      const { rows } = await pool.query(
        `SELECT name, shopmonkey_location_id, review_req_enabled, review_req_link,
                review_req_template, timezone, google_place_id
         FROM locations WHERE id=$1`, [id]);
      if (!rows.length) return res.status(404).json({ error: 'Location not found' });
      const loc = rows[0];

      if (!loc.review_req_enabled) return res.json({ ran: false, reason: 'disabled' });
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
          const cust = await fetchCustomer(o.customerId);
          if (customerOptedOut(cust)) {
            await logRow(id, o, cust, 'skipped', 'customer opted out'); out.skipped++; continue;
          }
          const phone = pickPhone(cust);
          if (!phone) {
            await logRow(id, o, cust, 'skipped', 'no textable phone number'); out.skipped++; continue;
          }
          const last4 = String(phone.number).replace(/\D/g, '').slice(-4);
          const text = renderTemplate(loc.review_req_template, { name: customerName(cust), shop: loc.name, link });
          if (!LIVE) {
            await logRow(id, o, cust, 'dry_run', text, last4); out.dry_run++; continue;
          }
          await sendSms({ customerId: o.customerId, phoneNumberId: phone.id, text });
          await logRow(id, o, cust, 'sent', text, last4); out.sent++;
        } catch (e) {
          await logRow(id, o, null, 'failed', String(e.message || e)); out.failed++;
        }
      }
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  return router;
};
