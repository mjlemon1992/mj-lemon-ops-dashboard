# Changelog — Alerts fix + Tech Display (2026-06-25)

Four changes shipped this session. Production deploys from `main` on Railway.
Production URL: https://mj-lemon-ops-dashboard-production.up.railway.app

---

## What started this
The RO numbers on the **Alerts** tab didn't match Shopmonkey. Root cause: the
whole Alerts feature was **hardcoded placeholder data** — never wired to live
data, with two RO numbers transposed and archived/completed jobs flagged as
"stale on site."

---

## 1. Live alerts — PR #1
`server/routes/shopmonkeySync.js` → `buildAlerts()`:
- **Stale** = open orders (uninvoiced **and** un-archived) past the location's
  `stale_threshold_days`. Completed/archived cars can't be flagged.
- **Margin** = orders invoiced this month with real per-RO parts margin below
  `parts_margin_target`.
- RO number always comes from the exact order → no transposition.
- `Alerts.js` / `Home.js` / `Layout.js` read live counts (removed `|| 5` and
  `useState(5)`); shared helper `client/src/utils/alerts.js`.

## 2. Service-worker fix — PR #2
`client/public/service-worker.js` was cache-first with a fixed cache name, so
installed PWAs never picked up deploys. Now **network-first for the HTML shell**
(cache `v2`). Future deploys self-update on a plain reload (⌘R).

## 3. Tech display board + revenue-vs-target — PR #3
- **Dashboard:** group revenue card + each location's Revenue MTD show the
  **target and gap** ("$X to go" / "$Y over").
- **Shop-floor display** at `/display/:locationId` — public, **PIN-gated**:
  - Revenue-vs-target bar with figures (done, to go, % of target, % of pace).
  - Tech leaderboard: hours **billed**, **sold**, **efficiency**.
  - Auto-refreshes every 2h; server self-schedules a 2h Shopmonkey re-sync
    (`server/scheduler.js`, requires `SYNC_SECRET`).
- **Efficiency = hours sold ÷ available hours**, available = weekly hours
  (40 default, per-tech override via `tech_weekly_hours`) **minus that
  province's statutory holidays** (`server/lib/workdays.js`, mirrors
  `client/src/utils/pace.js`).
- New columns on `locations`: `display_pin`, `weekly_hours`.

## 4. All-locations standings — PR #4
The display shows a **group standings** table: every active location ranked by
revenue-to-date (highest first), revenue only, current shop highlighted. Renders
when 2+ locations are active.

---

## Setup / operations
- **Per location:** Locations → Edit → *Shop-floor display* → set a Display PIN
  (+ confirm on-clock hours/tech). The page then shows the display URL to open
  on the TV.
- **`SYNC_SECRET`** must be set in Railway for the 2h auto-sync (same key
  Make.com uses). Unset → auto-sync disabled, board still reads cached data.
- **Targets** are per-location (Targets page); each display bar uses its own.

## Things to watch
- Statutory holidays are hardcoded for **2026 (AB + BC)** in
  `client/src/utils/pace.js` and `server/lib/workdays.js` — update yearly.
- Efficiency is on a scheduled-hours basis (no QBO Time / clocked hours). Tune
  per-tech weekly hours on the Technicians page if the baseline is off.
- Minor: the display API returns a raw DB error for a malformed location ID
  instead of a clean 404 (harmless).
