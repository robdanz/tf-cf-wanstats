# tf-cf-wanstats

> **Disclaimer:** This is not an official Cloudflare product or repository. It is an independent, community-built tool provided as-is, with no warranty of any kind, express or implied. By using this software you acknowledge that it is not supported, endorsed, or maintained by Cloudflare, Inc. Use at your own risk.
>
> This tool provisions and consumes Cloudflare services (Workers, D1, R2, and the GraphQL Analytics API) that may incur charges on your Cloudflare account. You are solely responsible for any costs incurred. Consult with your Cloudflare account team to understand the billing implications before deploying.

Cloudflare WAN utilization analytics dashboard. A single Cloudflare Worker polls the Cloudflare GraphQL Analytics API every hour, stores per-tunnel ingress and egress bit rates in D1, archives raw data to R2, and serves a dashboard with per-tunnel time-series charts, an aggregate p95 summary view, and billing-grade p95 reporting.

## Architecture

```
Cron (0 * * * * — every hour)
  └─▶ Cloudflare GraphQL API (magicTransitNetworkAnalyticsAdaptiveGroups)
        time-sliced per 5-min bucket, GRAPHQL_LIMIT=3000, ingress + egress aliases
  └─▶ D1 (INSERT OR REPLACE — tunnel_metrics, raw 5-min rows)
  └─▶ R2 (raw/YYYY-MM-DD/HH.csv — one object per hour)
  └─▶ D1 hourly rollup (tunnel_metrics_hourly)
  └─▶ [midnight UTC] D1 daily rollup + retention enforcement (D1 + R2)

HTTP (workers.dev)
  GET /                                          → Dashboard HTML (Chart.js, inline)
  GET /api/tunnels?range=&page=&pageSize=        → Paginated tunnel list with per-tunnel p95
              &sort=&dir=&search=
  GET /api/summary?range=&exclude=               → Aggregate p95 (excluded tunnels omitted, rollup-aware)
  GET /api/metrics?tunnels=A,B,C&range=          → Batch time series + per-tunnel p95 (rollup-aware)
  GET /api/billing                               → Billing-grade p95 (current + previous month, from R2)
  GET /api/billing/tunnels?period=&page=&sort=   → Per-tunnel billing p95, paginated
  GET /api/export?start=&end=&tunnel=            → CSV export of raw data from R2
  POST /api/backfill?start=&end=                 → Upsert one time window (D1+R2, requires X-Backfill-Token)
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

Used by Terraform and Wrangler to create the D1 database, R2 bucket, deploy the worker, and set secrets.

| Permission | Level |
|-----------|-------|
| Workers Scripts | Edit |
| D1 | Edit |
| Account Settings | Read |
| Account > R2 Storage | Edit |

> **R2 scope required:** The Cloudflare API token used for deployment must include `Account > R2 Storage > Edit` permission to create the R2 bucket and allow the worker to write data.

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
2. Create the R2 bucket `tf-cf-wanstats-raw-metrics`
3. Render `worker/wrangler.jsonc` from the template (fills in account ID, D1 database ID, and R2 bucket name)
4. Apply the D1 schema migration (`migrations/0001_initial.sql`)
5. Run `npm install && wrangler deploy` to bundle and deploy the worker
6. Set `WAN_API_TOKEN` and `BACKFILL_TOKEN` Worker secrets via `wrangler secret put`

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

The script iterates hour-by-hour over the specified range, printing progress as it goes. Safe to re-run — duplicate rows are silently ignored. Each backfill window also writes raw CSVs to R2.

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
- **Billing-grade p95** for current and previous month, computed from raw 5-min R2 data
- **Exclude/Include toggle** on each tunnel card — WARP devices and other tunnels to omit can be excluded; exclusions persist in localStorage and are reflected in the aggregate p95 immediately
- **6 time range options**: 24h (rolling), 7d, 30d, 90d, 180d (complete calendar periods), and custom start/end
- **Server-side pagination** for 2000+ tunnels — paginated at configurable page size, with search and sort
- **Search and sort** by tunnel name or p95 value
- **CSV export** of raw 5-min data from R2 for any time range and tunnel
- **R2 raw data archive**: 6 months of 5-min granularity data retained for auditing and billing verification

## Commands

| Command | Description |
|---------|-------------|
| `cd worker && npm run dev` | Local dev server (port 8787) |
| `cd terraform && terraform apply` | Deploy everything (DB, R2, worker, secrets) |
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

Terraform detects changes via `filesha256` on files under `worker/src/` and re-runs `wrangler deploy` automatically.

## Data retention

| Layer | Retention | Notes |
|-------|-----------|-------|
| D1 raw (`tunnel_metrics`) | 7 days | Full 5-min resolution |
| D1 hourly (`tunnel_metrics_hourly`) | 60 days | Pre-aggregated for 7d/30d ranges |
| D1 daily (`tunnel_metrics_daily`) | 180 days | Pre-aggregated for 90d/180d ranges |
| R2 raw CSVs | 6 months | Used for billing p95 and CSV export |

Retention is enforced automatically by the daily midnight UTC cron run.

## Statistical design: p95 calculation and data tiering

### How Cloudflare bills Magic WAN

Cloudflare computes utilization from **5-minute average bit rate samples**. Each sample is the average bits-per-second observed across a 5-minute window. Billing uses the **95th percentile (p95)** of these samples over a calendar month.

A 30-day month has `30 × 24 × 12 = 8,640` five-minute intervals. P95 means: sort all 8,640 values, discard the top 5% (the 432 highest), and your bill is based on the next value down. This allows for short traffic bursts without them dominating the bill.

### How this tool computes p95

D1/SQLite has no built-in `PERCENTILE()` function. We compute p95 using SQL window functions:

```sql
WITH ranked AS (
  SELECT bit_rate AS val,
         ROW_NUMBER() OVER (ORDER BY bit_rate) AS rn,
         COUNT(*) OVER () AS n
  FROM tunnel_metrics
  WHERE tunnel_name = ? AND direction = ? AND ts >= ?
)
SELECT val FROM ranked
WHERE rn = CAST(CEIL(0.95 * n) AS INTEGER)
LIMIT 1
```

This sorts all samples, then picks the value at position `⌈0.95 × n⌉`. For 8,640 samples, that's position 8,208 — exactly the 95th percentile.

**Aggregate p95** (across all tunnels) first sums all tunnel bit rates per 5-minute interval, then takes p95 of those per-interval sums. This mirrors Cloudflare's billing methodology: the bill is based on total bandwidth across all tunnels, not individual tunnel peaks.

### Why dashboard p95 and billing p95 are different numbers

The dashboard supports time ranges from 24 hours to 180 days. Keeping 180 days of raw 5-minute data in D1 for 2,000 tunnels would mean ~93 million rows — too many for D1 window functions to process within query time limits. So we use **pre-aggregated rollup tables** for longer ranges:

| Dashboard range | Data source | Granularity | p95 accuracy |
|----------------|-------------|-------------|-------------|
| 24 hours | `tunnel_metrics` | 5-minute samples | **Exact** — same raw data Cloudflare uses |
| 7 or 30 days | `tunnel_metrics_hourly` | Hourly averages | **Estimate** — see below |
| 90 or 180 days | `tunnel_metrics_daily` | Daily averages | **Rough estimate** — see below |
| Billing section | R2 raw CSVs | 5-minute samples | **Exact** — computed from raw archive |

**Why rollup-based p95 is an estimate, not exact:**

Averaging smooths out peaks. An hour with 12 five-minute samples (e.g., `[10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 80]`) has an average of `17.5` but a peak of `80`. When you take p95 of hourly averages, you're taking p95 of already-smoothed values — the spikes that p95 is designed to capture get hidden inside the averages.

**Concrete example:** Imagine a tunnel that's idle (1 Kbps) for 23 hours and 42 minutes per day, but bursts to 100 Mbps for 18 minutes (three 5-minute intervals with traffic, plus one partial). Over 30 days:
- **True p95 from raw 5-min data:** ~1 Kbps (the burst only accounts for 90 out of 8,640 intervals = ~1%, well within the 5% headroom)
- **P95 from hourly averages:** ~1 Kbps (burst is averaged into one hour at ~12.4 Mbps; but that's only 30 out of 720 hours = ~4.2%, still within the 5% discard range — so the result is similar in this case)

But change the pattern slightly — bursts scattered across many hours — and the rollup-based estimate diverges more from the true value. The general rule:

- **p95 of averages ≤ true p95** (averaging suppresses peaks — always understates)
- **p95 of maximums ≥ true p95** (picking the worst sample per period — always overstates)
- **p95 of p95s ≥ true p95** (taking p95 of already-elevated values — also overstates, and is not a valid statistical composition)

There is no algebraically correct way to compute the true p95 from pre-aggregated sub-period statistics. The only valid approach is to go back to the raw samples. This is why we archive raw 5-minute data in R2 for 6 months and compute billing p95 from that archive.

### Why we considered and rejected adding p95 to rollup tables

We evaluated storing a pre-computed p95 column alongside the average in rollup tables. For hourly rollups with 12 samples, `⌈0.95 × 12⌉ = 12` — the p95 equals the maximum, which is already stored as `max_bit_rate`. No additional value.

For daily rollups (288 samples), the p95 would be a meaningful value within that day. But composing a 30-day p95 from daily p95 values (taking the p95 of p95s) **overstates** the true value — you're selecting the 95th percentile of already-elevated values, biasing upward. This is the opposite error from p95-of-averages (which understates), but equally wrong.

Since neither composition is correct, and we already have the exact answer available from R2 raw data, adding a p95 column to rollups would introduce a third wrong number without improving accuracy. We chose not to add it.

### Tiered storage rationale

| Store | What | Why | Retention |
|-------|------|-----|-----------|
| D1 `tunnel_metrics` | Raw 5-min samples | Fast indexed queries for 24h dashboard | 7 days |
| D1 `tunnel_metrics_hourly` | Hourly avg/max/min | Fast queries for 7d/30d dashboard | 60 days |
| D1 `tunnel_metrics_daily` | Daily avg/max/min | Fast queries for 90d/180d dashboard | 180 days |
| R2 raw CSVs | Raw 5-min samples | Billing p95 computation, CSV export, audit trail | 6 months |

D1 and R2 overlap for the most recent 7 days (both hold raw data). This is intentional — D1 serves fast indexed SQL queries for the dashboard, while R2 provides the durable archive for billing validation and export. The dual-write cost is negligible.

### GraphQL data collection at scale

The Cloudflare GraphQL Analytics API returns one row per tunnel per 5-minute interval per direction. With 2,000 tunnels and a 65-minute fetch window (13 intervals), a single request would need `2,000 × 13 = 26,000` rows per direction — far exceeding the API's row limit.

We solve this with **time-sliced fetching**: one API call per 5-minute bucket, with `limit: 3000` per direction per call. At 2,000 tunnels, each call returns ~2,000 rows (well under 3,000). The 65-minute window requires 13 sequential API calls — trivial for an hourly cron job.

A capacity warning is logged when any single slice returns 2,500+ rows, signaling that the limit should be raised before data truncation occurs.

## Notes

- **`wrangler.jsonc` is generated** by Terraform from `wrangler.jsonc.tpl`. Do not edit `wrangler.jsonc` directly — it is gitignored and will be overwritten on `terraform apply`.
- **Chart p95 values for rollup-based ranges** (7d, 30d, 90d, 180d) are labeled as estimates in the dashboard with a persistent amber banner. Billing p95 values always use raw 5-min R2 data and are shown in a separate section.
