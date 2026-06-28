const express = require('express');
const { authenticateToken, requireOwnerOrPartner } = require('../middleware/auth');

// Read-only proxy to the standalone Parkland QBO connector.
// The dashboard never embeds QBO logic — it consumes the connector over REST,
// server-to-server, with a token kept in dashboard env (never exposed to the browser).
// Connector: https://parkland-qbo-production.up.railway.app  (see qbo-connector/)
const BASE = process.env.QBO_CONNECTOR_URL;   // e.g. https://parkland-qbo-production.up.railway.app
const TOKEN = process.env.QBO_API_TOKEN;      // minted in qbo-connector: npm run issue-key ops-dashboard <slugs>
const DEFAULT_SLUG = process.env.QBO_DEFAULT_SLUG || null; // single-location fallback (e.g. "red-deer") — avoids a DB write
// Which location the DEFAULT_SLUG belongs to. With 2+ locations this MUST be set
// (or each location given its own qbo_slug), otherwise DEFAULT_SLUG would apply
// to every location and an unmapped shop would inherit another shop's books.
const DEFAULT_SLUG_LOC_ID = process.env.QBO_DEFAULT_SLUG_LOCATION_ID || null;

module.exports = (pool) => {
  const router = express.Router();

  // locations.qbo_slug maps a dashboard location to the connector's friendly slug
  // (e.g. "red-deer"). Added idempotently so existing rows aren't disturbed.
  let _colInit = false;
  const ensureColumns = async () => {
    if (_colInit) return;
    await pool.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS qbo_slug TEXT');
    _colInit = true;
  };

  const slugify = (s) => (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  // Resolve a dashboard location UUID to a connector slug.
  // 1) Explicit per-location qbo_slug always wins (the correct multi-location path).
  // 2) DEFAULT_SLUG applies ONLY to its designated location (QBO_DEFAULT_SLUG_LOCATION_ID),
  //    or — when that env is unset — to a true single-active-location deployment.
  // 3) Otherwise the location is "not connected" (503). We deliberately do NOT
  //    blanket-apply DEFAULT_SLUG or fall back to a slugified name, because either
  //    would make an unmapped shop inherit another shop's books (cross-location bleed).
  const slugFor = async (locationId) => {
    await ensureColumns();
    const { rows } = await pool.query('SELECT name, qbo_slug FROM locations WHERE id = $1', [locationId]);
    if (!rows.length) throw new Error('Location not found');
    if (rows[0].qbo_slug) return rows[0].qbo_slug;
    if (DEFAULT_SLUG) {
      if (DEFAULT_SLUG_LOC_ID) {
        if (DEFAULT_SLUG_LOC_ID === locationId) return DEFAULT_SLUG;
      } else {
        const { rows: c } = await pool.query('SELECT COUNT(*)::int AS n FROM locations WHERE active = true');
        if ((c[0] && c[0].n) <= 1) return DEFAULT_SLUG;
      }
    }
    const e = new Error('QuickBooks not connected for this location (set its qbo_slug, or QBO_DEFAULT_SLUG_LOCATION_ID for the default shop)');
    e.status = 503;
    throw e;
  };

  const connectorGet = async (path) => {
    if (!BASE || !TOKEN) {
      const e = new Error('QBO connector not configured (set QBO_CONNECTOR_URL and QBO_API_TOKEN)');
      e.status = 503;
      throw e;
    }
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const text = await res.text();
    if (!res.ok) {
      const e = new Error(`connector ${res.status}: ${text}`);
      e.status = res.status === 404 ? 404 : 502;
      throw e;
    }
    return text ? JSON.parse(text) : null;
  };

  const fail = (res, e) => res.status(e.status || 500).json({ error: String(e.message || e) });

  // Default date window: YTD (Jan 1 -> today).
  const window = (q) => {
    const end = q.end || new Date().toISOString().slice(0, 10);
    const start = q.start || `${end.slice(0, 4)}-01-01`;
    return { start, end };
  };

  const gate = [authenticateToken, requireOwnerOrPartner];

  // Whether the connector is wired up (drives the UI's "not configured" state).
  router.get('/status', ...gate, (req, res) => {
    res.json({ configured: !!(BASE && TOKEN), connectorUrl: BASE || null });
  });

  // P&L — primary surface. Returns { headline, summaries, start, end }.
  router.get('/:locationId/pnl', ...gate, async (req, res) => {
    try {
      const slug = await slugFor(req.params.locationId);
      const { start, end } = window(req.query);
      const data = await connectorGet(`/qbo/${slug}/pnl?start=${start}&end=${end}`);
      res.json({ ...data, start, end });
    } catch (e) { fail(res, e); }
  });

  router.get('/:locationId/balance-sheet', ...gate, async (req, res) => {
    try {
      const slug = await slugFor(req.params.locationId);
      const { start, end } = window(req.query);
      res.json(await connectorGet(`/qbo/${slug}/balance-sheet?start=${start}&end=${end}`));
    } catch (e) { fail(res, e); }
  });

  router.get('/:locationId/cash-flow', ...gate, async (req, res) => {
    try {
      const slug = await slugFor(req.params.locationId);
      const { start, end } = window(req.query);
      res.json(await connectorGet(`/qbo/${slug}/cash-flow?start=${start}&end=${end}`));
    } catch (e) { fail(res, e); }
  });

  router.get('/:locationId/aged-receivables', ...gate, async (req, res) => {
    try {
      const slug = await slugFor(req.params.locationId);
      const date = req.query.date || new Date().toISOString().slice(0, 10);
      res.json(await connectorGet(`/qbo/${slug}/aged-receivables?date=${date}`));
    } catch (e) { fail(res, e); }
  });

  router.get('/:locationId/aged-payables', ...gate, async (req, res) => {
    try {
      const slug = await slugFor(req.params.locationId);
      const date = req.query.date || new Date().toISOString().slice(0, 10);
      res.json(await connectorGet(`/qbo/${slug}/aged-payables?date=${date}`));
    } catch (e) { fail(res, e); }
  });

  return router;
};
