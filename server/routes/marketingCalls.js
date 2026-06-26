const express = require('express');
const { authenticateToken, requireOwnerOrPartner } = require('../middleware/auth');

// Call-tracking ingestion (marketing module, piece 1).
// Monthly Marchex/Telmetrics call-measurement PDF -> Claude extraction -> DB ->
// optional Slack card. The dashboard reads the tables, never the PDF, so a future
// live Marchex API only swaps the writer. Read-path is owner/partner only.
//
// "Ships dark": with ANTHROPIC_API_KEY unset, /status reports configured:false and
// ingestion 503s — the tab still renders. SLACK_MARKETING_WEBHOOK_URL is optional;
// if unset, data is stored + shown in the tab without a Slack post.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_WEBHOOK = process.env.SLACK_MARKETING_WEBHOOK_URL || null;
const MODEL = 'claude-sonnet-4-6';
const QUALIFIED_MIN_SECONDS = parseInt(process.env.QUALIFIED_MIN_SECONDS || '60', 10);

const SCHEMA = `{
  "provider": "marchex", "format": "telmetrics", "location": "Red Deer",
  "period": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
  "channels": [{ "channel": "ORGANIC|PPC|CALL_EXTENSION", "total_calls": 0, "answered_calls": 0,
    "missed_calls": 0, "unique_callers": 0, "avg_duration_seconds": 0,
    "numbers": [{ "tracking_number": "587-802-4670", "total_calls": 0, "answered_calls": 0,
      "missed_calls": 0, "unique_callers": 0, "avg_duration_seconds": 0 }] }],
  "totals": { "organic_calls": 0, "paid_calls": 0, "total_calls": 0, "qualified_calls": null },
  "calls": [{ "date": "YYYY-MM-DD", "time": "HH:MM:SS", "tracking_number": "", "channel": "",
    "caller_number": "", "caller_name": null, "caller_city": null, "caller_province": null,
    "class": "consumer|business|null", "answer_status": "answered|busy|no_answer|suspended",
    "rings": 0, "duration_seconds": 0, "qualified": false }]
}`;

const SYSTEM_PROMPT = `You extract structured data from a monthly call-measurement PDF report.

Output ONLY a single JSON object matching the schema below. No prose, no markdown fences, no
explanation. If a field is unknown, use null. Read EVERY page, including all Call Detail pages.

CHANNEL: determine each section's channel from its header label:
  "...-PPC" -> "PPC"   "...-ORGANIC" -> "ORGANIC"   "...-CALL EXTENSION" -> "CALL_EXTENSION"
A tracking number's channel is whatever report section it appears under for this period. Do not
infer channel from the number itself.

For each channel, list every tracking number with its This-Period figures (total_calls,
answered_calls, missed_calls, unique_callers, avg_duration). Channel totals are the sum of their
numbers. Use the "This Period" column, never "To Date".

DURATIONS: convert m:ss or h:mm:ss to integer seconds.

CALL DETAIL (if present): one object per row. Map the called number to its channel. Parse caller
city/province from the Caller Address column when present (else null). class: "Cons"/"Cons^" ->
"consumer", "Bus" -> "business", blank -> null. answer_status: "A" -> "answered" (rings = the
number after A, e.g. A02 -> 2), "B" -> "busy", "N" -> "no_answer", "S" -> "suspended". Set
qualified = true only if answer_status is "answered" AND duration_seconds >= ${QUALIFIED_MIN_SECONDS}.

TOTALS:
  organic_calls = sum of ORGANIC channel total_calls
  paid_calls = sum of PPC + CALL_EXTENSION total_calls
  total_calls = organic_calls + paid_calls
  qualified_calls = count of calls[] where qualified == true (null if no detail)

Schema:
${SCHEMA}`;

module.exports = (pool) => {
  const router = express.Router();

  let _init = false;
  const ensureTables = async () => {
    if (_init) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS call_summary (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
        location_name VARCHAR(255),
        provider VARCHAR(50) NOT NULL DEFAULT 'marchex',
        format VARCHAR(50) NOT NULL DEFAULT 'telmetrics',
        period_start DATE NOT NULL,
        period_end DATE,
        channel VARCHAR(30) NOT NULL,
        tracking_number VARCHAR(40) NOT NULL,
        total_calls INTEGER DEFAULT 0,
        answered_calls INTEGER DEFAULT 0,
        missed_calls INTEGER DEFAULT 0,
        unique_callers INTEGER DEFAULT 0,
        avg_duration_seconds INTEGER DEFAULT 0,
        ingested_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (location_id, provider, period_start, channel, tracking_number)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS call_detail (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
        provider VARCHAR(50) NOT NULL DEFAULT 'marchex',
        period_start DATE NOT NULL,
        call_date DATE, call_time VARCHAR(12),
        channel VARCHAR(30), tracking_number VARCHAR(40),
        caller_number VARCHAR(40), caller_city VARCHAR(120), caller_province VARCHAR(40),
        class VARCHAR(20), answer_status VARCHAR(20), rings INTEGER,
        duration_seconds INTEGER, qualified BOOLEAN DEFAULT false,
        ingested_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (location_id, provider, tracking_number, call_date, call_time, caller_number)
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_call_summary_loc_period ON call_summary(location_id, period_start DESC)');
    _init = true;
  };

  const locName = async (id) => {
    const { rows } = await pool.query('SELECT name FROM locations WHERE id = $1', [id]);
    if (!rows.length) throw Object.assign(new Error('Location not found'), { status: 404 });
    return rows[0].name;
  };

  // ── Anthropic extraction (REST, no SDK dependency) ──
  const extract = async (pdfBase64, location, provider) => {
    if (!ANTHROPIC_KEY) throw Object.assign(new Error('ANTHROPIC_API_KEY not set'), { status: 503 });
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            { type: 'text', text: `Extract this report. location="${location}", provider="${provider}".` },
          ],
        }],
      }),
    });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(`Anthropic ${res.status}: ${JSON.stringify(body).slice(0, 300)}`), { status: 502 });
    const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let data;
    try {
      data = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch (e) {
      throw Object.assign(new Error('Extraction did not return valid JSON (the report may be larger than one pass — try a summary-only PDF or split it)'), { status: 502 });
    }
    return data;
  };

  const upsertSummary = async (locationId, locationName, d) => {
    for (const ch of d.channels || []) {
      for (const n of ch.numbers || []) {
        await pool.query(
          `INSERT INTO call_summary
             (location_id, location_name, provider, format, period_start, period_end, channel,
              tracking_number, total_calls, answered_calls, missed_calls, unique_callers, avg_duration_seconds, ingested_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
           ON CONFLICT (location_id, provider, period_start, channel, tracking_number) DO UPDATE SET
             total_calls=EXCLUDED.total_calls, answered_calls=EXCLUDED.answered_calls,
             missed_calls=EXCLUDED.missed_calls, unique_callers=EXCLUDED.unique_callers,
             avg_duration_seconds=EXCLUDED.avg_duration_seconds, period_end=EXCLUDED.period_end,
             location_name=EXCLUDED.location_name, ingested_at=NOW()`,
          [locationId, locationName, d.provider || 'marchex', d.format || 'telmetrics',
           d.period.start, d.period.end || null, ch.channel, n.tracking_number,
           n.total_calls || 0, n.answered_calls || 0, n.missed_calls || 0,
           n.unique_callers || 0, Math.round(n.avg_duration_seconds || 0)]
        );
      }
    }
  };

  const upsertDetail = async (locationId, d) => {
    for (const c of d.calls || []) {
      await pool.query(
        `INSERT INTO call_detail
           (location_id, provider, period_start, call_date, call_time, channel, tracking_number,
            caller_number, caller_city, caller_province, class, answer_status, rings, duration_seconds, qualified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (location_id, provider, tracking_number, call_date, call_time, caller_number) DO NOTHING`,
        [locationId, d.provider || 'marchex', d.period.start, c.date || null, c.time || null,
         c.channel || null, c.tracking_number || null, c.caller_number || null, c.caller_city || null,
         c.caller_province || null, c.class || null, c.answer_status || null,
         c.rings == null ? null : c.rings, c.duration_seconds == null ? null : c.duration_seconds,
         !!c.qualified]
      );
    }
  };

  // Aggregate stored rows for one period into channel + totals shape.
  const periodSummary = async (locationId, periodStart) => {
    const { rows } = await pool.query(
      `SELECT channel,
              SUM(total_calls)::int AS total_calls, SUM(answered_calls)::int AS answered_calls,
              SUM(missed_calls)::int AS missed_calls, SUM(unique_callers)::int AS unique_callers
         FROM call_summary WHERE location_id=$1 AND period_start=$2 GROUP BY channel`,
      [locationId, periodStart]
    );
    const by = Object.fromEntries(rows.map(r => [r.channel, r]));
    const organic = by.ORGANIC?.total_calls || 0;
    const paid = (by.PPC?.total_calls || 0) + (by.CALL_EXTENSION?.total_calls || 0);
    const { rows: q } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM call_detail WHERE location_id=$1 AND period_start=$2 AND qualified=true',
      [locationId, periodStart]
    );
    const { rows: hasDetail } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM call_detail WHERE location_id=$1 AND period_start=$2',
      [locationId, periodStart]
    );
    return {
      period_start: periodStart,
      channels: rows,
      totals: { organic, paid, total: organic + paid, qualified: hasDetail[0].n ? q[0].n : null },
    };
  };

  const fail = (res, e) => res.status(e.status || 500).json({ error: String(e.message || e) });

  // ── Slack card (optional) ──
  const money = (n) => n.toLocaleString('en-CA');
  const postSlack = async (locationName, provider, cur, prev) => {
    if (!SLACK_WEBHOOK) return;
    const monLabel = new Date(cur.period_start + 'T00:00:00').toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
    const ppc = cur.channels.find(c => c.channel === 'PPC')?.total_calls || 0;
    const callExt = cur.channels.find(c => c.channel === 'CALL_EXTENSION')?.total_calls || 0;
    const q = cur.totals.qualified;
    const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
    let mom = '';
    if (prev) {
      const t = pct(cur.totals.total, prev.totals.total), p = pct(cur.totals.paid, prev.totals.paid), o = pct(cur.totals.organic, prev.totals.organic);
      const s = (x) => (x == null ? 'n/a' : (x >= 0 ? `+${x}%` : `${x}%`));
      mom = `\nMoM:  Total ${s(t)}   Paid ${s(p)}   Organic ${s(o)}`;
    }
    const orgPctOfTotal = cur.totals.total ? Math.round((cur.totals.organic / cur.totals.total) * 100) : 0;
    const text = `📞 *${locationName} — Call Tracking — ${monLabel}*  (${provider})\n` +
      '```' +
      `Organic         ${money(cur.totals.organic)}\n` +
      `PPC             ${money(ppc)}${q != null ? `   (qualified ≥${QUALIFIED_MIN_SECONDS}s: ${q})` : ''}\n` +
      `Call Extension  ${money(callExt)}\n` +
      `------------------------------\n` +
      `Total           ${money(cur.totals.total)}    Paid ${money(cur.totals.paid)} · Organic ${money(cur.totals.organic)} (${orgPctOfTotal}%)` +
      mom +
      '```';
    try {
      await fetch(SLACK_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    } catch (e) { console.error('[marketing] slack post failed:', e.message); }
  };

  const postSlackFailure = async (locationName, period, sum, declared) => {
    if (!SLACK_WEBHOOK) return;
    try {
      await fetch(SLACK_WEBHOOK, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `⚠️ *${locationName}* call report (${period?.start || '?'}) did NOT reconcile — channel sum ${sum} ≠ declared total ${declared}. Nothing was stored.` }),
      });
    } catch (e) { /* best effort */ }
  };

  const gate = [authenticateToken, requireOwnerOrPartner];

  router.get('/status', ...gate, (req, res) => {
    res.json({ configured: !!ANTHROPIC_KEY, slack: !!SLACK_WEBHOOK, model: MODEL, qualifiedMinSeconds: QUALIFIED_MIN_SECONDS });
  });

  // List stored periods (newest first) for a location.
  router.get('/:locationId/periods', ...gate, async (req, res) => {
    try {
      await ensureTables();
      const { rows } = await pool.query(
        `SELECT period_start, MAX(period_end) AS period_end, MAX(ingested_at) AS ingested_at,
                SUM(total_calls)::int AS total_calls
           FROM call_summary WHERE location_id=$1 GROUP BY period_start ORDER BY period_start DESC`,
        [req.params.locationId]
      );
      res.json(rows);
    } catch (e) { fail(res, e); }
  });

  // Latest (or ?period=YYYY-MM-DD) summary + MoM vs the prior stored period.
  router.get('/:locationId/summary', ...gate, async (req, res) => {
    try {
      await ensureTables();
      const id = req.params.locationId;
      let period = req.query.period;
      if (!period) {
        const { rows } = await pool.query('SELECT MAX(period_start) AS p FROM call_summary WHERE location_id=$1', [id]);
        period = rows[0].p;
      }
      if (!period) return res.json(null);
      const cur = await periodSummary(id, period);
      const { rows: pr } = await pool.query(
        'SELECT MAX(period_start) AS p FROM call_summary WHERE location_id=$1 AND period_start < $2', [id, period]
      );
      cur.prev = pr[0].p ? await periodSummary(id, pr[0].p) : null;
      res.json(cur);
    } catch (e) { fail(res, e); }
  });

  // Ingest a PDF. Body is the raw PDF (Content-Type: application/pdf).
  router.post('/:locationId/ingest',
    ...gate,
    express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: '25mb' }),
    async (req, res) => {
      try {
        await ensureTables();
        if (!Buffer.isBuffer(req.body) || !req.body.length)
          return res.status(400).json({ error: 'No PDF body. POST the file with Content-Type: application/pdf.' });
        const name = await locName(req.params.locationId);
        const data = await extract(req.body.toString('base64'), name, 'marchex');

        const sum = (data.channels || []).reduce((a, c) => a + (c.total_calls || 0), 0);
        if (data.totals && sum !== data.totals.total_calls) {
          await postSlackFailure(name, data.period, sum, data.totals.total_calls);
          return res.status(422).json({ error: `Report did not reconcile: channel sum ${sum} ≠ declared total ${data.totals.total_calls}. Nothing stored.` });
        }

        await upsertSummary(req.params.locationId, name, data);
        if (data.calls?.length) await upsertDetail(req.params.locationId, data);

        const cur = await periodSummary(req.params.locationId, data.period.start);
        const { rows: pr } = await pool.query(
          'SELECT MAX(period_start) AS p FROM call_summary WHERE location_id=$1 AND period_start < $2',
          [req.params.locationId, data.period.start]
        );
        const prev = pr[0].p ? await periodSummary(req.params.locationId, pr[0].p) : null;
        await postSlack(name, data.provider || 'marchex', cur, prev);

        res.json({ ok: true, period: data.period, totals: cur.totals, detailRows: data.calls?.length || 0 });
      } catch (e) { fail(res, e); }
    }
  );

  return router;
};
