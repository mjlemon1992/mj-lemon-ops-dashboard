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
  // Home decks + Alerts + Comebacks + Notices (2026-07-20). Money endpoints
  // stay out; metrics summary and technicians STRIP money fields server-side
  // for advisor tokens before responding.
  /^\/api\/metrics\/(?!group\/)[^/]+\/summary$/,  // per-location only (NOT /group/summary — that's all-locations revenue); filtered to alerts/car count/hours
  /^\/api\/technicians\/[^/]+$/,           // filtered: no per-tech revenue
  /^\/api\/clock\/[^/]+\/status$/,         // crew-now deck
  /^\/api\/clock\/[^/]+\/timeoff$/,        // two-weeks deck / who's off
  /^\/api\/meta\//,                        // holiday calendars
  /^\/api\/notices(\/|$)/,                 // shop notice board
  /^\/api\/sync\/[^/]+\/comebacks$/,       // comebacks list (read)
  /^\/api\/cos\/alerts\//,                 // alert ack/dismissed state
  // Hero band (2026-07-20): revenue-vs-target pace, same figures as the bay
  // display board. Targets + metrics responses are field-filtered for the role.
  /^\/api\/targets\/[^/]+\/\d{4}$/,        // filtered: revenue/cars/hours/efficiency targets only
  /^\/api\/clock\/[^/]+\/pay-periods$/,    // period dates for crew-paid hours
  /^\/api\/clock\/[^/]+\/entries$/,        // punch hours (no wages exist in the system)
  /^\/api\/attention$/,                    // ⏳ pill — route returns re-orders ONLY for advisors
  /^\/api\/push\//,                        // notification subscriptions (per-device)
];

// LIVE SESSION REVOCATION. A JWT lives 7 days, so without this a deactivated,
// deleted, demoted, relocated, or password-reset user would keep full old access
// until it expired. index.js wires the pool in via setAuthPool(); each request
// checks the user's current {active, token_version} against a 30s cache (so it's
// ~1 cheap query per user per 30s, not per request), and the mutating routes bust
// that user's cache for instant effect. Fails OPEN on a DB error — a transient
// query blip must never lock the whole shop out.
let _authPool = null;
function setAuthPool(p) { _authPool = p; }
const _userStateCache = new Map();   // userId -> { active, tv, at, missing }
const USER_STATE_TTL = 30000;
function invalidateUserCache(userId) { if (userId) _userStateCache.delete(String(userId)); }
async function userState(userId) {
  const key = String(userId);
  const c = _userStateCache.get(key);
  if (c && Date.now() - c.at < USER_STATE_TTL) return c;
  const { rows } = await _authPool.query('SELECT active, token_version FROM users WHERE id=$1', [userId]);
  const st = rows.length
    ? { active: rows[0].active !== false, tv: Number(rows[0].token_version) || 1, at: Date.now(), missing: false }
    : { active: false, tv: 0, at: Date.now(), missing: true };
  _userStateCache.set(key, st);
  return st;
}

async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  let user;
  try { user = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(403).json({ error: 'Invalid or expired token' }); }
  req.user = user;
  // Revocation gate. 401 (not 403) so the client clears the token and returns to
  // login. Grandfathers pre-upgrade tokens (no `tv` claim) via the active check —
  // a fired user is still killed instantly by active=false regardless of tv.
  if (user.id && _authPool) {
    try {
      const st = await userState(user.id);
      if (st.missing || !st.active) return res.status(401).json({ error: 'This account is no longer active — please sign in again.' });
      if (user.tv != null && Number(user.tv) !== st.tv) return res.status(401).json({ error: 'Your session was reset — please sign in again.' });
    } catch (e) { /* transient DB error: fail open, don't lock the shop out */ }
  }
  if (user.role === 'advisor') {
    const path = (req.originalUrl || '').split('?')[0];
    if (!ADVISOR_ALLOW.some((rx) => rx.test(path))) {
      return res.status(403).json({ error: 'Not available to the advisor role' });
    }
  }
  next();
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

module.exports = { authenticateToken, syncAuth, requireOwner, requireOwnerOrPartner, requireRole, canAccessLocation, setAuthPool, invalidateUserCache, JWT_SECRET };
