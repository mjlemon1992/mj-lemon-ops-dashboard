const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticateToken, JWT_SECRET } = require('../middleware/auth');

// A valid bcrypt hash of a random string — compared against when the email is
// unknown so a failed login costs the same time whether or not the account exists.
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

module.exports = (pool) => {
  const router = express.Router();

  // In-memory login throttle: slows online password guessing. 8 fails per
  // email+IP in 15 min locks that pair out. Resets on restart (acceptable —
  // a determined attacker restarting our server is not the threat model).
  const loginFails = new Map();
  const LOGIN_MAX = 8, LOGIN_WINDOW = 15 * 60 * 1000;
  const loginKey = (req, email) => ((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '?') + '|' + email;

  router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const lk = loginKey(req, String(email).toLowerCase());
    const lf = loginFails.get(lk);
    if (lf && lf.count >= LOGIN_MAX && Date.now() - lf.first < LOGIN_WINDOW) {
      return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    }
    const bumpFail = () => {
      const e = loginFails.get(lk);
      if (!e || Date.now() - e.first > LOGIN_WINDOW) loginFails.set(lk, { count: 1, first: Date.now() });
      else e.count++;
    };
    try {
      const result = await pool.query('SELECT * FROM users WHERE email = $1 AND active = true', [email.toLowerCase()]);
      const user = result.rows[0];
      // Always run a bcrypt compare — against a dummy hash when the email is
      // unknown — so response time doesn't reveal whether an account exists.
      const hash = user ? user.password_hash : DUMMY_HASH;
      const valid = await bcrypt.compare(password, hash);
      if (!user || !valid) { bumpFail(); return res.status(401).json({ error: 'Invalid credentials' }); }
      loginFails.delete(lk);
      const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role, name: user.name, location_id: user.location_id, tv: Number(user.token_version) || 1 },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      res.json({ token, user: { id: user.id, email: user.email, role: user.role, name: user.name, location_id: user.location_id } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/me', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query('SELECT id, email, role, name, location_id, created_at FROM users WHERE id = $1', [req.user.id]);
      if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/change-password', authenticateToken, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
    try {
      const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
      const user = result.rows[0];
      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
      const hash = await bcrypt.hash(newPassword, 12);
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
      res.json({ message: 'Password updated' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
