// Web Push notifications — the answer to "the ⏳ pill is silent until you
// look". Users enable notifications per device (🔔 in the topbar); events
// (new re-order, holiday request, punch change, answered clock question)
// push to the right roles' phones/desktops even with the app closed.
// Fails soft everywhere: no VAPID keys → no-op; dead subscriptions pruned.
const webpush = require('web-push');

const configured = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (configured) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:ops@mjlemon.local',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

let _init;
function ensurePushTable(pool) {
  if (_init) return _init;
  _init = pool.query(`CREATE TABLE IF NOT EXISTS push_subscription (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    last_used TIMESTAMPTZ
  )`).catch((e) => { _init = null; throw e; });
  return _init;
}

// Send to every subscribed device of every ACTIVE user matching the role
// list — location-scoped roles (manager/advisor) only when their location
// matches. Fire-and-forget: callers never await delivery.
async function notifyRoles(pool, { roles, locationId, title, body, path, tag }) {
  if (!configured) return;
  try {
    await ensurePushTable(pool);
    const { rows } = await pool.query(
      `SELECT s.id, s.endpoint, s.p256dh, s.auth
         FROM push_subscription s JOIN users u ON u.id = s.user_id
        WHERE u.active = true AND u.role = ANY($1)
          AND (u.role IN ('owner','partner') OR u.location_id = $2)`,
      [roles, locationId]);
    if (!rows.length) return;
    const payload = JSON.stringify({ title, body, path: path || '/', tag: tag || 'ops' });
    await Promise.allSettled(rows.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        pool.query('UPDATE push_subscription SET last_used = now() WHERE id = $1', [s.id]).catch(() => {});
      } catch (e) {
        // 404/410 = subscription expired or revoked — prune it.
        if (e.statusCode === 404 || e.statusCode === 410) {
          pool.query('DELETE FROM push_subscription WHERE id = $1', [s.id]).catch(() => {});
        }
      }
    }));
  } catch (e) { console.error('notifyRoles failed:', e.message); }
}

module.exports = { ensurePushTable, notifyRoles, pushConfigured: () => configured };
