# 2026-07-02 — CoS agent unblocked, tech visibility fixed, display becomes a notice board

Eight PRs (#97–#104), all deployed to production on Railway the same day.

## 1. Chief-of-Staff agent could not read the dashboard (#97)

The scheduled daily-brief agent auths with `X-Sync-Key`, but four GET routes it
depends on were JWT-only, so every morning run failed with `Access token
required` and fell back to a Gmail+calendar-only brief:

- `GET /api/cos/learnings` — the agent's memory of Jamie
- `GET /api/cos/brief/latest` — the observe step
- `GET /api/metrics/group/summary` and `GET /api/metrics/:loc/summary` — ops/alerts

**Fix:** the `syncAuth` helper (previously copy-pasted in four route files)
moved into `server/middleware/auth.js` and is used on those routes. Fails
closed: no `SYNC_SECRET` ⇒ JWT required, unchanged. Diagnostic clue for next
time: `GET /cos/feedback` already accepted the key — "Access token required"
from a *sibling* route means route wiring, not a rotated key.

## 2. Technicians tab was frozen; new techs never appeared (#98)

`refresh-tech` (the 2h scheduler) wrote `tech_efficiency` rows with
`period_type = NULL`, but the Technicians tab and the shop-floor display read
only `period_type = 'mtd'` rows. The auto-refresh had been writing rows nobody
could see; the tab only moved when someone pressed the manual recompute button.
This is why new tech **Jared Olsen** was invisible.

**Fix:** refresh-tech writes `period_type='mtd'` (sweeping legacy NULL rows for
the same date) and fills `hours_worked`/`efficiency` the same way
`recompute-from-weekly` does (working days elapsed × 8, holiday+province aware
via `lib/workdays`). The tab now stays current on its own; a new tech appears
within ~2h of their first labour line on an invoiced RO.

**The human half:** Jared clocked real time in June but had only **0.25
assigned labour hours** all month — labour lines weren't being assigned to him
at write-up. No report (Shopmonkey's included) can see a tech who isn't on the
labour lines. Process note drafted for the team.

## 3. hoursSync computed account-wide, not per-location (#99)

`fetchInvoicedOrdersBetween` returns account-wide orders; the four hoursSync
consumers (mtd recompute, YTD job, import, sold-probe) never filtered by
`shopmonkey_location_id` — invisible with one connected shop, wrong the day
Hwy 97 joins the account. New `ordersForLocation()` guard mirrors refresh-tech:
unconnected location ⇒ nothing (never inherit another shop's orders).

## 4. "Tech 8c03af" placeholder names (#101)

`hoursSync.fetchTechNames` only knew names from snapshot history, so a tech's
first-ever snapshot row got an id-slice placeholder — Jared's YTD row read
"Tech 8c03af" on the display board. Live Shopmonkey `/v3/user` names now
overlay history names. Re-running the YTD recompute rewrote the stored rows.

## 5. Shop-floor display: notice board + period cycling (#100, #101, #102, #103, #104)

The PIN-gated `/display/:locationId` board is now a communication channel:

- **Notices** — `shop_notices` table + `/api/notices` CRUD. Owner/partner post
  from the new **Shop Notices** page; the CoS agent can post via `X-Sync-Key`
  ("tell the shop…"). Kinds: ℹ notice / 🎉 shout-out / ⚠ safety / 🖼 poster.
  Per-location or all boards, priority order, optional expiry.
- **Poster upload** — file picker on Shop Notices; raw image body to
  `POST /api/notices/:id/image` (Postgres bytea, 15 MB, JPEG/PNG/WebP/GIF —
  same pattern as marketing intake). Board inlines stored images as data URIs.
  Image-only posts allowed via `pending_image` flag (#102); a failed upload
  deletes the empty notice rather than leaving it live.
- **Page flip, not stacking (#103)** — a full-size poster buried the numbers,
  so posters take over the FULL screen on a cycle: board page 40 s → each
  poster 15 s → back. Text notices stay as a slim rotating banner (10 s) above
  the numbers.
- **MTD ↔ YTD tech cycling** — server sends `techs_ytd` alongside the mtd
  list; the tech panel fades between THIS MONTH and YEAR TO DATE, 15 s per
  side (#104).
- **Refresh 2 h → 5 min** — the display endpoint is DB-only reads.

All display timings are constants at the top of `client/src/pages/Display.js`:
`REFRESH_MS`, `PERIOD_FLIP_MS`, `NOTICE_FLIP_MS`, `BOARD_MS`, `POSTER_MS`.

## Operational notes

- The local CoS key file (`~/.claude/cos-sync-secret`) was never wrong — see #1.
- Hwy 97 sections stay empty by design until the acquisition closes and it gets
  its own Shopmonkey connection (`shopmonkey_location_id`).
- Known cosmetic nit (unfixed): the Technicians page summary cards are
  hard-labelled "MTD" but follow the selected period toggle.
