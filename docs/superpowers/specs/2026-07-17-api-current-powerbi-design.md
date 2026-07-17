# Design: `/api/current` bulk endpoint + 5-minute ingest (PowerBI integration)

Date: 2026-07-17
Status: approved pending review

## Purpose

The customer (accenture-iot, ~554 tunnels, growing toward 1000) wants to poll the
worker every 5 minutes from PowerBI and pull current stats for **all** tunnels.
Existing endpoints are paginated and dashboard-shaped; ingest is hourly, so
"current" data is up to ~65 minutes stale. This feature adds a single-request
bulk endpoint and aligns ingest cadence with the poll cadence.

Rate limiting was investigated and is a non-issue: Workers have no
requests-per-second limit (Free plan cap is 100,000 requests/day; a 5-minute
poll is 288/day), D1 calls are internal subrequests (1,000/invocation Free,
10,000 Paid), and Cloudflare Access imposes no rate limit on service-token
requests. Note the */5 ingest raises D1 row-writes ~4.4x (~2.7M/day at
1,000 tunnels) — beyond Free-plan D1 write limits, but the pre-existing
hourly ingest at 500+ tunnels already required the Workers Paid plan, where
this sits well inside the 50M/day allowance.

## Authentication

None in the worker. The customer will protect the entire workers.dev hostname
with Cloudflare Access (one-click enable on the workers.dev route), with two
policies on that Access application:

1. **Allow** — users by email address (browser dashboard access).
2. **Service Auth** — a service token for PowerBI, sent as
   `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers.

The worker treats `/api/current` as public. Access policies are managed in the
Cloudflare dashboard, outside this repo.

Consequence: with Access covering the hostname, plain-curl callers are
intercepted. `scripts/backfill.sh` gains optional
`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` environment variables; when
set, the curl sends the corresponding Access headers. Unset, behavior is
unchanged (for deployments without Access, e.g. rob-danz).

## Component 1 — `GET /api/current?window=20`

Returns every raw 5-minute sample for all tunnels in the trailing window, from
D1 `tunnel_metrics`, in **one query** using the existing `(direction, ts)`
index (`idx_tm_direction_ts`). No pagination.

- `window` — minutes, default `20`, clamped to `[5, 1440]` (raw retention is
  7 days; a poller never needs more than a day). Non-numeric input → default.
  The default matches the light-run ingest lookback: each poll picks up the
  newest bucket plus the three still-settling ones, and up to three missed
  polls self-heal. Larger windows work but multiply D1 rows read — at 1,000
  tunnels a 60-min window polled every 5 min is ~6.9M rows read/day, which
  alone would exceed the Workers Free plan's 5M/day D1 read limit; the 20-min
  default is ~2.3M/day. Data revised by the hourly 65-min authoritative pass
  beyond the 20-min horizon is not re-delivered; callers who care can request
  `window=70` occasionally.
- Query (sargable; bare `ts >= ?` would not use the index):

```sql
SELECT tunnel_name, direction, ts, bit_rate FROM tunnel_metrics
WHERE direction = 'ingress' AND ts >= ?
UNION ALL
SELECT tunnel_name, direction, ts, bit_rate FROM tunnel_metrics
WHERE direction = 'egress' AND ts >= ?
ORDER BY tunnel_name, direction, ts
```

- Response (flat rows — PowerBI-friendly for `Json.Document` → expand):

```json
{
  "generated_at": "2026-07-17T18:05:12.345Z",
  "window_minutes": 20,
  "row_count": 4432,
  "rows": [
    { "tunnel_name": "site-a", "direction": "ingress",
      "ts": "2026-07-17T17:05:00Z", "bit_rate_bps": 12345.6 }
  ]
}
```

- Headers: `Cache-Control: no-store` (plus existing `Content-Type`).
- Errors flow through the existing route try/catch in `index.ts` → JSON 500.
- Scale: 1,000 tunnels × 2 directions × 4 buckets ≈ 8k rows ≈ 0.5 MB JSON.
  One D1 subrequest, index range scan, sub-second.

Implementation lands in `api.ts` (route block in `handleApiRequest`) +
`d1.ts` (SQL constant); `index.ts` already delegates all `/api/*` paths.

## Component 2 — cron split: light/full runs

`worker/wrangler.jsonc.tpl` cron changes `0 * * * *` → `*/5 * * * *`.

In `handleCron` (`cron.ts`):

```
fullRun = now.getUTCMinutes() < 5      // tolerant of intra-slot skew
window  = fullRun ? 65 min : 20 min
fetch GraphQL time-sliced (window)     // 13 slices vs 4
write D1 (INSERT OR REPLACE)           // every run
if fullRun:
  write R2 raw CSVs                    // unchanged
  hourly rollup (2h ago)               // unchanged
  if hour == 0: daily tasks            // unchanged (rollup, purges, billing p95)
```

- Light runs are D1-only. The 20-minute lookback covers Analytics API data
  latency; `INSERT OR REPLACE` lets late-arriving data settle on subsequent
  runs. The full run's 65-minute window remains the authoritative hourly pass,
  so R2 objects and billing p95 are byte-identical to today's behavior.
- Metadata writes (`last_cron_run`, `last_tunnel_count`) and the 2500-tunnel
  capacity warning stay on every run.
- GraphQL volume: 11 light runs × 4 slices + 1 full run × 13 slices ≈ 57–61
  requests/hour — far under API limits.
- Local testing hits the same handler regardless of cron string, so light/full
  is driven by wall-clock minutes in dev too (documented in test plan).

## Component 3 — `scripts/backfill.sh` Access headers

Optional env vars `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`. When both
are set, the curl adds:

```
-H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}"
-H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}"
```

No other script behavior changes.

## Out of scope

- Access application/policy configuration (managed in Cloudflare dash).
- PowerBI-side refresh mechanics. Note for the customer: the Power BI
  *service* cannot scheduled-refresh an import dataset every 5 minutes
  (Pro: 8/day, Premium: 48/day); true 5-minute cadence on their side requires
  a push/streaming dataset, Power Automate-triggered refresh, or Fabric.
- Any schema migration (none needed) or new secrets (none needed).
- Dashboard changes (dashboard continues using existing endpoints).

## Testing

1. `npm run typecheck`.
2. `wrangler dev`: `curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"`
   — verify light path (D1 write only) when wall-clock minute ≥ 5, full path
   when minute < 5; confirm via log lines which path ran.
3. `curl "http://localhost:8787/api/current"` — default window, shape, clamping
   (`window=1`, `window=99999`, `window=abc`), `no-store` header.
4. Deploy to rob-danz via `terraform apply`; verify `/api/current` live and
   confirm 5-minute cron runs appear in `npm run tail` / metadata
   `last_cron_run` advancing every 5 minutes.
5. After customer pulls + applies: probe
   `https://tf-cf-wanstats.accenture-iot.workers.dev/api/current` at
   ~554-tunnel scale (expect <1.5 s, ~4.4k rows for the 20-min default) — with service
   token headers once Access is enabled.

## Deployment

Normal `terraform apply` — src hash change triggers redeploy; the cron change
ships via the rendered wrangler config. No migration resource, no new secrets.
Customer runs `git pull` (after `git checkout -- worker/package-lock.json` if
dirty) + `terraform apply`.
