# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Worker development
```bash
cd worker
npm install
npm run dev          # local dev server on http://localhost:8787
npm run typecheck    # TypeScript check (no build output)
npm run tail         # stream live production logs
```

To trigger the cron handler locally during `wrangler dev`:
```bash
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

### Deploy (always via Terraform)
```bash
cd terraform
terraform init       # first time only
terraform plan
terraform apply
```

`terraform apply` runs in this order: creates D1 → renders `worker/wrangler.jsonc` → applies migration → `wrangler deploy` → sets `WAN_API_TOKEN` secret → sets `BACKFILL_TOKEN` secret.

### D1 queries against production
```bash
cd worker
npx wrangler d1 execute tf-cf-wanstats-metrics --remote --command "SELECT ..."
```

### Backfill historical data
```bash
export WORKER_URL=https://tf-cf-wanstats.<subdomain>.workers.dev
export BACKFILL_TOKEN=<value from terraform.tfvars>
./scripts/backfill.sh 2026-06-01T00:00:00Z 2026-06-05T00:00:00Z
```

The script iterates hour-by-hour and calls `POST /api/backfill` for each window. Safe to re-run — `INSERT OR REPLACE` deduplicates.

### Add a DB migration
Create `migrations/0002_*.sql`. Add a new `null_resource` in `terraform/main.tf` for it with a trigger on `filesha256(...)`. Do not re-use the existing migrate resource — triggers only fire when their hash changes, so new migrations need new resources.

## Architecture

This is a **single Cloudflare Worker** (`worker/src/index.ts`) that handles two distinct roles:

**Cron role** (`scheduled` handler, `0 * * * *` — every hour):
- Fires a single GraphQL request to `api.cloudflare.com/client/v4/graphql` using the `magicTransitNetworkAnalyticsAdaptiveGroups` dataset
- Uses `ingress:` / `egress:` aliases to fetch both directions in one request
- Queries a 65-minute window (extra slack for API data latency) and upserts into D1 via `INSERT OR REPLACE`
- Composite PK `(tunnel_name, direction, ts)` deduplicates any overlap between runs

**HTTP role** (`fetch` handler):
- `GET /` — returns the full dashboard HTML as a string literal (no static assets, no build step)
- `GET /api/tunnels?range=` — all tunnels with per-tunnel p95 ingress and egress
- `GET /api/summary?range=&exclude=name1,name2` — aggregate p95 across all non-excluded tunnels
- `GET /api/metrics?tunnel=&range=` — per-tunnel time series + per-tunnel p95
- `POST /api/backfill?start=ISO&end=ISO` — upsert one time window; requires `X-Backfill-Token` header

**p95 calculation** — D1/SQLite has no `PERCENTILE()`. Both `P95_PER_TUNNEL_SQL` and `P95_AGGREGATE_SQL` use `ROW_NUMBER() OVER (ORDER BY val)` + `COUNT() OVER ()` window functions, selecting the row at `CEIL(0.95 * n)`. Aggregate p95 sums all non-excluded tunnels per 5-min interval first, then takes p95 of those sums (mirrors Cloudflare billing methodology).

**Tunnel exclusion** — per-tunnel exclude/include toggles in the dashboard. Excluded tunnels are passed as `?exclude=name1,name2` to `/api/summary`, where they are filtered via `tunnel_name NOT IN (SELECT value FROM json_each(?))`. Exclusions are persisted in `localStorage`.

**Dashboard HTML** — The HTML is a template literal in `getDashboardHTML()`. All embedded JavaScript uses ES5 syntax (no backticks, no arrow functions inside the HTML) to avoid conflicts with the outer TypeScript template literal.

**Date ranges:**
- `24h` — rolling 24-hour window from now (includes today's live data)
- `7d` — UTC midnight 7 days ago to now (7 complete calendar days)
- `30d` — UTC midnight 30 days ago to now (30 complete calendar days)

## Infrastructure

Terraform (provider `~> 5.0`) manages:
- `cloudflare_d1_database.metrics` — D1 database
- `local_file.wrangler_jsonc` — renders `worker/wrangler.jsonc` from `worker/wrangler.jsonc.tpl` (fills in `account_id` and `d1_database_id`)
- `null_resource.migrate` → `null_resource.deploy` → `null_resource.set_wan_api_token` → `null_resource.set_backfill_token` — ordered via `depends_on`

`worker/wrangler.jsonc` is **gitignored** — never edit it directly. Edit `worker/wrangler.jsonc.tpl` instead.

Re-deploy is triggered automatically by `terraform apply` when `filesha256("worker/src/index.ts")` or the rendered wrangler config content changes.

## Key constraints

- **D1 `db.batch()` limit is 100 statements.** `storeTunnelMetrics` chunks in `BATCH_SIZE = 100`. Keep this if adding write paths.
- **GraphQL `limit: 1000`.** If tunnel count exceeds ~500 (ingress + egress = 2 rows per tunnel per query), add pagination to `fetchAllTunnelMetrics`.
- **No `cloudflare_workers_secret` resource in provider v5.** Secrets are set via `wrangler secret put` in a `null_resource` provisioner.
- **Three secrets** are required: deploy token (`Workers Scripts + D1 + Account Settings: Edit`), runtime token (`Account Analytics: Read`, stored as `WAN_API_TOKEN`), and backfill token (arbitrary secret, stored as `BACKFILL_TOKEN`). Generate the backfill token with `openssl rand -hex 32`.

## GraphQL dataset history

**`magicTransitTunnelTrafficAdaptiveGroups` was investigated and abandoned.**
It returns real bit-rate data but `tunnelName` is always `""` for this account — a Cloudflare-side data pipeline issue. Do not re-investigate or revert to this dataset.

**`magicTransitNetworkAnalyticsAdaptiveGroups` is the working dataset.**
Returns named tunnels with separate `ingressTunnelName` and `egressTunnelName` dimension fields. A single request with `ingress:` / `egress:` aliases fetches both directions. Rows with blank or `"device_id"` tunnel names are excluded via `_notin` filters. There is no tunnel type field in the schema — WARP devices appear as regular tunnels and must be excluded manually via the dashboard UI.

**Datasets confirmed NOT applicable to this account:**
- `mconnTelemetrySnapshotNetdevsAdaptiveGroups` — Magic WAN Connector (hardware appliance); no data
- `magicWANConnectorMetricsAdaptiveGroups` — deprecated Connector metrics; not applicable
