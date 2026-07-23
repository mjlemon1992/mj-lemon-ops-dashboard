// Self-scheduled refresh so the shop-floor display stays current without any
// external scheduler. Every 2 hours it re-syncs each active location from
// Shopmonkey by calling this same server's /refresh + /refresh-tech endpoints
// with the machine X-Sync-Key (so it reuses the exact, already-validated sync
// logic instead of duplicating it).
//
// Requires SYNC_SECRET to be set (same key Make.com uses). If it isn't, the
// auto-sync is disabled and logged — the display still works off whatever the
// last manual / Make refresh produced.

const TWO_HOURS = 2 * 60 * 60 * 1000;
const START_DELAY = 60 * 1000; // let the server settle before the first run

async function runOnce(pool, baseUrl, secret) {
  let locs;
  try {
    const r = await pool.query('SELECT id, name FROM locations WHERE active = true');
    locs = r.rows;
  } catch (e) {
    console.error('[scheduler] could not load locations:', e.message);
    return;
  }
  for (const loc of locs) {
    // review-requests: no-ops in seconds unless the location's flag is on AND
    // the local-daytime send window is open (the route gates both).
    for (const path of [`/api/sync/${loc.id}/refresh`, `/api/sync/${loc.id}/refresh-tech`, `/api/marketing/review-requests/${loc.id}/run`]) {
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sync-Key': secret }
        });
        if (!res.ok) {
          const txt = await res.text();
          console.error(`[scheduler] ${path} -> ${res.status}: ${txt.slice(0, 160)}`);
        }
      } catch (e) {
        console.error(`[scheduler] ${path} failed:`, e.message);
      }
    }
  }
  console.log(`[scheduler] 2h refresh complete for ${locs.length} location(s) at ${new Date().toISOString()}`);
}

function startScheduler(pool) {
  const secret = process.env.SYNC_SECRET;
  if (!secret) {
    console.log('[scheduler] SYNC_SECRET not set — 2h auto-refresh disabled. Set SYNC_SECRET to enable.');
    return;
  }
  const port = process.env.PORT || 3001;
  const baseUrl = `http://127.0.0.1:${port}`;
  let running = false;
  const tick = async () => {
    if (running) return; // never overlap a long sync
    running = true;
    try { await runOnce(pool, baseUrl, secret); }
    catch (e) { console.error('[scheduler] tick error:', e.message); }
    finally { running = false; }
  };
  setTimeout(tick, START_DELAY);
  setInterval(tick, TWO_HOURS);
  console.log('[scheduler] 2h auto-refresh enabled.');

  // Owner-authored Chief of Staff automations: every minute, fire any enabled
  // automation whose Mountain-time slot has arrived and that hasn't run today.
  // The endpoint does the work + stamps last_run_date (so this won't double-fire).
  let autoRunning = false;
  const autoTick = async () => {
    if (autoRunning) return;
    autoRunning = true;
    try { await runAutomations(pool, baseUrl, secret); }
    catch (e) { console.error('[scheduler] automation tick:', e.message); }
    finally { autoRunning = false; }
  };
  setInterval(autoTick, AUTOMATION_INTERVAL);
  console.log('[scheduler] CoS automation tick enabled (60s).');
}

const AUTOMATION_INTERVAL = 60 * 1000;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function runAutomations(pool, baseUrl, secret) {
  let rows;
  try {
    const r = await pool.query('SELECT id, time_local, frequency, weekday, last_run_date FROM cos_automations WHERE enabled = true');
    rows = r.rows;
  } catch (e) {
    return; // cos_automations not created yet (cos route runs ensureTables on first hit)
  }
  if (!rows.length) return;

  // Current time in Mountain (handles DST via Intl).
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Edmonton', hour12: false,
      weekday: 'short', hour: '2-digit', minute: '2-digit',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  const curMin = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  const todayStr = `${parts.year}-${parts.month}-${parts.day}`;
  const dow = DOW.indexOf(parts.weekday);

  for (const a of rows) {
    const [h, m] = String(a.time_local || '07:00').split(':').map(n => parseInt(n, 10));
    if (curMin < (h * 60 + m)) continue;                          // not time yet today
    if (a.frequency === 'weekly' && a.weekday != null && a.weekday !== dow) continue;
    const lastRun = a.last_run_date ? new Date(a.last_run_date).toISOString().slice(0, 10) : null;
    if (lastRun === todayStr) continue;                            // already ran today
    try {
      const res = await fetch(`${baseUrl}/api/cos/run-automation/${a.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sync-Key': secret }
      });
      if (!res.ok) console.error(`[scheduler] automation ${a.id} -> ${res.status}`);
    } catch (e) {
      console.error(`[scheduler] automation ${a.id} failed:`, e.message);
    }
  }
}

module.exports = { startScheduler };
