const express = require('express');
const bcrypt = require('bcryptjs');
const { authenticateToken, requireOwner, invalidateUserCache } = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  // Existing databases carry the original 3-role CHECK constraint; widen it
  // once so the advisor role can be stored (schema.sql matches for fresh DBs).
  let _ensured = null;
  const ensureRoles = () => {
    if (!_ensured) _ensured = pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
      ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner','partner','manager','advisor'))`)
      .catch((e) => { _ensured = null; throw e; });
    return _ensured;
  };

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
    if (!['owner', 'partner', 'manager', 'advisor'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    // Advisors are location-scoped by definition — without one they'd see nothing.
    if (role === 'advisor' && !location_id) return res.status(400).json({ error: 'An advisor needs a location' });
    try {
      await ensureRoles();
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

  // True when :id is the last ACTIVE owner — demoting, deactivating or deleting
  // that account would lock everyone out of admin, so those paths are blocked.
  const lastActiveOwner = async (id) => {
    const g = await pool.query(
      `SELECT u.role = 'owner' AND u.active = true
              AND (SELECT COUNT(*)::int FROM users WHERE role = 'owner' AND active = true) <= 1 AS last
         FROM users u WHERE u.id = $1`, [id]);
    if (!g.rows.length) return null;           // user doesn't exist
    return g.rows[0].last === true;
  };

  router.put('/:id', authenticateToken, requireOwner, async (req, res) => {
    const { name, role, location_id, active } = req.body;
    if (role && !['owner', 'partner', 'manager', 'advisor'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (role === 'advisor' && !location_id) return res.status(400).json({ error: 'An advisor needs a location' });
    try {
      await ensureRoles();
      if ((role && role !== 'owner') || active === false) {
        const last = await lastActiveOwner(req.params.id);
        if (last) return res.status(400).json({ error: 'This is the last active owner — promote someone else to owner first.' });
      }
      // Bump token_version when a PERMISSION-affecting field changes (role,
      // location, active) so that user's existing 7-day tokens are revoked at
      // once. A name-only edit doesn't log them out.
      const { rows: prevRows } = await pool.query('SELECT role, location_id, active FROM users WHERE id=$1', [req.params.id]);
      if (!prevRows.length) return res.status(404).json({ error: 'User not found' });
      const prev = prevRows[0];
      const permChanged = (role != null && role !== prev.role)
        || ((location_id || null) !== (prev.location_id || null))
        || (active != null && active !== prev.active);
      const result = await pool.query(
        `UPDATE users SET name=$1, role=$2, location_id=$3, active=$4, updated_at=NOW()${permChanged ? ', token_version = token_version + 1' : ''}
           WHERE id=$5 RETURNING id, email, name, role, location_id, active`,
        [name, role, location_id || null, active, req.params.id]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
      if (permChanged) invalidateUserCache(req.params.id);
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete a user outright. Owner-only, two hard guards: no self-delete, and
  // never the last active owner.
  router.delete('/:id', authenticateToken, requireOwner, async (req, res) => {
    try {
      if (String(req.user.id) === String(req.params.id)) return res.status(400).json({ error: "You can't delete your own account." });
      const last = await lastActiveOwner(req.params.id);
      if (last === null) return res.status(404).json({ error: 'User not found' });
      if (last) return res.status(400).json({ error: 'This is the last active owner — promote someone else to owner first.' });
      await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
      invalidateUserCache(req.params.id);   // kill their sessions immediately
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:id/reset-password', authenticateToken, requireOwner, async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ error: 'newPassword required' });
    try {
      const hash = await bcrypt.hash(newPassword, 12);
      // Bump token_version so a password reset also logs out any existing sessions
      // (the whole point of resetting a possibly-compromised password).
      await pool.query('UPDATE users SET password_hash=$1, token_version = token_version + 1, updated_at=NOW() WHERE id=$2', [hash, req.params.id]);
      invalidateUserCache(req.params.id);
      res.json({ message: 'Password reset' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
