# tf-cf-wanstats

Cloudflare WAN utilization analytics dashboard. A single Cloudflare Worker polls the Cloudflare GraphQL Analytics API every 5 minutes, stores per-tunnel ingress and egress bit rates in D1, and serves a dashboard with per-tunnel time-series charts and an aggregate p95 summary view.

## Architecture

```
Cron (*/5 * * * *)
  └─▶ Cloudflare GraphQL API (magicTransitTunnelTrafficAdaptiveGroups)
        ingress + egress per tunnel
  └─▶ D1 (INSERT OR REPLACE, deduplicated by tunnel/direction/timestamp)

HTTP (workers.dev)
  GET /          → Dashboard HTML (Chart.js, inline)
  GET /api/tunnels   → Distinct tunnel names
  GET /api/metrics   → Time series + per-tunnel p95 for one tunnel
  GET /api/summary   → Aggregate p95 ingress and egress (all tunnels summed)
```

The aggregate p95 mirrors Cloudflare's billing methodology: sum all tunnel traffic at each 5-minute interval, then take the p95 of those sums.

## Prerequisites

- Node.js 18+
- [Terraform](https://developer.hashicorp.com/terraform/install) ≥ 1.5
- Cloudflare account with Cloudflare WAN (Magic WAN) configured and tunnels active

## API Tokens Required

You need **two Cloudflare API tokens**. Create both at:
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

## Setup

### 1. Clone and install

```bash
git clone git@github.com:robdanz/tf-cf-wanstats.git
cd tf-cf-wanstats/worker
npm install
```

### 2. Configure Terraform variables

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
```

Edit `terraform/terraform.tfvars` and fill in all three values:

```hcl
cloudflare_account_id = "your-account-id"   # Workers & Pages → Overview → right sidebar
cloudflare_api_token  = "..."                 # Terraform deploy token (see above)
wan_api_token         = "..."                 # WAN analytics token (see above)
```

### 3. Deploy

```bash
cd terraform
terraform init
terraform plan   # review: D1 database, migration, deploy, secret
terraform apply
```

Terraform will, in order:
1. Create the D1 database `tf-cf-wanstats-metrics`
2. Render `worker/wrangler.jsonc` from the template (filling in account ID and D1 database ID)
3. Run the D1 migration (`migrations/0001_initial.sql`)
4. Deploy the worker via `wrangler deploy`
5. Set the `WAN_API_TOKEN` Worker secret via `wrangler secret put`

### 4. Verify

After `terraform apply` completes:

- **Dashboard**: Open the URL printed by the `workers_dev_url` output.
- **Cron**: The worker polls every 5 minutes. Check the D1 data after the first interval:
  ```bash
  cd worker
  npx wrangler d1 execute tf-cf-wanstats-metrics --remote \
    --command "SELECT tunnel_name, direction, COUNT(*) AS rows FROM tunnel_metrics GROUP BY tunnel_name, direction"
  ```
- **Logs**: `cd worker && npm run tail`

## Local development

```bash
cp .dev.vars.example .dev.vars
# Fill in WAN_API_TOKEN and ACCOUNT_ID in .dev.vars

cd worker
npm run dev   # starts wrangler dev on http://localhost:8787
```

Note: The cron trigger is not automatically fired during `wrangler dev`. To test the cron handler locally, use:
```
curl "http://localhost:8787/__scheduled?cron=*%2F5+*+*+*+*"
```

## Commands

| Command | Description |
|---------|-------------|
| `cd worker && npm run dev` | Local dev server (port 8787) |
| `cd terraform && terraform apply` | Deploy everything (DB, worker, secret) |
| `cd worker && npm run tail` | Stream live Worker logs |
| `cd worker && npm run typecheck` | TypeScript type check |

## Protecting with Cloudflare Access

The workers.dev URL is publicly accessible by default. To restrict it:

1. In the Cloudflare dashboard, go to **Zero Trust → Access → Applications → Add an application**.
2. Choose **Self-hosted**.
3. Set the application domain to your `*.workers.dev` URL (e.g. `tf-cf-wanstats.<subdomain>.workers.dev`).
4. Configure a policy (e.g. allow your email domain or specific emails).
5. Save. The dashboard will now require authentication.

## Re-deploying after code changes

Run `terraform apply` — it detects changes via `filesha256` on `worker/src/index.ts` and re-deploys automatically.

To deploy without Terraform:
```bash
cd worker
npx wrangler deploy   # requires CLOUDFLARE_API_TOKEN or wrangler login
```

## Data retention

D1 rows accumulate indefinitely. Consider adding a periodic cleanup after you have enough history:
```sql
DELETE FROM tunnel_metrics WHERE ts < datetime('now', '-90 days');
```

This can be added as a second cron trigger on the worker or run manually.

## Notes

- **GraphQL `limit: 100`**: The query fetches at most 100 tunnel+direction combinations per poll. If you have more than 50 tunnels (since ingress and egress are separate rows), add pagination logic to `fetchTunnelMetrics` in `worker/src/index.ts`.
- **`wrangler.jsonc` is generated** by Terraform from `wrangler.jsonc.tpl`. Do not edit `wrangler.jsonc` directly — it is gitignored and will be overwritten on `terraform apply`.
- **`AI-SETUP-INSTRUCTIONS.md`** is local only and gitignored.
