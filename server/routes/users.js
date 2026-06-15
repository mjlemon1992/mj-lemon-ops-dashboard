const express = require('express');
const bcrypt = require('bcryptjs');
const { authenticateToken, requireOwner } = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  router.get('/', authenticateToken, requireOwner, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT id, email, name, role, location_id, active, created_at FROM users ORDER BY name'
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', authenticateToken, requireOwner, async (req, res) => {
    const { email, name, role, location_id, password } = req.body;
    if (!email || !name || !role || !password) return res.status(400).json({ error: 'email, name, role, password required' });
    if (!['owner', 'partner', 'manager'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    try {
      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
      if (existing.rows.length) return res.status(409).json({ error: 'Email already in use' });
      const hash = await bcrypt.hash(password, 12);
      const result = await pool.query(
        'INSERT INTO users (email, name, role, location_id, password_hash, active) VALUES ($1,$2,$3,$4,$5,true) RETURNING id, email, name, role, location_id, active, created_at',
        [email.toLowerCase(), name, role, location_id || null, hash]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id', authenticateToken, requireOwner, async (req, res) => {
    const { name, role, location_id, active } = req.body;
    try {
      const result = await pool.query(
        'UPDATE users SET name=$1, role=$2, location_id=$3, active=$4, updated_at=NOW() WHERE id=$5 RETURNING id, email, name, role, location_id, active',
        [name, role, location_id || null, active, req.params.id]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id/reset-password', authenticateToken, requireOwner, async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ error: 'newPassword required' });
    try {
      const hash = await bcrypt.hash(newPassword, 12);
      await pool.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, req.params.id]);
      res.json({ message: 'Password reset' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
