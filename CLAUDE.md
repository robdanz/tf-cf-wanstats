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
curl "http://localhost:8787/__scheduled?cron=*%2F5+*+*+*+*"
```

### Deploy (always via Terraform)
```bash
cd terraform
terraform init       # first time only
terraform plan
terraform apply
```

`terraform apply` runs in this order: creates D1 → renders `worker/wrangler.jsonc` → applies migration → `wrangler deploy` → sets `WAN_API_TOKEN` secret.

### D1 queries against production
```bash
cd worker
npx wrangler d1 execute tf-cf-wanstats-metrics --remote --command "SELECT ..."
```

### Add a DB migration
Create `migrations/0002_*.sql`. Add a new `null_resource` in `terraform/main.tf` for it with a trigger on `filesha256(...)`. Do not re-use the existing migrate resource — triggers only fire when their hash changes, so new migrations need new resources.

## Architecture

This is a **single Cloudflare Worker** (`worker/src/index.ts`) that handles two distinct roles:

**Cron role** (`scheduled` handler, `*/5 * * * *`):
- Fires two parallel GraphQL requests to `api.cloudflare.com/client/v4/graphql` — one for `direction: "ingress"`, one for `direction: "egress"` — using the `magicTransitTunnelTrafficAdaptiveGroups` dataset
- Queries a 10-minute window (to tolerate API data latency) and upserts results into D1 via `INSERT OR REPLACE`
- Composite PK `(tunnel_name, direction, ts)` deduplicates retries

**HTTP role** (`fetch` handler):
- `GET /` — returns the full dashboard HTML as a string literal (no static assets, no build step)
- `GET /api/tunnels` — distinct tunnel names from D1
- `GET /api/summary?range=` — aggregate p95: sums all tunnel bit_rates per 5-min interval, then p95 of those sums (matches Cloudflare billing methodology)
- `GET /api/metrics?tunnel=&range=` — per-tunnel time series + per-tunnel p95

**p95 calculation** — D1/SQLite has no `PERCENTILE()`. Both `P95_PER_TUNNEL_SQL` and `P95_AGGREGATE_SQL` use `ROW_NUMBER() OVER (ORDER BY val)` + `COUNT() OVER ()` window functions, selecting the row at `CEIL(0.95 * n)`.

**Dashboard HTML** — The HTML is a template literal in `getDashboardHTML()`. All embedded JavaScript uses ES5 syntax (no backticks, no arrow functions inside the HTML) to avoid conflicts with the outer TypeScript template literal.

## Infrastructure

Terraform (provider `~> 5.0`) manages:
- `cloudflare_d1_database.metrics` — D1 database
- `local_file.wrangler_jsonc` — renders `worker/wrangler.jsonc` from `worker/wrangler.jsonc.tpl` (fills in `account_id` and `d1_database_id`)
- `null_resource.migrate` → `null_resource.deploy` → `null_resource.set_wan_api_token` — ordered via `depends_on`

`worker/wrangler.jsonc` is **gitignored** — never edit it directly. Edit `worker/wrangler.jsonc.tpl` instead.

Re-deploy is triggered automatically by `terraform apply` when `filesha256("worker/src/index.ts")` or the rendered wrangler config content changes.

## Key constraints

- **D1 `db.batch()` limit is 100 statements.** `storeTunnelMetrics` chunks in `BATCH_SIZE = 100`. Keep this if adding write paths.
- **GraphQL `limit: 100`.** If tunnel count exceeds ~50 (ingress + egress = 2 rows per tunnel per query), add pagination to `fetchTunnelMetrics`.
- **No `cloudflare_workers_secret` resource in provider v5.** Secrets are set via `wrangler secret put` in a `null_resource` provisioner.
- **Two API tokens** are required (see `terraform/variables.tf` descriptions): deploy token (`Workers Scripts + D1 + Account Settings: Edit`) and runtime token (`Account Analytics: Read` only, stored as `WAN_API_TOKEN` Worker secret).

## GraphQL dataset history

**`magicTransitTunnelTrafficAdaptiveGroups` was investigated and abandoned.**
It returns real bit-rate data but `tunnelName` is always `""` for this account — a Cloudflare-side data pipeline issue. Do not re-investigate or revert to this dataset.

**`magicTransitNetworkAnalyticsAdaptiveGroups` is the working dataset.**
Returns named tunnels with separate `ingressTunnelName` and `egressTunnelName` dimension fields. A single request with `ingress:` / `egress:` aliases fetches both directions. Rows with blank or `"device_id"` tunnel names are excluded via `_notin` filters.

**Datasets confirmed NOT applicable to this account:**
- `mconnTelemetrySnapshotNetdevsAdaptiveGroups` — Magic WAN Connector (hardware appliance); no data
- `magicWANConnectorMetricsAdaptiveGroups` — deprecated Connector metrics; not applicable
