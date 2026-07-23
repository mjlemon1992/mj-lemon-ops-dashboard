const express = require('express');
const { authenticateToken, requireRole, canAccessLocation } = require('../middleware/auth');
const { ensureTables, ingestCallsPdf, periodSummary, QUALIFIED_MIN_SECONDS, MODEL } = require('../lib/callsIngest');

// Call-tracking read + manual upload (marketing module, piece 1).
// The extraction/store engine lives in lib/callsIngest.js and is shared with the
// parts-inbox email poller — forward the monthly Marchex report email to the
// parts inbox and it auto-ingests here without touching this endpoint.
// Read-path is owner/partner only.
//
// "Ships dark": with ANTHROPIC_API_KEY unset, /status reports configured:false and
// ingestion 503s. SLACK_MARKETING_WEBHOOK_URL is optional.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_WEBHOOK = process.env.SLACK_MARKETING_WEBHOOK_URL || null;

module.exports = (pool) => {
  const router = express.Router();

  const fail = (res, e) => res.status(e.status || 500).json({ error: String(e.message || e) });

  // Shop operators (managers) may use this for THEIR location; asserted below.
  const gate = [authenticateToken, requireRole('owner', 'partner')];
  const assertLoc = (req, res) => {
    if (canAccessLocation(req.user, req.params.locationId)) return true;
    res.status(403).json({ error: 'Access denied for this location' });
    return false;
  };

  router.get('/status', ...gate, (req, res) => {
    res.json({ configured: !!ANTHROPIC_KEY, slack: !!SLACK_WEBHOOK, model: MODEL, qualifiedMinSeconds: QUALIFIED_MIN_SECONDS });
  });

  router.get('/:locationId/periods', ...gate, async (req, res) => {
    if (!assertLoc(req, res)) return;
    try {
      await ensureTables(pool);
      const { rows } = await pool.query(
        `SELECT period_start, MAX(period_end) AS period_end, MAX(ingested_at) AS ingested_at,
                SUM(total_calls)::int AS total_calls
           FROM call_summary WHERE location_id=$1 GROUP BY period_start ORDER BY period_start DESC`,
        [req.params.locationId]
      );
      res.json(rows);
    } catch (e) { fail(res, e); }
  });

  router.get('/:locationId/summary', ...gate, async (req, res) => {
    if (!assertLoc(req, res)) return;
    try {
      await ensureTables(pool);
      const id = req.params.locationId;
      let period = req.query.period;
      if (!period) {
        const { rows } = await pool.query('SELECT MAX(period_start) AS p FROM call_summary WHERE location_id=$1', [id]);
        period = rows[0].p;
      }
      if (!period) return res.json(null);
      const cur = await periodSummary(pool, id, period);
      const { rows: pr } = await pool.query(
        'SELECT MAX(period_start) AS p FROM call_summary WHERE location_id=$1 AND period_start < $2', [id, period]
      );
      cur.prev = pr[0].p ? await periodSummary(pool, id, pr[0].p) : null;
      res.json(cur);
    } catch (e) { fail(res, e); }
  });

  // Ingest a PDF. Body is the raw PDF (Content-Type: application/pdf).
  router.post('/:locationId/ingest',
    ...gate,
    express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: '25mb' }),
    async (req, res) => {
      try {
        if (!assertLoc(req, res)) return;
        if (!Buffer.isBuffer(req.body) || !req.body.length)
          return res.status(400).json({ error: 'No PDF body. POST the file with Content-Type: application/pdf.' });
        const out = await ingestCallsPdf(pool, req.params.locationId, req.body.toString('base64'), 'marchex');
        res.json(out);
      } catch (e) { fail(res, e); }
    }
  );

  return router;
};
