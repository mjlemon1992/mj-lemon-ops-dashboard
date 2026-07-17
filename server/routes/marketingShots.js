const express = require('express');
const { authenticateToken, requireRole, canAccessLocation } = require('../middleware/auth');

// Marketing: "This week's shots" — turn today's OPEN repair orders (from Shopmonkey)
// into a short AI shoot list (what to photograph/film for social). Read-only; cached
// 12h per location. Uses the dashboard's existing SHOPMONKEY_API_KEY + ANTHROPIC_API_KEY.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SHOPMONKEY_KEY = process.env.SHOPMONKEY_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const FRESH_MS = 12 * 60 * 60 * 1000;

const SHOTS_SYSTEM = `You turn a transmission shop's OPEN repair orders into a short weekly "shoot list"
for social media — what to photograph or film this week. Favor visually compelling transmission work:
teardowns, burnt/worn friction packs and valve bodies, before/after rebuilds, interesting or heavy-duty
vehicles. Each shot should tie to a real RO from the list when possible. NO calls-to-action.
Return ONLY a JSON array of 4-6 items, no prose, no fences:
[{"ro":"<RO number or empty>","vehicle":"<vehicle>","shot":"what to capture, <=80 chars","why":"<=70 chars, why it's good content"}]
If the open jobs are thin or lack detail, fill with evergreen shop shots (a rebuild on the bench, a clean
install, the team at work) with ro set to "".`;

module.exports = (pool) => {
  const router = express.Router();

  let _init = false;
  const ensure = async () => {
    if (_init) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS marketing_shots_cache (
      location_id UUID PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
      payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    _init = true;
  };

  // Open orders = cars in the shop now (uninvoiced, un-archived).
  const fetchOpenOrders = async (smLocId) => {
    const out = [], pageSize = 100;
    for (let p = 0; p < 6; p++) {
      const params = new URLSearchParams({ locationId: smLocId, where: JSON.stringify({ invoicedDate: null, archived: false }), limit: String(pageSize), skip: String(p * pageSize) });
      const r = await fetch(`https://api.shopmonkey.cloud/v3/order?${params}`, { headers: { Authorization: `Bearer ${SHOPMONKEY_KEY}`, 'Content-Type': 'application/json' } });
      if (!r.ok) throw Object.assign(new Error(`Shopmonkey ${r.status}`), { status: 502 });
      const d = await r.json();
      const batch = (d && d.data && d.data.data) ? d.data.data : (d.data || []);
      if (!batch.length) break;
      out.push(...batch);
      if (batch.length < pageSize) break;
    }
    return out.filter(o => !o.deleted);
  };

  const generate = async (orders) => {
    const jobs = orders.slice(0, 15).map(o => ({
      ro: o.number != null ? String(o.number) : '',
      vehicle: o.generatedVehicleName || 'Vehicle',
      complaint: (o.complaint && o.complaint !== 'empty') ? String(o.complaint).slice(0, 140) : '',
    }));
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, system: SHOTS_SYSTEM,
        messages: [{ role: 'user', content: `Open repair orders (JSON):\n${JSON.stringify(jobs)}` }] }),
    });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(`Anthropic ${res.status}: ${JSON.stringify(body).slice(0, 200)}`), { status: 502 });
    let raw = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('').replace(/```json|```/g, '').trim();
    const s = raw.indexOf('['), e = raw.lastIndexOf(']');
    if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(0, 6) : [];
  };

  const fail = (res, e) => res.status(e.status || 500).json({ error: String(e.message || e) });
  // Shop operators (managers) may use this for THEIR location; asserted below.
  const gate = [authenticateToken, requireRole('owner', 'partner', 'manager')];
  const assertLoc = (req, res) => {
    if (canAccessLocation(req.user, req.params.locationId)) return true;
    res.status(403).json({ error: 'Access denied for this location' });
    return false;
  };

  router.get('/status', ...gate, (req, res) => res.json({ configured: !!(ANTHROPIC_KEY && SHOPMONKEY_KEY) }));

  // Cached 12h; ?force=1 regenerates from live open orders.
  router.get('/:locationId/shots', ...gate, async (req, res) => {
    if (!assertLoc(req, res)) return;
    try {
      await ensure();
      const id = req.params.locationId, force = req.query.force === '1';
      if (!force) {
        const { rows } = await pool.query('SELECT payload, created_at FROM marketing_shots_cache WHERE location_id=$1', [id]);
        if (rows.length && (Date.now() - new Date(rows[0].created_at).getTime()) < FRESH_MS) {
          const p = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
          return res.json({ ...p, cached: true, generated_at: rows[0].created_at });
        }
      }
      if (!ANTHROPIC_KEY || !SHOPMONKEY_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY / SHOPMONKEY_API_KEY not set' });
      const { rows: lr } = await pool.query('SELECT shopmonkey_location_id FROM locations WHERE id=$1', [id]);
      if (!lr.length) return res.status(404).json({ error: 'Location not found' });
      const orders = await fetchOpenOrders(lr[0].shopmonkey_location_id || '');
      const shots = await generate(orders);
      const payload = { shots, open_orders: orders.length };
      await pool.query(`INSERT INTO marketing_shots_cache (location_id, payload, created_at) VALUES ($1,$2,NOW())
        ON CONFLICT (location_id) DO UPDATE SET payload=EXCLUDED.payload, created_at=NOW()`, [id, JSON.stringify(payload)]);
      res.json({ ...payload, cached: false, generated_at: new Date().toISOString() });
    } catch (e) { fail(res, e); }
  });

  return router;
};
