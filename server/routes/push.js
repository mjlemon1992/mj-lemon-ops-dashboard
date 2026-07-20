const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { ensurePushTable, pushConfigured } = require('../lib/notify');

// Per-device push subscriptions. Any signed-in role may subscribe — what they
// GET notified about is decided at send time (notifyRoles targets roles), so
// an advisor device only ever receives re-order events.
module.exports = (pool) => {
  const router = express.Router();

  router.get('/vapid-key', authenticateToken, (req, res) => {
    if (!pushConfigured()) return res.status(503).json({ error: 'Push not configured on the server' });
    res.json({ key: process.env.VAPID_PUBLIC_KEY });
  });

  router.post('/subscribe', authenticateToken, async (req, res) => {
    try {
      await ensurePushTable(pool);
      const s = (req.body || {}).subscription;
      if (!s || !s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) {
        return res.status(400).json({ error: 'subscription {endpoint, keys.p256dh, keys.auth} required' });
      }
      await pool.query(
        `INSERT INTO push_subscription (user_id, endpoint, p256dh, auth, user_agent)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
        [req.user.id, String(s.endpoint).slice(0, 1000), s.keys.p256dh, s.keys.auth, String(req.headers['user-agent'] || '').slice(0, 300)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/unsubscribe', authenticateToken, async (req, res) => {
    try {
      await ensurePushTable(pool);
      const endpoint = (req.body || {}).endpoint;
      if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
      await pool.query('DELETE FROM push_subscription WHERE endpoint = $1 AND user_id = $2', [endpoint, req.user.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
