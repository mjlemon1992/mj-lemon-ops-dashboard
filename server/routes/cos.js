const express = require('express');
const { authenticateToken } = require('../middleware/auth');

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

  return router;
};
