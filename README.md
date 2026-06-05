# tf-cf-wanstats

Cloudflare WAN utilization analytics dashboard. A single Cloudflare Worker polls the Cloudflare GraphQL Analytics API every hour, stores per-tunnel ingress and egress bit rates in D1, and serves a dashboard with per-tunnel time-series charts and an aggregate p95 summary view.

## Architecture

```
Cron (0 * * * * — every hour)
  └─▶ Cloudflare GraphQL API (magicTransitNetworkAnalyticsAdaptiveGroups)
        single request, ingress + egress aliases, 65-min window
  └─▶ D1 (INSERT OR REPLACE, deduplicated by tunnel/direction/timestamp)

HTTP (workers.dev)
  GET /                               → Dashboard HTML (Chart.js, inline)
  GET /api/tunnels?range=             → All tunnels with per-tunnel p95
  GET /api/summary?range=&exclude=    → Aggregate p95 (excluded tunnels omitted)
  GET /api/metrics?tunnel=&range=     → Time series + per-tunnel p95 for one tunnel
  POST /api/backfill?start=&end=      → Upsert one time window (requires X-Backfill-Token header)
```

The aggregate p95 mirrors Cloudflare's billing methodology: sum all non-excluded tunnel traffic at each 5-minute interval, then take the p95 of those sums.

## Prerequisites

- Node.js 18+
- [Terraform](https://developer.hashicorp.com/terraform/install) ≥ 1.5
- Cloudflare account with Cloudflare WAN (Magic WAN) configured and tunnels active

## API Tokens and Secrets Required

You need **two Cloudflare API tokens** and **one generated secret**:

**Cloudflare dashboard → Profile → API Tokens → Create Token → Custom Token**

### 1. Terraform deploy token (`cloudflare_api_token` in tfvars)

Used by Terraform and Wrangler to create the D1 database, deploy the worker, and set secrets.

| Permission | Level |
|-----------|-------|
| Workers Scripts | Edit |
| D1 | Edit |
| Account Settings | Read |

### 2. WAN analytics token (`wan_api_token` in tfvars)

Used by the worker **at runtime** to query the GraphQL Analytics API. Stored as a Worker secret (`WAN_API_TOKEN`) — never in code or config files.

| Permission | Level |
|-----------|-------|
| Account Analytics | Read |

### 3. Backfill token (`backfill_token` in tfvars)

Arbitrary secret that authenticates `POST /api/backfill` requests. Generate with:

```bash
openssl rand -hex 32
```

Stored as a Worker secret (`BACKFILL_TOKEN`).

## Setup

### 1. Clone and install dependencies

```bash
git clone https://github.com/robdanz/tf-cf-wanstats.git
cd tf-cf-wanstats/worker
npm install
```

### 2. Type-check the worker

```bash
npm run typecheck
```

Fix any TypeScript errors before deploying. This is a no-output build step — it compiles but produces no files. Wrangler bundles the TypeScript at deploy time.

### 3. Configure Terraform variables

```bash
cp ../terraform/terraform.tfvars.example ../terraform/terraform.tfvars
```

Edit `terraform/terraform.tfvars` and fill in all five values:

```hcl
cloudflare_account_id = "your-account-id"   # Workers & Pages → Overview → right sidebar
workers_subdomain     = "your-subdomain"     # Workers & Pages → Overview → "Your subdomain" in right sidebar
cloudflare_api_token  = "..."                # Terraform deploy token (see above)
wan_api_token         = "..."                # WAN analytics token (see above)
backfill_token        = "..."                # openssl rand -hex 32
```

### 4. Deploy with Terraform

```bash
cd ../terraform
terraform init   # first time only — downloads providers
terraform plan   # preview what will be created
terraform apply
```

Terraform runs the full deployment in order:
1. Create the D1 database `tf-cf-wanstats-metrics`
2. Render `worker/wrangler.jsonc` from the template (fills in account ID and D1 database ID)
3. Apply the D1 schema migration (`migrations/0001_initial.sql`)
4. Run `npm install && wrangler deploy` to bundle and deploy the worker
5. Set `WAN_API_TOKEN` and `BACKFILL_TOKEN` Worker secrets via `wrangler secret put`

The workers.dev URL is printed as `workers_dev_url` when apply completes.

### 5. Verify

After `terraform apply` completes:

- **Dashboard**: Open the URL printed by the `workers_dev_url` output.
- **Cron**: The worker polls every hour. Check D1 data after the first run:
  ```bash
  cd worker
  npx wrangler d1 execute tf-cf-wanstats-metrics --remote \
    --command "SELECT tunnel_name, direction, COUNT(*) AS rows FROM tunnel_metrics GROUP BY tunnel_name, direction"
  ```
- **Logs**: `cd worker && npm run tail`

### 6. Backfill historical data (optional)

```bash
export WORKER_URL=https://tf-cf-wanstats.<your-subdomain>.workers.dev
export BACKFILL_TOKEN=<value from terraform.tfvars>
./scripts/backfill.sh 2026-06-01T00:00:00Z 2026-06-05T00:00:00Z
```

The script iterates hour-by-hour over the specified range, printing progress as it goes. Safe to re-run — duplicate rows are silently ignored.

## Local development

```bash
cp .dev.vars.example .dev.vars
# Fill in WAN_API_TOKEN, ACCOUNT_ID, and BACKFILL_TOKEN in .dev.vars

cd worker
npm run dev   # starts wrangler dev on http://localhost:8787
```

To test the cron handler locally:
```bash
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

## Dashboard features

- **Per-tunnel p95 badges** on each card (ingress and egress)
- **Aggregate p95 summary** across all included tunnels (mirrors Cloudflare billing)
- **Exclude/Include toggle** on each tunnel card — WARP devices and other tunnels to omit can be excluded; exclusions persist in localStorage and are reflected in the aggregate p95 immediately
- **Time range selector**: 24h (rolling), 7d (last 7 complete calendar days), 30d (last 30 complete calendar days)
- **Search and sort** by tunnel name or p95 value
- **Paginated** at 20 tunnels per page

## Commands

| Command | Description |
|---------|-------------|
| `cd worker && npm run dev` | Local dev server (port 8787) |
| `cd terraform && terraform apply` | Deploy everything (DB, worker, secrets) |
| `cd worker && npm run tail` | Stream live Worker logs |
| `cd worker && npm run typecheck` | TypeScript type check |
| `./scripts/backfill.sh <start> <end>` | Backfill a historical date range |

## Protecting with Cloudflare Access

The workers.dev URL is publicly accessible by default. To restrict it:

1. In the Cloudflare dashboard, go to **Zero Trust → Access → Applications → Add an application**.
2. Choose **Self-hosted**.
3. Set the application domain to your `*.workers.dev` URL (e.g. `tf-cf-wanstats.<subdomain>.workers.dev`).
4. Configure a policy (e.g. allow your email domain or specific emails).
5. Save. The dashboard will now require authentication.

## Re-deploying after code changes

```bash
cd worker && npm run typecheck   # verify before deploying
cd ../terraform && terraform apply
```

Terraform detects changes via `filesha256` on `worker/src/index.ts` and re-runs `wrangler deploy` automatically.

## Data retention

D1 rows accumulate indefinitely. Consider adding a periodic cleanup after you have enough history:
```sql
DELETE FROM tunnel_metrics WHERE ts < datetime('now', '-90 days');
```

## Notes

- **`wrangler.jsonc` is generated** by Terraform from `wrangler.jsonc.tpl`. Do not edit `wrangler.jsonc` directly — it is gitignored and will be overwritten on `terraform apply`.
- **`AI-SETUP-INSTRUCTIONS.md`** is local only and gitignored.
