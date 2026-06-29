// LemonOps MCP connector — exposes the dashboard to Claude (Atlas) as a custom
// connector over MCP Streamable HTTP (JSON-RPC). Hand-rolled (no SDK) to stay in
// CommonJS. Auth is a secret token in the URL path: the connector URL is
//   https://<host>/mcp/<COS_MCP_TOKEN>
// so only someone holding the token can reach it (acts as a bearer secret).
// Read + write: pull shop numbers/alerts AND create a marketing post draft.
const express = require('express');

module.exports = (pool) => {
  const router = express.Router();
  // Token in the connector URL. Falls back to SYNC_SECRET so no new env var is
  // needed (SYNC_SECRET is already set on Railway for the scheduler/sync).
  const TOKEN = process.env.COS_MCP_TOKEN || process.env.SYNC_SECRET;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const MODEL = 'claude-sonnet-4-6';
  const PROTOCOL_VERSION = '2025-03-26';

  // ---- tool catalog ----
  const tools = [
    {
      name: 'list_locations',
      description: 'List the shops (locations) and their ids. Call this first to map a name like "Red Deer" to its id.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'get_metrics',
      description: "Current month-to-date numbers for one shop: revenue, parts/labour margin, average repair order, effective labour rate, profit-per-hour, plus the open alerts. Pass the shop name (e.g. 'Red Deer') or its id.",
      inputSchema: { type: 'object', properties: { location: { type: 'string', description: "Shop name like 'Red Deer' or its id" } }, required: ['location'] }
    },
    {
      name: 'create_marketing_post',
      description: 'Draft a social media post (Instagram/Facebook/Google captions) and stage it in the marketing approval queue for a shop. Jamie adds the photo and approves it in the dashboard. Ask him what it is about first if unclear.',
      inputSchema: { type: 'object', properties: { location: { type: 'string', description: "Shop name or id (optional; defaults to the first active shop)" }, topic: { type: 'string', description: 'What the post is about — the job, offer, or message' }, offer: { type: 'string', description: 'Any promo/offer to include (optional)' } }, required: ['topic'] }
    }
  ];

  // ---- helpers ----
  const resolveLocation = async (nameOrId) => {
    const r = await pool.query('SELECT id, name FROM locations WHERE active = true');
    const rows = r.rows;
    if (!nameOrId) return rows[0] || null;
    const byId = rows.find(l => l.id === nameOrId);
    if (byId) return byId;
    const n = String(nameOrId).toLowerCase();
    return rows.find(l => (l.name || '').toLowerCase().includes(n)) || null;
  };

  const text = (s) => ({ content: [{ type: 'text', text: s }] });

  const handlers = {
    async list_locations() {
      const r = await pool.query('SELECT id, name, city, province FROM locations WHERE active = true ORDER BY name');
      if (!r.rows.length) return text('No active locations found.');
      return text(r.rows.map(l => `${l.name}${l.city ? ` (${l.city}, ${l.province})` : ''} — id ${l.id}`).join('\n'));
    },
    async get_metrics({ location }) {
      const loc = await resolveLocation(location);
      if (!loc) return text(`Couldn't find a shop matching "${location}". Use list_locations to see the options.`);
      const m = await pool.query(
        `SELECT revenue_mtd, parts_margin, labour_margin, avg_ro_value, effective_labour_rate, pph, car_count_mtd, total_profit, alerts, created_at
         FROM metrics_cache WHERE location_id = $1 ORDER BY created_at DESC LIMIT 1`, [loc.id]
      );
      if (!m.rows[0]) return text(`${loc.name}: no metrics synced yet.`);
      const d = m.rows[0];
      let alerts = d.alerts;
      if (typeof alerts === 'string') { try { alerts = JSON.parse(alerts); } catch { alerts = []; } }
      const n = (v) => (v == null ? '—' : v);
      const lines = [
        `${loc.name} — month to date (pre-tax):`,
        `Revenue: $${n(Math.round(d.revenue_mtd))}`,
        `Car count: ${n(d.car_count_mtd)}`,
        `Avg repair order: $${n(Math.round(d.avg_ro_value))}`,
        `Parts margin: ${n(d.parts_margin)}%   Labour margin: ${n(d.labour_margin)}%`,
        `Effective labour rate: $${n(d.effective_labour_rate)}/hr`,
        `Profit per hour: $${n(Math.round(d.pph))}`,
        `Total profit: $${n(Math.round(d.total_profit))}`,
        `Open alerts: ${Array.isArray(alerts) ? alerts.length : 0}`
      ];
      return text(lines.join('\n'));
    },
    async create_marketing_post({ location, topic, offer }) {
      if (!topic || !topic.trim()) return text('I need to know what the post is about first.');
      const loc = await resolveLocation(location);
      let caps = { ig: '', fb: '', gbp: '' };
      if (ANTHROPIC_KEY) {
        try {
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({
              model: MODEL, max_tokens: 600,
              system: 'You write social captions for an automotive transmission repair shop. Return ONLY a JSON object {"ig":"...","fb":"...","gbp":"..."} — an Instagram, Facebook, and Google Business Profile caption. Friendly, local, trustworthy. No invented claims or fake reviews.',
              messages: [{ role: 'user', content: `Topic: ${topic}${offer ? `\nOffer: ${offer}` : ''}\nWrite the captions.` }]
            })
          });
          const body = await r.json();
          if (r.ok) {
            const t = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
            const mt = t.match(/\{[\s\S]*\}/);
            if (mt) { const j = JSON.parse(mt[0]); caps = { ig: j.ig || '', fb: j.fb || '', gbp: j.gbp || '' }; }
          }
        } catch (e) { /* fall through with empty captions */ }
      }
      await pool.query(
        `INSERT INTO marketing_post (location_id, location_name, status, note, caption_ig, caption_fb, caption_gbp)
         VALUES ($1,$2,'draft',$3,$4,$5,$6)`,
        [loc ? loc.id : null, loc ? loc.name : null, topic, caps.ig, caps.fb, caps.gbp]
      );
      return text(`Drafted a post about "${topic}"${loc ? ` for ${loc.name}` : ''} and staged it in the Marketing approval queue. Add a photo and approve it there when you're ready.${caps.ig ? `\n\nInstagram draft: ${caps.ig}` : ''}`);
    }
  };

  // ---- MCP Streamable HTTP endpoint (JSON-RPC over POST), token in the path ----
  router.post('/:token', express.json({ limit: '1mb' }), async (req, res) => {
    if (!TOKEN || req.params.token !== TOKEN) return res.status(404).json({ error: 'Not found' });
    const msg = req.body || {};
    const send = (result, error) => {
      if (msg.id === undefined || msg.id === null) return res.status(202).end(); // notification
      const body = { jsonrpc: '2.0', id: msg.id };
      if (error) body.error = error; else body.result = result;
      res.json(body);
    };
    try {
      switch (msg.method) {
        case 'initialize':
          return send({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'LemonOps Dashboard', version: '1.0.0' } });
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return res.status(202).end();
        case 'ping':
          return send({});
        case 'tools/list':
          return send({ tools });
        case 'tools/call': {
          const fn = handlers[msg.params && msg.params.name];
          if (!fn) return send({ content: [{ type: 'text', text: `Unknown tool: ${msg.params && msg.params.name}` }], isError: true });
          const out = await fn((msg.params && msg.params.arguments) || {});
          return send(out);
        }
        default:
          return send(null, { code: -32601, message: `Method not found: ${msg.method}` });
      }
    } catch (e) {
      return send(null, { code: -32603, message: e.message });
    }
  });

  // GET on the endpoint (some clients probe it) — no SSE stream; just 200.
  router.get('/:token', (req, res) => {
    if (!TOKEN || req.params.token !== TOKEN) return res.status(404).json({ error: 'Not found' });
    res.status(200).json({ ok: true, server: 'LemonOps MCP' });
  });

  return router;
};
