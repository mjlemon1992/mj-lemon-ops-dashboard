const crypto = require('crypto');
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { recentInbox, markRead } = require('../lib/inbox');
const { draftReply } = require('../lib/draft');
const { upcomingEvents } = require('../lib/calendarFeed');
const { postSlack } = require('../lib/slack');

// Chief of Staff: stores the daily/weekly brief, the CoS's learnings about the
// owner (its self-tuning memory), and the owner's feedback. The scheduled CoS
// agent writes briefs + learnings via the sync key; the owner reads the brief
// and steers the learnings (reinforce / retire / teach) from the dashboard tab.
// That read-apply-write loop is what "self-learning" means here: memory + a
// feedback loop, refined every run — not model retraining.
module.exports = (pool) => {
  const router = express.Router();

  // Machine-to-machine auth for the scheduled agent: a valid X-Sync-Key
  // matching SYNC_SECRET stands in for a JWT (same pattern as Shopmonkey
  // refresh). Fails closed: if SYNC_SECRET is unset, JWT is required.
  const syncAuth = (req, res, next) => {
    const secret = process.env.SYNC_SECRET;
    const provided = req.get('X-Sync-Key');
    if (secret && provided && provided === secret) {
      req.user = { role: 'owner', via: 'sync-key' };
      return next();
    }
    return authenticateToken(req, res, next);
  };

  // The CoS is the owner's cross-business view — owner/partner only. Works for
  // the sync-key system user too (role 'owner').
  const ownerOrPartner = (req, res, next) => {
    if (!['owner', 'partner'].includes(req.user && req.user.role)) {
      return res.status(403).json({ error: 'Owner or Partner access required' });
    }
    next();
  };

  let _ensured = false;
  const ensureTables = async () => {
    if (_ensured) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cos_brief (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        brief_date DATE NOT NULL,
        kind TEXT NOT NULL DEFAULT 'daily',
        payload JSONB NOT NULL DEFAULT '{}',
        markdown TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_cos_brief_kind_date ON cos_brief(kind, created_at DESC);

      CREATE TABLE IF NOT EXISTS cos_learnings (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        category TEXT NOT NULL DEFAULT 'priority',
        insight TEXT NOT NULL,
        confidence INT NOT NULL DEFAULT 5,
        source TEXT NOT NULL DEFAULT 'observed',
        evidence TEXT,
        times_reinforced INT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS cos_feedback (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        brief_id UUID,
        kind TEXT NOT NULL DEFAULT 'teach',
        note TEXT NOT NULL,
        processed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Owner-authored automations: the conversational command box translates
      -- plain English ("send me marketing info at 10pm daily") into a row here,
      -- and the 24/7 backend scheduler (server/scheduler.js) runs the due ones.
      CREATE TABLE IF NOT EXISTS cos_automations (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        title TEXT NOT NULL,
        action_type TEXT NOT NULL,           -- marketing_digest | ops_digest | generate_posts
        params JSONB NOT NULL DEFAULT '{}',   -- e.g. { "count": 2 }
        time_local TEXT NOT NULL DEFAULT '07:00',  -- HH:MM in America/Edmonton
        frequency TEXT NOT NULL DEFAULT 'daily',   -- daily | weekly
        weekday INT,                          -- 0=Sun..6=Sat, for weekly
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        last_run_date DATE,                   -- guards against double-firing in a day
        created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Acknowledged ("cleared") alerts. Alerts are computed live from Shopmonkey,
      -- so we don't delete them — we record the ones Jamie has cleared (by their
      -- stable alertId key) and filter those out of the display + the badge count.
      CREATE TABLE IF NOT EXISTS cos_dismissed_alerts (
        alert_key TEXT PRIMARY KEY,
        dismissed_at TIMESTAMPTZ DEFAULT NOW(),
        dismissed_by TEXT
      );
    `);
    _ensured = true;
  };

  // ---------- BRIEFS ----------

  // Agent writes the morning/weekly brief.
  router.post('/brief', syncAuth, ownerOrPartner, async (req, res) => {
    try {
      await ensureTables();
      const { brief_date, kind, payload, markdown } = req.body || {};
      const r = await pool.query(
        `INSERT INTO cos_brief (brief_date, kind, payload, markdown)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [brief_date || new Date().toISOString().slice(0, 10), kind || 'daily', payload || {}, markdown || null]
      );
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Run the complete morning brief now (compose email + calendar + shop +
  // marketing and push to Slack), persisting the result. Same composer the 7am
  // automation uses — this is the manual "run my brief now" trigger.
  router.post('/brief/run', syncAuth, ownerOrPartner, async (req, res) => {
    try {
      await ensureTables();
      const r = await runMorningBrief('Morning brief');
      await pool.query(
        `INSERT INTO cos_brief (brief_date, kind, payload, markdown) VALUES ($1,$2,$3,$4)`,
        [new Date().toISOString().slice(0, 10), 'morning_brief', r.payload, r.markdown]
      );
      res.json({ ok: true, ...r.payload, markdown: r.markdown });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Latest brief for the dashboard tab.
  router.get('/brief/latest', authenticateToken, ownerOrPartner, async (req, res) => {
    try {
      await ensureTables();
      const r = await pool.query(
        `SELECT * FROM cos_brief WHERE kind = $1 ORDER BY created_at DESC LIMIT 1`,
        [req.query.kind || 'daily']
      );
      res.json(r.rows[0] || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Brief history (headers only).
  router.get('/brief', authenticateToken, ownerOrPartner, async (req, res) => {
    try {
      await ensureTables();
      const r = await pool.query(
        `SELECT id, brief_date, kind, created_at FROM cos_brief ORDER BY created_at DESC LIMIT 30`
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- LEARNINGS (self-tuning memory) ----------

  router.get('/learnings', authenticateToken, ownerOrPartner, async (req, res) => {
    try {
      await ensureTables();
      const r = await pool.query(
        `SELECT * FROM cos_learnings WHERE status = $1 ORDER BY confidence DESC, updated_at DESC`,
        [req.query.status || 'active']
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Add (no id) or update (with id) a learning. Agent writes observed learnings
  // via sync key; owner can add stated ones from the UI.
  router.post('/learnings', syncAuth, ownerOrPartner, async (req, res) => {
    try {
      await ensureTables();
      const { id, category, insight, confidence, source, evidence, status } = req.body || {};
      if (id) {
        const r = await pool.query(
          `UPDATE cos_learnings SET
             category = COALESCE($2, category),
             insight = COALESCE($3, insight),
             confidence = COALESCE($4, confidence),
             source = COALESCE($5, source),
             evidence = COALESCE($6, evidence),
             status = COALESCE($7, status),
             updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [id, category, insight, confidence, source, evidence, status]
        );
        return res.json(r.rows[0] || null);
      }
      if (!insight) return res.status(400).json({ error: 'insight required' });
      const r = await pool.query(
        `INSERT INTO cos_learnings (category, insight, confidence, source, evidence)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [category || 'priority', insight, confidence || 5,
         source || (req.user.via === 'sync-key' ? 'observed' : 'stated'), evidence || null]
      );
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Owner steers a learning: 'up' reinforces (confidence +1), 'down' retires it.
  router.post('/learnings/:id/vote', authenticateToken, ownerOrPartner, async (req, res) => {
    try {
      await ensureTables();
      const dir = (req.body && req.body.dir) || 'up';
      const sql = dir === 'down'
        ? `UPDATE cos_learnings SET status='retired', updated_at=NOW() WHERE id=$1 RETURNING *`
        : `UPDATE cos_learnings SET confidence=LEAST(confidence+1,10), times_reinforced=times_reinforced+1, updated_at=NOW() WHERE id=$1 RETURNING *`;
      const r = await pool.query(sql, [req.params.id]);
      res.json(r.rows[0] || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- FEEDBACK (owner teaches the CoS) ----------

  router.post('/feedback', authenticateToken, ownerOrPartner, async (req, res) => {
    try {
      await ensureTables();
      const { brief_id, kind, note } = req.body || {};
      if (!note) return res.status(400).json({ error: 'note required' });
      const r = await pool.query(
        `INSERT INTO cos_feedback (brief_id, kind, note) VALUES ($1,$2,$3) RETURNING *`,
        [brief_id || null, kind || 'teach', note]
      );
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Agent reads pending feedback (default) to fold into learnings.
  router.get('/feedback', syncAuth, ownerOrPartner, async (req, res) => {
    try {
      await ensureTables();
      const r = req.query.processed === 'all'
        ? await pool.query(`SELECT * FROM cos_feedback ORDER BY created_at DESC LIMIT 50`)
        : await pool.query(`SELECT * FROM cos_feedback WHERE processed = FALSE ORDER BY created_at ASC`);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Agent marks feedback processed once folded into learnings.
  router.post('/feedback/:id/processed', syncAuth, ownerOrPartner, async (req, res) => {
    try {
      await ensureTables();
      const r = await pool.query(
        `UPDATE cos_feedback SET processed = TRUE WHERE id = $1 RETURNING *`, [req.params.id]
      );
      res.json(r.rows[0] || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- AUTOMATIONS + CONVERSATIONAL COMMAND ----------

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const MODEL = 'claude-sonnet-4-6';

  // Compose the complete morning brief (email + calendar + shop + marketing) and
  // push it to Slack. Single source of truth for both the scheduled automation
  // and the manual /brief/run trigger. Returns { markdown, payload }; the caller
  // persists the cos_brief row.
  const runMorningBrief = async (title = 'Morning brief') => {
    let metrics = [], pendingPosts = 0;
    try {
      const m = await pool.query(`SELECT DISTINCT ON (location_id) location_id, revenue_mtd, parts_margin, avg_ro_value, effective_labour_rate, alerts FROM metrics_cache ORDER BY location_id, created_at DESC`);
      metrics = m.rows;
    } catch (e) { /* table not ready */ }
    try {
      const p = await pool.query(`SELECT COUNT(*)::int AS n FROM marketing_post WHERE status = 'draft'`);
      pendingPosts = p.rows[0] ? p.rows[0].n : 0;
    } catch (e) { /* table/column differs */ }

    const [inbox, cal] = await Promise.all([
      recentInbox({ user: process.env.GMAIL_IMAP_USER, pass: process.env.GMAIL_IMAP_PASS }),
      upcomingEvents((process.env.CAL_ICAL_URLS || '').split(',').map(s => s.trim()).filter(Boolean)),
    ]);
    let locs = [];
    try { locs = (await pool.query(`SELECT id, name FROM locations WHERE active = true`)).rows; } catch (e) {}
    const nameFor = (id) => { const l = locs.find(x => x.id === id); return l ? l.name : 'Shop'; };
    const cnt = (v) => { if (Array.isArray(v)) return v.length; try { const p = JSON.parse(v); return Array.isArray(p) ? p.length : 0; } catch { return 0; } };
    const shop = metrics.map(m => ({ shop: nameFor(m.location_id), revenue_mtd: m.revenue_mtd, parts_margin: m.parts_margin, avg_ro_value: m.avg_ro_value, effective_labour_rate: m.effective_labour_rate, open_alerts: cnt(m.alerts) }));
    const data = {
      today: new Date().toISOString().slice(0, 10),
      email: inbox.ok
        ? { actionNeeded: inbox.threads.filter(t => t.actionNeeded).slice(0, 8).map(t => ({ from: t.fromName, subject: t.subject })), unreadCount: inbox.threads.filter(t => t.unread).length }
        : { error: inbox.error },
      calendar: cal.ok
        ? { events: cal.events.slice(0, 12).map(e => ({ when: e.start, title: e.title, allDay: e.allDay })) }
        : { error: cal.error },
      shop,
      marketingApprovalsWaiting: pendingPosts,
    };
    let text = '';
    if (ANTHROPIC_KEY) {
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: MODEL, max_tokens: 800,
            system: `You write Jamie's morning brief, posted to Slack as mrkdwn. Jamie owns Mister Transmission shops and runs hot/disorganized — keep it short and scannable so he acts fast. Output Slack mrkdwn: *bold* for section headers, • for bullets, real line breaks. Include only sections that have content, in this order: a one-line headline (the single most important thing today); *Needs you* (action-needed emails as "sender — subject"); *Today & this week* (calendar, with times); *Shop pulse* (revenue MTD per shop, total open alerts, flag effective labour rate if notably below ~$150/hr); *Marketing* (N posts awaiting approval + ONE quick photo prompt to grab content today). Use ONLY the data provided — never invent a number, email, or event. If a source has an "error" field, add one short line like "(couldn't reach email this run)". Draft/propose tone; he acts on it.`,
            messages: [{ role: 'user', content: `Brief data (JSON):\n${JSON.stringify(data).slice(0, 6000)}\n\nWrite the Slack morning brief.` }],
          }),
        });
        const body = await r.json();
        if (r.ok) text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      } catch (e) { /* fall through to template */ }
    }
    if (!text) {
      const acts = inbox.ok ? inbox.threads.filter(t => t.actionNeeded).length : 0;
      text = `*Morning brief*\n• Email: ${inbox.ok ? `${acts} action-needed, ${inbox.threads.filter(t => t.unread).length} unread` : `unavailable (${inbox.error})`}\n• Calendar: ${cal.ok ? `${cal.events.length} events this week` : `unavailable (${cal.error})`}\n• Shops: ${shop.length} tracked, ${shop.reduce((n, s) => n + (s.open_alerts || 0), 0)} open alerts\n• Marketing: ${pendingPosts} posts awaiting approval`;
    }
    const slack = await postSlack(process.env.COS_SLACK_WEBHOOK, text);
    return {
      markdown: text,
      payload: { headline: title, delivered_to_slack: slack.ok, slack_error: slack.error || null, email_ok: inbox.ok, calendar_ok: cal.ok },
    };
  };

  // Bounded tool set the command interpreter may use. Deliberately small: it can
  // schedule, set a preference, or cancel — it cannot invent new powers, and
  // nothing it creates sends/posts/spends without the approval queue.
  const TOOLS = [
    {
      name: 'create_automation',
      description: 'Schedule a recurring automation the 24/7 dashboard scheduler will run. Use for requests like "send me marketing info at 10pm daily" or "build 2 marketing posts each week for approval".',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short human label, e.g. "Nightly marketing digest"' },
          action_type: { type: 'string', enum: ['morning_brief', 'marketing_digest', 'ops_digest', 'generate_posts'], description: 'morning_brief = the complete daily brief (email + calendar + shop numbers + marketing) posted to Slack; marketing_digest = a marketing summary; ops_digest = shop ops summary; generate_posts = draft captioned posts into the approval queue' },
          time_local: { type: 'string', description: '24h HH:MM in Mountain time, e.g. "22:00"' },
          frequency: { type: 'string', enum: ['daily', 'weekly'] },
          weekday: { type: 'integer', description: '0=Sunday..6=Saturday, only for weekly', minimum: 0, maximum: 6 },
          count: { type: 'integer', description: 'For generate_posts: how many per run (e.g. 2)' }
        },
        required: ['title', 'action_type', 'time_local', 'frequency']
      }
    },
    {
      name: 'set_preference',
      description: 'Record a standing preference about how the chief of staff should behave (priority, tone, what to ignore, format, timing).',
      input_schema: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['priority', 'focus', 'ignore', 'tone', 'timing', 'format', 'source'] },
          insight: { type: 'string', description: 'The preference as a clear rule, e.g. "Always surface legal and bank items first"' }
        },
        required: ['category', 'insight']
      }
    },
    {
      name: 'cancel_automation',
      description: 'Disable an existing automation the owner no longer wants.',
      input_schema: {
        type: 'object',
        properties: { title_match: { type: 'string', description: 'Words from the automation title to match' } },
        required: ['title_match']
      }
    }
  ];

  const SYSTEM = `You are the configuration brain for Jamie's Chief of Staff inside his ops dashboard. Jamie speaks plainly ("from now on send me marketing info at 10pm every day", "build 2 marketing designs each week and send them for approval"). Translate each instruction into the right tool call(s). Times are Mountain time. "designs/posts for approval" => create_automation action_type generate_posts (they land in the approval queue, never auto-posted). A recurring info/summary => marketing_digest or ops_digest. A standing rule about behaviour => set_preference. If the instruction is ambiguous (e.g. no time given), ask one short clarifying question instead of guessing. After acting, never claim anything was sent or posted — everything waits for Jamie's approval.`;

  const callClaude = async (text) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system: SYSTEM, tools: TOOLS, messages: [{ role: 'user', content: text }] })
    });
    const body = await r.json();
    if (!r.ok) throw Object.assign(new Error(`Anthropic ${r.status}: ${JSON.stringify(body).slice(0, 200)}`), { status: 502 });
    return body;
  };

  // Owner types an instruction; Claude turns it into automation(s)/preference(s).
  router.post('/command', authenticateToken, ownerOrPartner, async (req, res) => {
    try {
      await ensureTables();
      if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on the server' });
      const text = (req.body && req.body.text || '').trim();
      if (!text) return res.status(400).json({ error: 'text required' });

      const body = await callClaude(text);
      const blocks = Array.isArray(body.content) ? body.content : [];
      const says = blocks.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
      const toolUses = blocks.filter(b => b.type === 'tool_use');
      const done = [];

      for (const t of toolUses) {
        const a = t.input || {};
        if (t.name === 'create_automation') {
          const r = await pool.query(
            `INSERT INTO cos_automations (title, action_type, params, time_local, frequency, weekday, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [a.title || 'Automation', a.action_type, a.count ? { count: a.count } : {},
             a.time_local || '07:00', a.frequency || 'daily',
             (a.frequency === 'weekly' && a.weekday != null) ? a.weekday : null, req.user.email || 'owner']
          );
          done.push({ kind: 'automation', row: r.rows[0] });
        } else if (t.name === 'set_preference') {
          const r = await pool.query(
            `INSERT INTO cos_learnings (category, insight, confidence, source) VALUES ($1,$2,7,'stated') RETURNING *`,
            [a.category || 'priority', a.insight]
          );
          done.push({ kind: 'preference', row: r.rows[0] });
        } else if (t.name === 'cancel_automation') {
          const r = await pool.query(
            `UPDATE cos_automations SET enabled = FALSE WHERE title ILIKE $1 AND enabled = TRUE RETURNING *`,
            [`%${a.title_match}%`]
          );
          done.push({ kind: 'cancelled', rows: r.rows });
        }
      }

      // Build a plain confirmation without a second model round-trip.
      let reply = says;
      if (!reply) {
        if (!done.length) reply = "I didn't catch a clear instruction — try e.g. “send me a marketing digest at 10pm daily”.";
        else reply = done.map(d => {
          if (d.kind === 'automation') { const r = d.row; return `Scheduled “${r.title}” — ${r.frequency}${r.weekday != null ? ' (weekly)' : ''} at ${r.time_local} Mountain.`; }
          if (d.kind === 'preference') return `Got it — I'll remember: “${d.row.insight}”.`;
          if (d.kind === 'cancelled') return d.rows.length ? `Turned off ${d.rows.length} automation(s).` : `Couldn't find a matching automation to cancel.`;
          return '';
        }).filter(Boolean).join(' ');
      }
      res.json({ reply, actions: done });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // List the owner's automations.
  router.get('/automations', authenticateToken, ownerOrPartner, async (req, res) => {
    try {
      await ensureTables();
      const r = await pool.query(`SELECT * FROM cos_automations ORDER BY enabled DESC, created_at DESC`);
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Toggle an automation on/off.
  router.post('/automations/:id/toggle', authenticateToken, ownerOrPartner, async (req, res) => {
    try {
      await ensureTables();
      const r = await pool.query(
        `UPDATE cos_automations SET enabled = NOT enabled WHERE id = $1 RETURNING *`, [req.params.id]
      );
      res.json(r.rows[0] || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Scheduler (sync key) invokes this when an automation is due. Generates the
  // output and stores it as a cos_brief of the automation's kind. Generative
  // marketing output is queued for approval — never auto-posted.
  router.post('/run-automation/:id', syncAuth, ownerOrPartner, async (req, res) => {
    try {
      await ensureTables();
      const ar = await pool.query(`SELECT * FROM cos_automations WHERE id = $1 AND enabled = TRUE`, [req.params.id]);
      const a = ar.rows[0];
      if (!a) return res.status(404).json({ error: 'automation not found or disabled' });

      // Best-effort context (never let a missing table break the run).
      let metrics = [], pendingPosts = 0;
      try {
        const m = await pool.query(`SELECT DISTINCT ON (location_id) location_id, revenue_mtd, parts_margin, avg_ro_value, effective_labour_rate, alerts FROM metrics_cache ORDER BY location_id, created_at DESC`);
        metrics = m.rows;
      } catch (e) { /* table not ready */ }
      try {
        const p = await pool.query(`SELECT COUNT(*)::int AS n FROM marketing_post WHERE status = 'draft'`);
        pendingPosts = p.rows[0] ? p.rows[0].n : 0;
      } catch (e) { /* table/column differs */ }

      let markdown = '', payload = {};
      if (a.action_type === 'morning_brief') {
        // The complete brief: email + calendar + shop + marketing -> Slack.
        const r = await runMorningBrief(a.title);
        markdown = r.markdown;
        payload = r.payload;
      } else if (a.action_type === 'generate_posts') {
        const count = (a.params && a.params.count) || 2;
        markdown = `${count} marketing post(s) queued. Add bay/job photos in Marketing — they'll be captioned and dropped into the approval queue for you. (Auto-generation from your photo library lands in Phase 2b.)`;
        payload = { headline: `${count} marketing posts to create`, marketing: [{ title: `${count} posts queued for approval`, detail: 'Add photos in Marketing; captions + approval queue follow.' }] };
      } else {
        const lens = a.action_type === 'ops_digest'
          ? 'shop operations (alerts, parts margin, effective labour rate, average RO value)'
          : 'marketing (reviews, posts awaiting approval, what to push this period)';
        let says = '';
        if (ANTHROPIC_KEY) {
          try {
            const r = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
              body: JSON.stringify({
                model: MODEL, max_tokens: 600,
                system: `You write a tight ${lens} digest for Jamie, an automotive shop owner. 4-7 short concrete bullets, no fluff. Use ONLY the data provided; never invent numbers. If the data is thin, say plainly what's missing.`,
                messages: [{ role: 'user', content: `Data (JSON):\n${JSON.stringify({ metrics, pendingApprovals: pendingPosts }).slice(0, 4000)}\n\nWrite the digest.` }]
              })
            });
            const body = await r.json();
            if (r.ok) says = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
          } catch (e) { /* fall through to template */ }
        }
        markdown = says || `Digest: ${metrics.length} location(s) tracked; ${pendingPosts} marketing post(s) awaiting approval.`;
        payload = { headline: a.title };
      }

      await pool.query(
        `INSERT INTO cos_brief (brief_date, kind, payload, markdown) VALUES ($1,$2,$3,$4)`,
        [new Date().toISOString().slice(0, 10), a.action_type, payload, markdown]
      );
      await pool.query(`UPDATE cos_automations SET last_run_date = CURRENT_DATE WHERE id = $1`, [a.id]);
      res.json({ ok: true, action_type: a.action_type });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Diagnostic for the morning-brief sources. Returns the REAL connection error
  // (and password shape — length / has-space — but never the password itself or
  // email content) so we can fix the wiring without guessing.
  router.get('/debug/sources', syncAuth, ownerOrPartner, async (req, res) => {
    try {
      const pass = process.env.GMAIL_IMAP_PASS || '';
      const icals = (process.env.CAL_ICAL_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
      const inbox = await recentInbox({ user: process.env.GMAIL_IMAP_USER, pass, max: 3 });
      const cal = await upcomingEvents(icals);
      res.json({
        env: {
          gmail_user: process.env.GMAIL_IMAP_USER || null,
          gmail_pass_set: !!pass,
          gmail_pass_len: pass.length,
          gmail_pass_has_space: /\s/.test(pass),
          ical_count: icals.length,
          slack_set: !!process.env.COS_SLACK_WEBHOOK,
        },
        inbox: { ok: inbox.ok, error: inbox.error || null, count: (inbox.threads || []).length },
        calendar: { ok: cal.ok, error: cal.error || null, count: (cal.events || []).length },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- ALERT ACKNOWLEDGE ("clear the alerts") ----------

  // Clear one or more alerts by their stable alertId key. Used by the Alerts
  // page Resolve button AND the voice chief of staff ("clear the alerts").
  router.post('/alerts/ack', syncAuth, ownerOrPartner, async (req, res) => {
    try {
      await ensureTables();
      const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys.filter(k => typeof k === 'string' && k) : [];
      if (!keys.length) return res.status(400).json({ error: 'keys[] required' });
      const by = (req.user && req.user.email) || 'owner';
      for (const k of keys) {
        await pool.query(
          `INSERT INTO cos_dismissed_alerts (alert_key, dismissed_by) VALUES ($1,$2)
           ON CONFLICT (alert_key) DO UPDATE SET dismissed_at = NOW(), dismissed_by = EXCLUDED.dismissed_by`,
          [k, by]
        );
      }
      res.json({ dismissed: keys.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // The set of currently-cleared alert keys (so the UI + badge filter them out).
  router.get('/alerts/dismissed', syncAuth, ownerOrPartner, async (req, res) => {
    try {
      await ensureTables();
      const r = await pool.query(`SELECT alert_key FROM cos_dismissed_alerts`);
      res.json(r.rows.map(x => x.alert_key));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Restore (un-clear) alerts.
  router.post('/alerts/unack', authenticateToken, ownerOrPartner, async (req, res) => {
    try {
      await ensureTables();
      const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
      if (!keys.length) return res.status(400).json({ error: 'keys[] required' });
      await pool.query(`DELETE FROM cos_dismissed_alerts WHERE alert_key = ANY($1)`, [keys]);
      res.json({ restored: keys.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- VOICE / CONVERSATIONAL CHAT ----------

  // Server-side mirror of client alertId(): stable key per alert.
  const alertKey = (a) => `${a.type}-${a.ro || a.vehicle || ''}`;
  const liveAlerts = async () => {
    const m = await pool.query(`SELECT DISTINCT ON (location_id) location_id, alerts FROM metrics_cache ORDER BY location_id, created_at DESC`);
    const d = await pool.query(`SELECT alert_key FROM cos_dismissed_alerts`);
    const dset = new Set(d.rows.map(x => x.alert_key));
    const out = [];
    for (const row of m.rows) {
      let arr = row.alerts;
      if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
      if (!Array.isArray(arr)) arr = [];
      for (const a of arr) { const key = alertKey(a); if (!dset.has(key)) out.push({ key, ...a }); }
    }
    return out;
  };

  const VOICE_SYSTEM = `You are Jamie's chief of staff, talking WITH him out loud inside his ops dashboard — a sharp, warm executive assistant who knows his business (Mister Transmission shops; he runs hot and disorganized, so you keep him on track). This is a real two-way conversation: HE leads, you help. Don't dump a briefing unless he asks for one. He might say "give me today's briefing", "I want to create a marketing post", "clear the alerts", "schedule something", or just ask a question.

When he wants to CREATE something (like a marketing post), have a short back-and-forth first — ask one or two quick clarifying questions to get what you need (what's it about? which shop? any offer?), then do it. One question at a time, conversational.

SPEAK like a person: short, natural sentences, no markdown, never read out "bullet one, bullet two". Before briefing him or quoting his numbers, call get_context. You CAN, right here: brief him, READ his action-needed emails and DRAFT replies to them (saved to his Gmail Drafts — never sent), draft a marketing post into the approval queue, clear alerts, schedule automations, set preferences. You CANNOT read his calendar from this dashboard — for that, tell him to use the Claude app. Never claim anything was sent, posted, or paid — email replies are saved as Gmail drafts for his review, posts wait in the approval queue. To reply to an email: call get_action_emails to find the right one, write the reply in his plain, friendly, no-hype voice, then call draft_email_reply with the original sender + message id, and tell him it's sitting in his Gmail drafts to review and send. When he says he's done with / has handled / wants to clear one or more emails, call mark_email_done with their uid(s) — that marks them read and clears them off his action list (reversible, nothing deleted). If you're unsure what he wants said, ask one quick question first. Confirm before clearing alerts or staging a post.`;

  const chatTools = [
    { name: 'get_context', description: "Fetch Jamie's latest brief, open alerts, marketing approvals waiting, and his automations. Call this before briefing him or answering about the business.", input_schema: { type: 'object', properties: {} } },
    { name: 'clear_alerts', description: 'Clear/acknowledge alerts. Pass specific alert keys, or all:true to clear every open alert.', input_schema: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean' } } } },
    { name: 'create_automation', description: 'Schedule a recurring automation (e.g. a 7am morning brief, or a 10pm marketing digest).', input_schema: { type: 'object', properties: { title: { type: 'string' }, action_type: { type: 'string', enum: ['morning_brief', 'marketing_digest', 'ops_digest', 'generate_posts'] }, time_local: { type: 'string' }, frequency: { type: 'string', enum: ['daily', 'weekly'] }, weekday: { type: 'integer' }, count: { type: 'integer' } }, required: ['title', 'action_type', 'time_local', 'frequency'] } },
    { name: 'set_preference', description: 'Record a standing preference (priority/ignore/tone/etc).', input_schema: { type: 'object', properties: { category: { type: 'string' }, insight: { type: 'string' } }, required: ['category', 'insight'] } },
    { name: 'draft_marketing_post', description: 'Draft a social media post (Instagram/Facebook/Google) and stage it in the marketing approval queue. Only call this once you have what the post is about — ask Jamie first if you do not.', input_schema: { type: 'object', properties: { topic: { type: 'string', description: 'What the post is about — the job, offer, or message' }, offer: { type: 'string', description: 'Any promo/offer to include (optional)' } }, required: ['topic'] } },
    { name: 'get_action_emails', description: "Read Jamie's recent action-needed / unread emails (sender, subject, date, message id). Call this before drafting an email reply so you know who to reply to and can thread it correctly.", input_schema: { type: 'object', properties: {} } },
    { name: 'draft_email_reply', description: "Write a reply to one of Jamie's emails and SAVE IT AS A DRAFT in his Gmail — it never sends. Use after get_action_emails. YOU compose the full reply text in Jamie's plain, friendly, no-hype voice from his instruction. If unsure what he wants to say, ask him first.", input_schema: { type: 'object', properties: { to: { type: 'string', description: "recipient email — the original sender's address" }, subject: { type: 'string', description: 'the original subject (Re: is added automatically)' }, body: { type: 'string', description: 'the full reply text, ready for Jamie to review and send' }, in_reply_to: { type: 'string', description: 'the original message id from get_action_emails, so the draft threads onto the conversation' } }, required: ['to', 'body'] } },
    { name: 'mark_email_done', description: "Mark one or more action emails as handled — clears them off Jamie's action list by marking them READ in Gmail. Reversible; nothing is deleted, archived, or moved. Use when Jamie says he's done with / has handled / wants to clear an email. Pass the uid(s) from get_action_emails.", input_schema: { type: 'object', properties: { uids: { type: 'array', items: { type: 'integer' }, description: 'the uid value(s) from get_action_emails for the email(s) Jamie has handled' } }, required: ['uids'] } }
  ];

  const execTool = async (name, input, who) => {
    if (name === 'get_context') {
      const [brief, alerts] = await Promise.all([
        pool.query(`SELECT brief_date, payload, markdown FROM cos_brief WHERE kind='daily' ORDER BY created_at DESC LIMIT 1`).then(r => r.rows[0] || null),
        liveAlerts()
      ]);
      let pendingApprovals = 0;
      try { const p = await pool.query(`SELECT COUNT(*)::int n FROM marketing_post WHERE status='draft'`); pendingApprovals = p.rows[0] ? p.rows[0].n : 0; } catch (e) {}
      const autos = await pool.query(`SELECT title, action_type, time_local, frequency FROM cos_automations WHERE enabled=true`).then(r => r.rows).catch(() => []);
      return { brief, alerts, pendingApprovals, automations: autos };
    }
    if (name === 'clear_alerts') {
      let keys = Array.isArray(input.keys) ? input.keys : [];
      if (input.all) keys = (await liveAlerts()).map(a => a.key);
      for (const k of keys) {
        await pool.query(`INSERT INTO cos_dismissed_alerts (alert_key, dismissed_by) VALUES ($1,$2) ON CONFLICT (alert_key) DO UPDATE SET dismissed_at=NOW()`, [k, who]);
      }
      return { cleared: keys.length };
    }
    if (name === 'create_automation') {
      const r = await pool.query(
        `INSERT INTO cos_automations (title, action_type, params, time_local, frequency, weekday, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING title, time_local, frequency`,
        [input.title || 'Automation', input.action_type, input.count ? { count: input.count } : {}, input.time_local || '07:00', input.frequency || 'daily', (input.frequency === 'weekly' && input.weekday != null) ? input.weekday : null, who]
      );
      return { scheduled: r.rows[0] };
    }
    if (name === 'set_preference') {
      await pool.query(`INSERT INTO cos_learnings (category, insight, confidence, source) VALUES ($1,$2,7,'stated')`, [input.category || 'priority', input.insight]);
      return { remembered: input.insight };
    }
    if (name === 'draft_marketing_post') {
      const topic = (input.topic || '').trim();
      if (!topic) return { error: 'need a topic first' };
      const loc = await pool.query(`SELECT id, name FROM locations WHERE active = true ORDER BY created_at LIMIT 1`).then(r => r.rows[0] || null).catch(() => null);
      let caps = { ig: '', fb: '', gbp: '' };
      if (ANTHROPIC_KEY) {
        try {
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({
              model: MODEL, max_tokens: 600,
              system: 'You write social captions for an automotive transmission repair shop. Given a topic (and optional offer), return ONLY a JSON object {"ig":"...","fb":"...","gbp":"..."} with an Instagram, Facebook, and Google Business Profile caption. Friendly, local, trustworthy. No invented claims, no fake reviews.',
              messages: [{ role: 'user', content: `Topic: ${topic}${input.offer ? `\nOffer: ${input.offer}` : ''}\nWrite the captions.` }]
            })
          });
          const body = await r.json();
          if (r.ok) {
            const txt = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
            const mt = txt.match(/\{[\s\S]*\}/);
            if (mt) { const j = JSON.parse(mt[0]); caps = { ig: j.ig || '', fb: j.fb || '', gbp: j.gbp || '' }; }
          }
        } catch (e) { /* fall through with empty captions */ }
      }
      await pool.query(
        `INSERT INTO marketing_post (location_id, location_name, status, note, caption_ig, caption_fb, caption_gbp)
         VALUES ($1,$2,'draft',$3,$4,$5,$6)`,
        [loc ? loc.id : null, loc ? loc.name : null, topic, caps.ig, caps.fb, caps.gbp]
      );
      return { staged: true, topic, note: 'Drafted captions and added it to the Marketing approval queue. Add a photo and approve it there when ready.' };
    }
    if (name === 'get_action_emails') {
      const inbox = await recentInbox({ user: process.env.GMAIL_IMAP_USER, pass: process.env.GMAIL_IMAP_PASS });
      if (!inbox.ok) return { error: inbox.error };
      const emails = inbox.threads.filter(t => t.actionNeeded || t.unread).slice(0, 12).map(t => ({
        from: t.from, fromName: t.fromName, subject: t.subject, date: t.date, unread: t.unread, messageId: t.messageId, uid: t.uid,
      }));
      return { count: emails.length, emails };
    }
    if (name === 'draft_email_reply') {
      const to = (input.to || '').trim();
      const body = (input.body || '').trim();
      if (!to || !body) return { error: 'need a recipient (to) and a reply body' };
      const r = await draftReply({
        user: process.env.GMAIL_IMAP_USER, pass: process.env.GMAIL_IMAP_PASS,
        to, subject: input.subject || '', body, inReplyTo: input.in_reply_to || null,
        fromName: process.env.GMAIL_FROM_NAME || 'Jamie Lemon',
      });
      if (!r.ok) return { error: r.error };
      return { drafted: true, to, where: 'Gmail Drafts', note: 'Saved the reply to his Gmail Drafts — nothing sent. He reviews and sends it from Gmail.' };
    }
    if (name === 'mark_email_done') {
      const uids = Array.isArray(input.uids) ? input.uids : [input.uids];
      if (!uids.filter(Boolean).length) return { error: 'need the uid(s) from get_action_emails' };
      const r = await markRead({ user: process.env.GMAIL_IMAP_USER, pass: process.env.GMAIL_IMAP_PASS, uids });
      if (!r.ok) return { error: r.error };
      return { done: true, cleared: r.marked, note: 'Marked read in Gmail — cleared off his action list. Reversible; nothing deleted or archived.' };
    }
    return { error: 'unknown tool' };
  };

  // The Atlas brain: one conversational "turn" = up to 4 model<->tool rounds,
  // returning the final reply plus the updated message history. Shared by the
  // dashboard voice chat AND the always-on Slack endpoint below, so both surfaces
  // run the identical reasoning + tools.
  const atlasTurn = async (messages, who) => {
    let msgs = messages.slice(-20);
    for (let i = 0; i < 4; i++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 700, system: VOICE_SYSTEM, tools: chatTools, messages: msgs })
      });
      const body = await r.json();
      if (!r.ok) throw Object.assign(new Error(`Anthropic ${r.status}: ${JSON.stringify(body).slice(0, 200)}`), { status: 502 });
      const blocks = Array.isArray(body.content) ? body.content : [];
      const toolUses = blocks.filter(b => b.type === 'tool_use');
      if (!toolUses.length) {
        const reply = blocks.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
        return { reply, messages: [...msgs, { role: 'assistant', content: blocks }] };
      }
      msgs.push({ role: 'assistant', content: blocks });
      const results = [];
      for (const t of toolUses) {
        let out; try { out = await execTool(t.name, t.input || {}, who); } catch (e) { out = { error: e.message }; }
        results.push({ type: 'tool_result', tool_use_id: t.id, content: JSON.stringify(out).slice(0, 4000) });
      }
      msgs.push({ role: 'user', content: results });
    }
    return { reply: "Sorry, I got a bit tangled — say that again?", messages: msgs };
  };

  // Voice/text conversation (dashboard). The browser does speech<->text; this runs
  // the reasoning + actions. Pass {briefing:true} on the first turn to open with
  // the briefing, then send the running {messages} array each turn.
  router.post('/chat', authenticateToken, ownerOrPartner, async (req, res) => {
    try {
      await ensureTables();
      if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on the server' });
      const who = (req.user && req.user.email) || 'owner';
      let messages = Array.isArray(req.body && req.body.messages) ? req.body.messages.slice(-20) : [];
      if (req.body && req.body.briefing) messages = [{ role: 'user', content: 'Good morning — give me my briefing.' }];
      if (!messages.length) return res.status(400).json({ error: 'messages[] or briefing required' });
      const { reply, messages: out } = await atlasTurn(messages, who);
      res.json({ reply, messages: out });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // ---------- ALWAYS-ON ATLAS IN SLACK ----------
  // Inbound Slack Events endpoint. Jamie messages the Atlas bot from anywhere
  // (his phone included) and the SAME brain that powers /chat answers + acts —
  // no Claude app needed, 24/7. Draft/approve rules still apply (nothing sends,
  // posts, or spends without his tap).
  //
  // One-time setup: create a Slack app -> Event Subscriptions Request URL =
  //   https://<dashboard>/api/cos/slack/events ; subscribe to bot events
  //   message.im (DMs) + app_mention (@Atlas in any channel it's added to) ;
  //   bot scopes chat:write, im:history, app_mentions:read ; then set on the
  //   server: SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, and optional
  //   SLACK_OWNER_USER_ID (restrict Atlas to only answer Jamie).
  const seenEvents = new Set();   // de-dupe Slack's delivery retries (per process)
  const chanHistory = new Map();  // short rolling context, keyed by Slack channel

  const verifySlack = (req) => {
    const secret = process.env.SLACK_SIGNING_SECRET;
    if (!secret || !req.rawBody) return false;
    const ts = req.get('X-Slack-Request-Timestamp');
    const sig = req.get('X-Slack-Signature') || '';
    if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay guard (5 min)
    const mine = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${req.rawBody.toString('utf8')}`).digest('hex');
    try { return crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(sig)); } catch { return false; }
  };

  const slackReply = async (channel, text, thread_ts) => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token || !channel || !text) return;
    try {
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ channel, text, thread_ts, mrkdwn: true }),
      });
    } catch (e) { /* best-effort */ }
  };

  router.post('/slack/events', async (req, res) => {
    const b = req.body || {};
    if (b.type === 'url_verification') return res.json({ challenge: b.challenge }); // setup handshake
    if (!verifySlack(req)) return res.status(401).end();
    // Ack inside Slack's 3s window, THEN run the slow model loop async (Slack
    // retries on a non-200, which would double-answer).
    res.status(200).end();
    try {
      if (b.type !== 'event_callback' || !b.event) return;
      const ev = b.event;
      if (ev.bot_id || ev.subtype) return;                            // skip the bot's own + edits/joins
      // DMs (message.im, answer everything) + channel @mentions (app_mention,
      // answer only when called) — so Atlas is live in any channel it's added to
      // without butting into every message.
      if (ev.type !== 'message' && ev.type !== 'app_mention') return;
      const owner = process.env.SLACK_OWNER_USER_ID;
      if (owner && ev.user !== owner) return;                         // only answer Jamie
      if (b.event_id) {                                               // drop duplicate retries
        if (seenEvents.has(b.event_id)) return;
        seenEvents.add(b.event_id); if (seenEvents.size > 1000) seenEvents.clear();
      }
      const text = (ev.text || '').replace(/<@[A-Z0-9]+>/g, '').trim(); // strip the "@Atlas" mention
      if (!text || !ANTHROPIC_KEY) return;
      await ensureTables();
      // Separate short context per conversation (a DM, or a specific channel thread).
      const convoKey = ev.channel + (ev.thread_ts ? ':' + ev.thread_ts : '');
      const prior = chanHistory.get(convoKey) || [];
      const { reply, messages } = await atlasTurn([...prior, { role: 'user', content: text }], 'slack:' + (ev.user || 'owner'));
      chanHistory.set(convoKey, messages.slice(-20));
      await slackReply(ev.channel, reply, ev.thread_ts || ev.ts);
    } catch (e) {
      try { await slackReply(b.event && b.event.channel, `Hit a snag: ${e.message}`); } catch (_) { /* ignore */ }
    }
  });

  return router;
};
