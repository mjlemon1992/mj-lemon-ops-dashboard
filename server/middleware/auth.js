const jwt = require('jsonwebtoken');

// Fail closed: never fall back to a committed secret. If JWT_SECRET is missing,
// the app must refuse to start rather than silently sign tokens with a known
// string (which would let anyone forge an owner token).
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');

// ADVISOR FIREWALL — enforced at the auth choke point, not per-route. The
// advisor role exists for exactly one job (the re-order board), and several
// older routes are authenticateToken-only with no role list; an allow-list
// here means a new or forgotten route can never leak revenue/profit/payroll
// to an advisor. Everything not matched 403s regardless of the route's guard.
const ADVISOR_ALLOW = [
  /^\/api\/auth\//,                        // login/me/change-password
  /^\/api\/locations\/?$/,                 // scoped list (writes are owner-gated)
  /^\/api\/clock\/[^/]+\/reorders$/,       // their board
  /^\/api\/clock\/reorder\/[^/]+$/,        // mark ordered / received
];

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    req.user = user;
    if (user.role === 'advisor') {
      const path = (req.originalUrl || '').split('?')[0];
      if (!ADVISOR_ALLOW.some((rx) => rx.test(path))) {
        return res.status(403).json({ error: 'Not available to the advisor role' });
      }
    }
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

// Machine-to-machine auth: a valid X-Sync-Key header matching SYNC_SECRET
// stands in for a JWT (same pattern as the Shopmonkey refresh routes). The
// sync-key caller acts as the owner. Fails closed: if SYNC_SECRET is unset,
// the key path is disabled and JWT is required.
function syncAuth(req, res, next) {
  const secret = process.env.SYNC_SECRET;
  const provided = req.get('X-Sync-Key');
  if (secret && provided && provided === secret) {
    req.user = { role: 'owner', via: 'sync-key' };
    return next();
  }
  return authenticateToken(req, res, next);
}

function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  next();
}

function requireOwnerOrPartner(req, res, next) {
  if (!['owner', 'partner'].includes(req.user.role)) return res.status(403).json({ error: 'Owner or Partner access required' });
  next();
}

// Role-list gate for routes managers may also use (location-scoped).
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: `${roles.join('/')} access required` });
    next();
  };
}

// Location scoping: owner/partner see every location; a manager or advisor only
// their own. Any such route that touches a locationId MUST check this first.
// (An advisor's ROUTE access is far narrower than a manager's — this only
// answers "which location", the requireRole allow-lists answer "which routes".)
function canAccessLocation(user, locationId) {
  if (!user) return false;
  if (['owner', 'partner'].includes(user.role)) return true;
  return ['manager', 'advisor'].includes(user.role) && !!user.location_id && user.location_id === locationId;
}

module.exports = { authenticateToken, syncAuth, requireOwner, requireOwnerOrPartner, requireRole, canAccessLocation, JWT_SECRET };
