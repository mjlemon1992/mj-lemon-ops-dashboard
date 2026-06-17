const express = require('express');
const { authenticateToken } = require('../middleware/auth');

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const ACCOUNTING_SCOPE = 'com.intuit.quickbooks.accounting';
const MINOR_VERSION = '75';

function apiBase() {
  return (process.env.QBO_ENV || 'sandbox') === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

function basicAuth() {
  const id = process.env.QBO_CLIENT_ID, secret = process.env.QBO_CLIENT_SECRET;
  if (!id || !secret) throw new Error('QBO_CLIENT_ID / QBO_CLIENT_SECRET not set');
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

module.exports = (pool) => {
  const router = express.Router();

  const ensureTables = async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS qbo_tokens (
        realm_id VARCHAR(255) PRIMARY KEY,
        access_token TEXT NOT NULL,
        access_expires_at TIMESTAMPTZ NOT NULL,
        refresh_token TEXT NOT NULL,
        refresh_expires_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS qbo_pnl_cache (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
        realm_id VARCHAR(255),
        period_start DATE,
        period_end DATE,
        total_income DECIMAL(12,2),
        total_cogs DECIMAL(12,2),
        gross_profit DECIMAL(12,2),
        total_expenses DECIMAL(12,2),
        net_income DECIMAL(12,2),
        lines JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await pool.query(
      'CREATE INDEX IF NOT EXISTS idx_qbo_pnl_location_date ON qbo_pnl_cache(location_id, created_at DESC)'
    );
  };
  ensureTables().catch(e => console.error('[qbo] ensureTables failed:', e.message));

  const syncAuth = (req, res, next) => {
    const secret = process.env.SYNC_SECRET;
    const provided = req.get('X-Sync-Key');
    if (secret && provided && provided === secret) {
      req.user = { role: 'owner', via: 'sync-key' };
      return next();
    }
    return authenticateToken(req, res, next);
  };

  const loadToken = async (realmId) => {
    const { rows } = await pool.query('SELECT * FROM qbo_tokens WHERE realm_id = $1', [realmId]);
    return rows[0] || null;
  };

  const saveToken = async (realmId, tok) => {
    const now = Date.now();
    const accessExp = new Date(now + ((tok.expires_in || 3600) - 60) * 1000);
    const refreshExp = new Date(now + (tok.x_refresh_token_expires_in || 8726400) * 1000);
    await pool.query(
      `INSERT INTO qbo_tokens (realm_id, access_token, access_expires_at, refresh_token, refresh_expires_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (realm_id) DO UPDATE SET
         access_token=EXCLUDED.access_token, access_expires_at=EXCLUDED.access_expires_at,
         refresh_token=EXCLUDED.refresh_token, refresh_expires_at=EXCLUDED.refresh_expires_at,
         updated_at=NOW()`,
      [realmId, tok.access_token, accessExp, tok.refresh_token, refreshExp]
    );
  };

  const postToken = async (body) => {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: new URLSearchParams(body).toString()
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`QBO token ${res.status}: ${text}`);
    return JSON.parse(text);
  };

  const refreshTokens = async (realmId) => {
    const row = await loadToken(realmId);
    if (!row) throw new Error(`No token for realm ${realmId} — run consent first`);
    if (new Date(row.refresh_expires_at) < new Date())
      throw new Error('Refresh token expired (>100d) — re-run /api/qbo/connect');
    const tok = await postToken({ grant_type: 'refresh_token', refresh_token: row.refresh_token });
    if (!tok.refresh_token) tok.refresh_token = row.refresh_token;
    await saveToken(realmId, tok);
    return tok;
  };

  const getAccessToken = async (realmId) => {
    const row = await loadToken(realmId);
    if (!row) throw new Error(`No token for realm ${realmId}`);
    if (new Date(row.access_expires_at) > new Date()) return row.access_token;
    return (await refreshTokens(realmId)).access_token;
  };

  const qboGet = async (realmId, path) => {
    const token = await getAccessToken(realmId);
    const sep = path.includes('?') ? '&' : '?';
    const url = `${apiBase()}/v3/company/${realmId}${path}${sep}minorversion=${MINOR_VERSION}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) throw new Error(`QBO GET ${path} -> ${res.status}: ${text}`);
    return JSON.parse(text);
  };

  const flattenPnl = (report) => {
    const out = [];
    const walk = (rows) => {
      if (!rows || !rows.Row) return;
      for (const r of rows.Row) {
        if (r.ColData && r.ColData.length >= 2) {
          const label = r.ColData[0].value;
          const value = parseFloat(r.ColData[r.ColData.length - 1].value || '0');
          if (label) out.push({ label, value, type: r.type || 'Data' });
        }
        if (r.Rows) walk(r.Rows);
        if (r.Summary && r.Summary.ColData) {
          const label = r.Summary.ColData[0].value;
          const value = parseFloat(r.Summary.ColData[r.Summary.ColData.length - 1].value || '0');
          if (label) out.push({ label, value, type: 'Summary' });
        }
      }
    };
    walk(report.Rows);
    return out;
  };

  const pick = (lines, ...needles) => {
    const hit = lines.find(l => needles.some(n => (l.label || '').toLowerCase() === n.toLowerCase()));
    return hit ? hit.value : null;
  };

  const resolveRealm = async (locationId, override) => {
    if (override) return override;
    const { rows } = await pool.query('SELECT qbo_company_id FROM locations WHERE id = $1', [locationId]);
    if (!rows.length) throw new Error('Location not found');
    if (!rows[0].qbo_company_id) throw new Error('locations.qbo_company_id not set for this location');
    return rows[0].qbo_company_id;
  };

  router.get('/connect', (req, res) => {
    if (process.env.SYNC_SECRET && req.query.key && req.query.key !== process.env.SYNC_SECRET)
      return res.status(403).send('forbidden — bad key');
    const params = new URLSearchParams({
      client_id: process.env.QBO_CLIENT_ID,
      redirect_uri: process.env.QBO_REDIRECT_URI,
      response_type: 'code',
      scope: ACCOUNTING_SCOPE,
      state: 'mjlemon'
    });
    res.redirect(`${AUTH_URL}?${params}`);
  });

  router.get('/callback', async (req, res) => {
    try {
      const { code, realmId } = req.query;
      if (!code || !realmId) return res.status(400).send('Missing code/realmId');
      const tok = await postToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.QBO_REDIRECT_URI
      });
      await saveToken(realmId, tok);
      res.send('QBO connected. Realm ID = ' + realmId + '\nSet this as locations.qbo_company_id for the location you are connecting.');
    } catch (e) {
      res.status(500).send(String(e.message || e));
    }
  });

  router.post('/:locationId/refresh-pnl', syncAuth, async (req, res) => {
    try {
      const realmId = await resolveRealm(req.params.locationId, req.query.realmId);
      const end = req.query.end || new Date().toISOString().slice(0, 10);
      const start = req.query.start || `${end.slice(0, 4)}-01-01`;
      const report = await qboGet(realmId, `/reports/ProfitAndLoss?start_date=${start}&end_date=${end}`);
      const lines = flattenPnl(report);
      const _income = pick(lines, 'Total Income', 'Income');
      const _cogs = pick(lines, 'Total Cost of Goods Sold', 'Total COGS');
      const _grossDirect = pick(lines, 'Gross Profit');
      const headline = {
        total_income: _income,
        total_cogs: _cogs,
        // Canadian QBO has no explicit Gross Profit row; derive income - COGS.
        gross_profit: _grossDirect != null ? _grossDirect
          : (_income != null && _cogs != null ? Math.round((_income - _cogs) * 100) / 100 : null),
        total_expenses: pick(lines, 'Total Expenses', 'Expenses'),
        // Canadian QBO labels net income "PROFIT".
        net_income: pick(lines, 'Net Income', 'Net Operating Income', 'PROFIT')
      };
      await pool.query(
        `INSERT INTO qbo_pnl_cache
           (location_id, realm_id, period_start, period_end, total_income, total_cogs, gross_profit, total_expenses, net_income, lines)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [req.params.locationId, realmId, start, end,
         headline.total_income, headline.total_cogs, headline.gross_profit,
         headline.total_expenses, headline.net_income, JSON.stringify(lines)]
      );
      res.json({ ok: true, realmId, start, end, headline, lineCount: lines.length });
    } catch (e) {
      res.status(502).json({ ok: false, error: String(e.message || e) });
    }
  });

  router.get('/:locationId/pnl-probe', syncAuth, async (req, res) => {
    try {
      const realmId = await resolveRealm(req.params.locationId, req.query.realmId);
      const end = req.query.end || new Date().toISOString().slice(0, 10);
      const start = req.query.start || `${end.slice(0, 4)}-01-01`;
      const report = await qboGet(realmId, `/reports/ProfitAndLoss?start_date=${start}&end_date=${end}`);
      res.json({ realmId, start, end, lines: flattenPnl(report) });
    } catch (e) {
      res.status(502).json({ ok: false, error: String(e.message || e) });
    }
  });

  router.get('/:locationId/pnl', authenticateToken, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM qbo_pnl_cache WHERE location_id = $1 ORDER BY created_at DESC LIMIT 1',
        [req.params.locationId]
      );
      res.json(rows[0] || null);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  return router;
};
