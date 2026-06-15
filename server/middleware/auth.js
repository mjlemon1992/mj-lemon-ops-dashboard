const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'mj-lemon-ops-secret-change-in-production';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    req.user = user;
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  next();
}

function requireOwnerOrPartner(req, res, next) {
  if (!['owner', 'partner'].includes(req.user.role)) return res.status(403).json({ error: 'Owner or Partner access required' });
  next();
}

module.exports = { authenticateToken, requireOwner, requireOwnerOrPartner, JWT_SECRET };
