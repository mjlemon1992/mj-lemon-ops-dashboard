const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticateToken, JWT_SECRET } = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    try {
      const result = await pool.query('SELECT * FROM users WHERE email = $1 AND active = true', [email.toLowerCase()]);
      if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
      const user = result.rows[0];
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
      const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role, name: user.name, location_id: user.location_id },
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
