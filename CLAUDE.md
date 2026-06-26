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

`terraform apply` runs in this order: creates D1 → creates R2 bucket → renders `worker/wrangler.jsonc` → applies migration → `wrangler deploy` → sets `WAN_API_TOKEN` secret → sets `BACKFILL_TOKEN` secret.

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

The script iterates hour-by-hour and calls `POST /api/backfill` for each window. Safe to re-run — `INSERT OR REPLACE` deduplicates. Backfill also writes raw CSVs to R2.

### Add a DB migration
Create `migrations/0002_*.sql`. Add a new `null_resource` in `terraform/main.tf` for it with a trigger on `filesha256(...)`. Do not re-use the existing migrate resource — triggers only fire when their hash changes, so new migrations need new resources.

## Architecture

This is a **single Cloudflare Worker** with source split across multiple files:

| File | Role |
|------|------|
| `worker/src/index.ts` | Entry point — registers `fetch` and `scheduled` handlers |
| `worker/src/types.ts` | Shared TypeScript types and interfaces |
| `worker/src/graphql.ts` | GraphQL queries against Cloudflare Analytics API |
| `worker/src/d1.ts` | D1 read/write: raw metrics, hourly rollups, daily rollups |
| `worker/src/r2.ts` | R2 read/write: raw CSV archive |
| `worker/src/cron.ts` | Hourly scheduled handler logic |
| `worker/src/api.ts` | HTTP API route handlers |
| `worker/src/dashboard.ts` | Dashboard HTML generation |
| `worker/src/utils.ts` | Shared utility functions |

**Dual storage:** D1 holds structured data at three granularities; R2 holds raw 5-min CSVs for billing-grade computation and export.

**Cron role** (`scheduled` handler, `0 * * * *` — every hour):
- Uses time-sliced GraphQL fetching (`GRAPHQL_LIMIT = 3000` per 5-min bucket) against `magicTransitNetworkAnalyticsAdaptiveGroups` — handles 2000+ tunnels without hitting API limits
- Uses `ingress:` / `egress:` aliases to fetch both directions per slice
- Queries a 65-minute window (extra slack for API data latency)
- Dual-writes each run: raw rows → D1 `tunnel_metrics` (via `INSERT OR REPLACE`) + raw CSV → R2 (`raw/YYYY-MM-DD/HH.csv`)
- After raw write: triggers hourly rollup → D1 `tunnel_metrics_hourly`
- At midnight UTC: triggers daily rollup → D1 `tunnel_metrics_daily`, purges D1 raw rows older than 7 days, purges D1 hourly rows older than 60 days, purges D1 daily rows older than 180 days, purges R2 objects older than 6 months
- Capacity warning logged when tunnel count exceeds 2500

**HTTP role** (`fetch` handler):
- `GET /` — returns the full dashboard HTML as a string literal (no static assets, no build step)
- `GET /api/tunnels?range=&page=&pageSize=&sort=&dir=&search=` — server-side paginated tunnel list with per-tunnel p95 ingress and egress
- `GET /api/summary?range=&exclude=name1,name2` — aggregate p95 across all non-excluded tunnels (rollup-aware)
- `GET /api/metrics?tunnels=A,B,C&range=` — batch time series + per-tunnel p95 for multiple tunnels (rollup-aware)
- `GET /api/billing` — billing-grade p95 for current and previous month (computed from raw R2 data)
- `GET /api/billing/tunnels?period=&page=&sort=` — per-tunnel billing p95, paginated
- `GET /api/export?start=&end=&tunnel=` — CSV export of raw data from R2
- `POST /api/backfill?start=ISO&end=ISO` — upsert one time window with dual-write (D1+R2); requires `X-Backfill-Token` header

**p95 calculation** — D1/SQLite has no `PERCENTILE()`. Both `P95_PER_TUNNEL_SQL` and `P95_AGGREGATE_SQL` use `ROW_NUMBER() OVER (ORDER BY val)` + `COUNT() OVER ()` window functions, selecting the row at `CEIL(0.95 * n)`. Aggregate p95 sums all non-excluded tunnels per 5-min interval first, then takes p95 of those sums (mirrors Cloudflare billing methodology). For rollup-based ranges, chart p95 values are estimates computed from pre-aggregated data; these are labeled in the dashboard.

**Tunnel exclusion** — per-tunnel exclude/include toggles in the dashboard. Excluded tunnels are passed as `?exclude=name1,name2` to `/api/summary`, where they are filtered via `tunnel_name NOT IN (SELECT value FROM json_each(?))`. Exclusions are persisted in `localStorage`.

**Dashboard HTML** — The HTML is a template literal in `getDashboardHTML()` in `dashboard.ts`. All embedded JavaScript uses ES5 syntax (no backticks, no arrow functions inside the HTML) to avoid conflicts with the outer TypeScript template literal.

**Date ranges:**
- `24h` — rolling 24-hour window from now (includes today's live data)
- `7d` — UTC midnight 7 days ago to now (7 complete calendar days)
- `30d` — UTC midnight 30 days ago to now (30 complete calendar days)
- `90d` — UTC midnight 90 days ago to now
- `180d` — UTC midnight 180 days ago to now
- `custom` — user-specified start/end timestamps

**Data sources by range:**

| Range | Table used | Notes |
|-------|-----------|-------|
| 24h | `tunnel_metrics` (raw 5-min) | Full resolution |
| 7d, 30d | `tunnel_metrics_hourly` | Hourly rollups; chart p95 is an estimate |
| 90d, 180d | `tunnel_metrics_daily` | Daily rollups; chart p95 is an estimate |

Billing p95 (`/api/billing`) always reads raw CSVs from R2 for accuracy.

## R2 storage

- **Bucket:** `tf-cf-wanstats-raw-metrics`
- **Key format:** `raw/YYYY-MM-DD/HH.csv` (one object per hour, UTC)
- **Retention:** 6 months; objects older than 6 months are deleted by the daily midnight cron
- **Used for:** billing-grade p95 computation (`/api/billing`) and CSV export (`/api/export`)

## Data retention

| Layer | Table / Location | Retention |
|-------|-----------------|-----------|
| D1 raw | `tunnel_metrics` | 7 days |
| D1 hourly | `tunnel_metrics_hourly` | 60 days |
| D1 daily | `tunnel_metrics_daily` | 180 days |
| R2 raw | `raw/YYYY-MM-DD/HH.csv` | 6 months |

Retention is enforced by the daily cron at midnight UTC.

## Infrastructure

Terraform (provider `~> 5.0`) manages:
- `cloudflare_d1_database.metrics` — D1 database
- `cloudflare_r2_bucket.raw_metrics` — R2 bucket (`tf-cf-wanstats-raw-metrics`)
- `local_file.wrangler_jsonc` — renders `worker/wrangler.jsonc` from `worker/wrangler.jsonc.tpl` (fills in `account_id`, `d1_database_id`, and `r2_bucket_name`)
- `null_resource.migrate` → `null_resource.deploy` → `null_resource.set_wan_api_token` → `null_resource.set_backfill_token` — ordered via `depends_on`

`worker/wrangler.jsonc` is **gitignored** — never edit it directly. Edit `worker/wrangler.jsonc.tpl` instead.

Re-deploy is triggered automatically by `terraform apply` when any file under `worker/src/` or the rendered wrangler config content changes.

**Note:** The Terraform deploy API token requires an additional permission scope: `Account > R2 Storage > Edit` (for R2 bucket creation and worker data writes).

## Key constraints

- **D1 `db.batch()` limit is 100 statements.** `storeTunnelMetrics` chunks in `BATCH_SIZE = 100`. Keep this if adding write paths.
- **GraphQL time-sliced fetching with `GRAPHQL_LIMIT = 3000` per 5-min bucket.** Each cron run issues one GraphQL request per 5-min interval in the fetch window. A capacity warning is logged when a single slice returns 2500+ tunnels — approaching the per-slice limit.
- **No `cloudflare_workers_secret` resource in provider v5.** Secrets are set via `wrangler secret put` in a `null_resource` provisioner.
- **Three secrets** are required: deploy token (`Workers Scripts + D1 + Account Settings + R2 Storage: Edit`), runtime token (`Account Analytics: Read`, stored as `WAN_API_TOKEN`), and backfill token (arbitrary secret, stored as `BACKFILL_TOKEN`). Generate the backfill token with `openssl rand -hex 32`.

## GraphQL dataset history

**`magicTransitTunnelTrafficAdaptiveGroups` was investigated and abandoned.**
It returns real bit-rate data but `tunnelName` is always `""` for this account — a Cloudflare-side data pipeline issue. Do not re-investigate or revert to this dataset.

**`magicTransitNetworkAnalyticsAdaptiveGroups` is the working dataset.**
Returns named tunnels with separate `ingressTunnelName` and `egressTunnelName` dimension fields. A single request with `ingress:` / `egress:` aliases fetches both directions. Rows with blank or `"device_id"` tunnel names are excluded via `_notin` filters. There is no tunnel type field in the schema — WARP devices appear as regular tunnels and must be excluded manually via the dashboard UI.

**Datasets confirmed NOT applicable to this account:**
- `mconnTelemetrySnapshotNetdevsAdaptiveGroups` — Magic WAN Connector (hardware appliance); no data
- `magicWANConnectorMetricsAdaptiveGroups` — deprecated Connector metrics; not applicable
