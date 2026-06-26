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
    for (const path of [`/api/sync/${loc.id}/refresh`, `/api/sync/${loc.id}/refresh-tech`]) {
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
}

module.exports = { startScheduler };
