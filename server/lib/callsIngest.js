// Shared Marchex/Telmetrics call-report ingestion: PDF -> Claude extraction ->
// call_summary rows -> optional Slack card. Used by BOTH front doors:
//   - the manual upload endpoint (routes/marketingCalls.js)
//   - the parts-inbox email poller (routes/partsRecon.js), which routes any
//     forwarded Marchex report here instead of the invoice pipeline.
// The dashboard reads the tables, never the PDF, so a future live Marchex API
// only swaps the writer.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_WEBHOOK = process.env.SLACK_MARKETING_WEBHOOK_URL || null;
const MODEL = 'claude-sonnet-4-6';
const QUALIFIED_MIN_SECONDS = parseInt(process.env.QUALIFIED_MIN_SECONDS || '60', 10);

const SCHEMA = `{
  "provider": "marchex", "format": "telmetrics", "location": "Red Deer",
  "period": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
  "channels": [{ "channel": "ORGANIC|PPC|CALL_EXTENSION", "total_calls": 0, "answered_calls": 0,
    "missed_calls": 0, "unique_callers": 0, "avg_duration_seconds": 0, "qualified_calls": null,
    "numbers": [{ "tracking_number": "587-802-4670", "total_calls": 0, "answered_calls": 0,
      "missed_calls": 0, "unique_callers": 0, "avg_duration_seconds": 0, "qualified_calls": null }] }],
  "totals": { "organic_calls": 0, "paid_calls": 0, "total_calls": 0, "qualified_calls": null }
}`;

const SYSTEM_PROMPT = `You extract structured data from a monthly call-measurement PDF report.

Output ONLY a single JSON object matching the schema below. No prose, no markdown fences, no
explanation. If a field is unknown, use null. Do NOT output individual call rows — only the
per-number and per-channel aggregates in the schema.

CHANNEL: determine each section's channel from its header label:
  "...-PPC" -> "PPC"   "...-ORGANIC" -> "ORGANIC"   "...-CALL EXTENSION" -> "CALL_EXTENSION"
A tracking number's channel is whatever report section it appears under for this period. Do not
infer channel from the number itself.

For each channel, list every tracking number with its This-Period figures (total_calls,
answered_calls, missed_calls, unique_callers, avg_duration_seconds). Channel totals are the sum
of their numbers. Use the "This Period" column, never "To Date". Convert durations m:ss or
h:mm:ss to integer seconds.

QUALIFIED: if the report includes Call Detail pages, READ them and COUNT (do not list) the
qualified calls per tracking number — a call qualifies when its answer status is answered
(status code "A") AND its duration >= ${QUALIFIED_MIN_SECONDS} seconds. Put that count in each
number's qualified_calls, sum to the channel's qualified_calls, and sum all channels to
totals.qualified_calls. If the report has NO Call Detail pages, set every qualified_calls to null.

TOTALS:
  organic_calls = sum of ORGANIC channel total_calls
  paid_calls = sum of PPC + CALL_EXTENSION total_calls
  total_calls = organic_calls + paid_calls

Schema:
${SCHEMA}`;

let _init = false;
const ensureTables = async (pool) => {
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
      qualified_calls INTEGER,
      ingested_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (location_id, provider, period_start, channel, tracking_number)
    )`);
  // older deploys created the table without qualified_calls — add it idempotently.
  await pool.query('ALTER TABLE call_summary ADD COLUMN IF NOT EXISTS qualified_calls INTEGER');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_call_summary_loc_period ON call_summary(location_id, period_start DESC)');
  _init = true;
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
      max_tokens: 8000,
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
  if (body.stop_reason === 'max_tokens')
    throw Object.assign(new Error('Extraction hit the output limit — report unusually large. Tell us and we will raise the cap.'), { status: 502 });
  let raw = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('').replace(/```json|```/g, '').trim();
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');   // tolerate stray prose around the object
  if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw Object.assign(new Error('Extraction did not return valid JSON. Re-try; if it persists the PDF layout may need a prompt tweak.'), { status: 502 });
  }
};

const upsertSummary = async (pool, locationId, locationName, d) => {
  for (const ch of d.channels || []) {
    for (const n of ch.numbers || []) {
      await pool.query(
        `INSERT INTO call_summary
           (location_id, location_name, provider, format, period_start, period_end, channel,
            tracking_number, total_calls, answered_calls, missed_calls, unique_callers,
            avg_duration_seconds, qualified_calls, ingested_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
         ON CONFLICT (location_id, provider, period_start, channel, tracking_number) DO UPDATE SET
           total_calls=EXCLUDED.total_calls, answered_calls=EXCLUDED.answered_calls,
           missed_calls=EXCLUDED.missed_calls, unique_callers=EXCLUDED.unique_callers,
           avg_duration_seconds=EXCLUDED.avg_duration_seconds, qualified_calls=EXCLUDED.qualified_calls,
           period_end=EXCLUDED.period_end, location_name=EXCLUDED.location_name, ingested_at=NOW()`,
        [locationId, locationName, d.provider || 'marchex', d.format || 'telmetrics',
         d.period.start, d.period.end || null, ch.channel, n.tracking_number,
         n.total_calls || 0, n.answered_calls || 0, n.missed_calls || 0,
         n.unique_callers || 0, Math.round(n.avg_duration_seconds || 0),
         n.qualified_calls == null ? null : n.qualified_calls]
      );
    }
  }
};

// Aggregate stored rows for one period into channel + totals shape.
const periodSummary = async (pool, locationId, periodStart) => {
  const { rows } = await pool.query(
    `SELECT channel,
            SUM(total_calls)::int AS total_calls, SUM(answered_calls)::int AS answered_calls,
            SUM(missed_calls)::int AS missed_calls, SUM(unique_callers)::int AS unique_callers,
            SUM(qualified_calls)::int AS qualified_calls
       FROM call_summary WHERE location_id=$1 AND period_start=$2 GROUP BY channel`,
    [locationId, periodStart]
  );
  const by = Object.fromEntries(rows.map(r => [r.channel, r]));
  const organic = by.ORGANIC?.total_calls || 0;
  const paid = (by.PPC?.total_calls || 0) + (by.CALL_EXTENSION?.total_calls || 0);
  const qVals = rows.map(r => r.qualified_calls).filter(v => v != null);
  return {
    period_start: periodStart,
    channels: rows,
    totals: { organic, paid, total: organic + paid, qualified: qVals.length ? qVals.reduce((a, b) => a + b, 0) : null },
  };
};

// ── Slack card (optional) ──
const money = (n) => Number(n || 0).toLocaleString('en-CA');
const postSlack = async (locationName, provider, cur, prev) => {
  if (!SLACK_WEBHOOK) return;
  const monLabel = new Date(cur.period_start + 'T00:00:00').toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
  const ppc = cur.channels.find(c => c.channel === 'PPC')?.total_calls || 0;
  const callExt = cur.channels.find(c => c.channel === 'CALL_EXTENSION')?.total_calls || 0;
  const q = cur.totals.qualified;
  const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
  let mom = '';
  if (prev) {
    const s = (x) => (x == null ? 'n/a' : (x >= 0 ? `+${x}%` : `${x}%`));
    mom = `\nMoM:  Total ${s(pct(cur.totals.total, prev.totals.total))}   Paid ${s(pct(cur.totals.paid, prev.totals.paid))}   Organic ${s(pct(cur.totals.organic, prev.totals.organic))}`;
  }
  const orgPctOfTotal = cur.totals.total ? Math.round((cur.totals.organic / cur.totals.total) * 100) : 0;
  const text = `📞 *${locationName} — Call Tracking — ${monLabel}*  (${provider})\n` +
    '```' +
    `Organic         ${money(cur.totals.organic)}\n` +
    `PPC             ${money(ppc)}${q != null ? `   (qualified ≥${QUALIFIED_MIN_SECONDS}s: ${q})` : ''}\n` +
    `Call Extension  ${money(callExt)}\n` +
    `------------------------------\n` +
    `Total           ${money(cur.totals.total)}    Paid ${money(cur.totals.paid)} · Organic ${money(cur.totals.organic)} (${orgPctOfTotal}%)` +
    mom + '```';
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

// One-call ingest: extract, reconcile-check, store, Slack. Throws with .status on
// failure; nothing is stored when the report doesn't reconcile.
const ingestCallsPdf = async (pool, locationId, pdfBase64, provider = 'marchex') => {
  await ensureTables(pool);
  const { rows } = await pool.query('SELECT name FROM locations WHERE id = $1', [locationId]);
  if (!rows.length) throw Object.assign(new Error('Location not found'), { status: 404 });
  const name = rows[0].name;
  const data = await extract(pdfBase64, name, provider);

  const sum = (data.channels || []).reduce((a, c) => a + (c.total_calls || 0), 0);
  if (data.totals && sum !== data.totals.total_calls) {
    await postSlackFailure(name, data.period, sum, data.totals.total_calls);
    throw Object.assign(new Error(`Report did not reconcile: channel sum ${sum} ≠ declared total ${data.totals.total_calls}. Nothing stored.`), { status: 422 });
  }

  await upsertSummary(pool, locationId, name, data);

  const cur = await periodSummary(pool, locationId, data.period.start);
  const { rows: pr } = await pool.query(
    'SELECT MAX(period_start) AS p FROM call_summary WHERE location_id=$1 AND period_start < $2',
    [locationId, data.period.start]
  );
  const prev = pr[0].p ? await periodSummary(pool, locationId, pr[0].p) : null;
  await postSlack(name, data.provider || provider, cur, prev);

  return { ok: true, period: data.period, totals: cur.totals };
};

// Does this email look like a Marchex/Telmetrics call report? Used by the
// parts-inbox poller to route the PDF to calls ingestion instead of the
// invoice pipeline. Sender match is primary; subject match catches manual
// forwards that rewrite the sender.
const looksLikeCallReport = (from = '', subject = '') =>
  /marchex|telmetrics/i.test(from) || /marchex|telmetrics|call\s*(measurement|tracking|summary)/i.test(subject);

module.exports = {
  ensureTables, ingestCallsPdf, periodSummary, looksLikeCallReport,
  QUALIFIED_MIN_SECONDS, MODEL,
};
