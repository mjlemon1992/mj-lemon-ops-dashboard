# MJ Lemon Ops Dashboard

Multi-location automotive operations dashboard for MJ Lemon Capital Inc. (Mister Transmission / Parkland Transmission — Red Deer + Kelowna). Pulls live shop data from Shopmonkey, QuickBooks, Marchex, and Google, computes the metrics that actually run the business, and surfaces them in one place. Installed as a PWA, deployed on Railway.

## Stack

- **Server:** Node/Express (`server/`), PostgreSQL.
- **Client:** Create React App (`client/`), single-page app, dark theme, Inter + Archivo.
- **Hosting:** Railway, auto-deploys from `main`. In production the server serves the built client (`client/build`).
- **Auth:** JWT (HS256) in `localStorage` (`ops_token`), sent as `Authorization: Bearer`. Roles: `owner`, `partner`, `manager`.

## Architecture

```
Shopmonkey ─┐
QuickBooks ─┤   server/routes/*  ──►  Postgres (metrics_cache, tech_efficiency, …)
Marchex    ─┤   (Express API)           ▲
Google     ─┘        │                  │
                     ▼                  │
              client/ (React PWA)  ◄────┘  reads /api/*
```

- **Shopmonkey → metrics.** `server/routes/shopmonkeySync.js` pulls orders and computes revenue, car count, margins, efficiency, alerts, and committed WIP into `metrics_cache` / `tech_efficiency`. Triggered by the in-app "Refresh now" button, a scheduled self-sync (`server/scheduler.js`, needs `SYNC_SECRET`), or an external scheduler.
- **QuickBooks (finance) is a read-only proxy.** `server/routes/finance.js` calls a separate Parkland QBO connector service server-to-server with `QBO_API_TOKEN`; the dashboard stores no QBO OAuth credentials and never exposes the token to the browser.
- **Marketing.** Marchex call-tracking PDFs are ingested via the Anthropic API; Google reviews and a Drive photo library feed the Marketing tab; posters/captions are AI-generated and held for approval (nothing posts automatically).
- **Shop-floor display.** Public, PIN-gated board at `/display/:locationId` for a TV in the bay (no login).

## Multi-location model

One global location switcher in the sidebar drives every tab: pick a shop to scope all data to it, or "All locations" for the group rollup (aggregate KPIs on Home/Alerts, per-shop stacked detail elsewhere). Managers are locked to their own location.

Each location's integrations are configured **per row in the `locations` table**, not via env: `shopmonkey_location_id`, `qbo_slug`, `google_place_id`, `google_drive_folder_id`, `display_pin`, plus targets. A location with an integration left blank shows "awaiting sync / not connected" — it never inherits another shop's data (Shopmonkey metrics, technician roster, and QuickBooks books are all isolated per location).

## Pages

Home (group/scoped overview), Scorecard (weekly CEO read: QBO books + Shopmonkey ops vs target), Performance, Technicians, Alerts, Reports, Finance, Marketing, Comebacks, Committed WIP, Locations, Targets, Users.

## Environment variables

Set in Railway. `.env.example` lists the core set.

**Core (required)**
| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Signs/verifies auth tokens. **Required — the server refuses to start without it** (no fallback). |
| `NODE_ENV` | `production` enables static client serving + DB SSL |
| `PORT` | Server port (default 3001) |
| `CLIENT_URL` | CORS allow-origin; set it to avoid the `*` fallback |

**Shopmonkey**
| Var | Purpose |
|---|---|
| `SHOPMONKEY_API_KEY` | Account API key for order/tech sync |
| `TECH_WAGE` | Tech hourly wage used in profit math |
| `SYNC_SECRET` | M2M key (`X-Sync-Key`) for scheduled `/api/sync/*` refreshes (falls back to a JWT; fails closed if unset) |

**QuickBooks (finance)**
| Var | Purpose |
|---|---|
| `QBO_CONNECTOR_URL` | Base URL of the Parkland QBO connector |
| `QBO_API_TOKEN` | Bearer token for the connector (server-side only) |
| `QBO_DEFAULT_SLUG` | Connector slug for the single/default shop |
| `QBO_DEFAULT_SLUG_LOCATION_ID` | Scopes `QBO_DEFAULT_SLUG` to one location so other shops don't inherit its books (set per-location `qbo_slug` for the rest) |

**Marketing / AI**
| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Call-PDF ingestion + poster/caption generation |
| `GOOGLE_MAPS_API_KEY` | Google Places reviews scorecard |
| `GOOGLE_SERVICE_ACCOUNT_JSON` / `GOOGLE_DRIVE_FOLDER_ID` | Read-only Drive photo library |
| `MARKETING_REVIEWS_DEMO` | Show sample review data before a real key/place_id is set |
| `MARKETING_PURGE_DAYS` | Retention for generated marketing drafts |
| `QUALIFIED_MIN_SECONDS` | Min call duration counted as a qualified PPC call |
| `SLACK_MARKETING_WEBHOOK_URL` | Optional Slack notifications |

**Weekly report email**
| Var | Purpose |
|---|---|
| `REPORT_TOKEN` | Bearer for the M2M `/report/weekly` endpoint (fails closed if unset) |
| `REPORT_EMAIL_TO`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Outbound email for the weekly report |

## Development & deploy

- No local clone lives in iCloud (corrupts `.git`); work from `~/Projects`. Builds run in the cloud.
- `cd client && npm run build` to verify the client compiles (`CI=1` treats warnings as errors).
- Push to `main` → Railway auto-deploys. After a deploy, hard-reload twice (⌘R) to clear the aggressive PWA service-worker cache before judging changes.

## Security notes

- `JWT_SECRET` is required and has no committed fallback (fails closed).
- The public shop-floor display PIN is rate-limited (per IP+location) with a constant-time compare; use an 8+ char PIN.
- Integration tokens (Shopmonkey, QBO, Anthropic, Google) are server-side only and never sent to the browser.
- Run `/cso` for the security posture report; reports save to `.gstack/security-reports/` (gitignored).
