# /api/current + 5-minute ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public bulk endpoint (`GET /api/current`) returning the trailing raw window for all tunnels in one D1 query, and move ingest from hourly to every 5 minutes with a light/full cron split, so PowerBI can poll every 5 minutes at 500–1000 tunnel scale.

**Architecture:** Single Cloudflare Worker (`worker/src/*`), D1 + R2 dual storage, deployed via Terraform. New endpoint reads `tunnel_metrics` via the existing `(direction, ts)` index. Cron gains a `fullRun` flag: minute-0 runs keep today's exact 65-min fetch + R2 write + rollups; other `*/5` runs fetch a 20-min window and write D1 only.

**Tech Stack:** TypeScript Worker (no test framework in repo — verification is `npm run typecheck` + local `wrangler dev` with a seeded local D1 + curl), bash script, wrangler.jsonc template rendered by Terraform.

**Spec:** `docs/superpowers/specs/2026-07-17-api-current-powerbi-design.md`

## Global Constraints

- **Deploy only via Terraform** (`cd terraform && terraform apply`). Never run `wrangler deploy` directly.
- **Never edit `worker/wrangler.jsonc`** — it is gitignored and rendered from `worker/wrangler.jsonc.tpl`.
- **Never commit `CLAUDE.md`** — it is local-only documentation.
- **Sargable D1 queries only:** never wrap the indexed columns (`tunnel_name`, `direction`, `ts`) of `tunnel_metrics` in functions inside WHERE/JOIN. Filter per direction; a bare `ts >= ?` cannot use `idx_tm_direction_ts (direction, ts)`.
- **ts format contract** (from `worker/src/d1.ts:83-88`): raw `tunnel_metrics.ts` stores `'YYYY-MM-DDTHH:MM:SSZ'` (no milliseconds). Bind comparison values in that exact format.
- **`db.batch()` limit is 100 statements** — existing write paths already chunk; do not add unchunked batch writes.
- `/api/current` defaults: `window=20` minutes, clamped to `[5, 1440]`, non-numeric → default. Response headers include `Cache-Control: no-store`.
- Cron: full run when `now.getUTCMinutes() < 5`; light run lookback is 20 minutes; full run lookback stays 65 minutes.
- All commands below run from the repo root unless a `cd` is shown. The repo root is the directory containing `worker/`, `terraform/`, `migrations/`, `scripts/`.

---

### Task 1: `/api/current` endpoint (D1 query + route)

**Files:**
- Modify: `worker/src/d1.ts` (add exported SQL constant, after the `purgeOldData` function which ends near line 78)
- Modify: `worker/src/api.ts` (add import; add route block before the final `return new Response('Not found', { status: 404 });` at line 256)

**Interfaces:**
- Consumes: existing `Env` type (`env.DB: D1Database`), `handleApiRequest(request, env)` routing pattern in `api.ts`, error handling via the try/catch in `index.ts:20-30` (thrown errors become JSON 500 — do not add a try/catch in the handler).
- Produces: `CURRENT_METRICS_SQL` (exported const string from `d1.ts`, bind: `?1 = since` in raw ts format, used twice via numbered placeholder). Endpoint response shape:
  `{ generated_at: string, window_minutes: number, row_count: number, rows: Array<{ tunnel_name: string, direction: 'ingress'|'egress', ts: string, bit_rate_bps: number }> }`
  where `ts` values are `'YYYY-MM-DDTHH:MM:SSZ'`.

- [ ] **Step 1: Add the SQL constant to `worker/src/d1.ts`**

Insert after the closing brace of `purgeOldData` (before the `// ── SQL for per-tunnel p95 ──` comment block):

```ts
// ── Current-window bulk query (/api/current) ────────────────────────────────
// Bind: ?1 = since, in raw ts format 'YYYY-MM-DDTHH:MM:SSZ'.
// Per-direction predicates keep idx_tm_direction_ts (direction, ts) in play;
// a bare "ts >= ?" would full-scan tunnel_metrics (millions of rows at
// 500+ tunnels x 7-day retention).
export const CURRENT_METRICS_SQL = `
  SELECT tunnel_name, direction, ts, bit_rate FROM tunnel_metrics
  WHERE direction = 'ingress' AND ts >= ?1
  UNION ALL
  SELECT tunnel_name, direction, ts, bit_rate FROM tunnel_metrics
  WHERE direction = 'egress' AND ts >= ?1
  ORDER BY tunnel_name, direction, ts
`;
```

- [ ] **Step 2: Add the route to `worker/src/api.ts`**

Add `CURRENT_METRICS_SQL` to the existing import from `./d1` (the brace list at lines 3–12):

```ts
import {
  buildPaginatedTunnelsSql,
  buildTunnelCountSql,
  buildTimeSeriesSql,
  getP95PerTunnelSql,
  getP95AggregateSql,
  getBillingP95Summary,
  getBillingP95Tunnels,
  storeTunnelMetrics,
  CURRENT_METRICS_SQL,
} from './d1';
```

Insert this block in `handleApiRequest`, immediately before `return new Response('Not found', { status: 404 });`:

```ts
if (pathname === '/api/current') {
  const windowParam = parseInt(url.searchParams.get('window') ?? '', 10);
  const windowMinutes = isNaN(windowParam) ? 20 : Math.min(1440, Math.max(5, windowParam));
  const now = new Date();
  // Match the raw ts storage format (no milliseconds) for clean string comparison.
  const since = new Date(now.getTime() - windowMinutes * 60 * 1000)
    .toISOString().slice(0, 19) + 'Z';

  const { results } = await env.DB.prepare(CURRENT_METRICS_SQL)
    .bind(since)
    .all<{ tunnel_name: string; direction: string; ts: string; bit_rate: number }>();

  return Response.json({
    generated_at: now.toISOString(),
    window_minutes: windowMinutes,
    row_count: results.length,
    rows: results.map((r) => ({
      tunnel_name: r.tunnel_name,
      direction: r.direction,
      ts: r.ts,
      bit_rate_bps: r.bit_rate,
    })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
```

- [ ] **Step 3: Typecheck**

Run: `cd worker && npm run typecheck`
Expected: exits 0, no output errors.

- [ ] **Step 4: Prepare local D1 (schema + seed rows)**

From `worker/` (creates/uses the local Miniflare SQLite state; run these BEFORE starting the dev server):

```bash
npx wrangler d1 execute tf-cf-wanstats-metrics --local --file ../migrations/0001_initial.sql
npx wrangler d1 execute tf-cf-wanstats-metrics --local --file ../migrations/0002_rollups.sql
npx wrangler d1 execute tf-cf-wanstats-metrics --local --command "
INSERT OR REPLACE INTO tunnel_metrics (tunnel_name, direction, ts, bit_rate) VALUES
  ('test-a', 'ingress', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-5 minutes'), 1000.0),
  ('test-a', 'egress',  strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-5 minutes'), 2000.0),
  ('test-b', 'ingress', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-5 minutes'), 3000.0),
  ('test-b', 'ingress', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 hours'),   9999.0);"
```

Expected: each command reports success (`🚣 Executed ...`). The `-2 hours` row exists to prove window filtering.

- [ ] **Step 5: Start dev server and verify behavior**

Terminal 1, from `worker/`: `npm run dev` (serves http://localhost:8787).

Terminal 2:

```bash
curl -s "http://localhost:8787/api/current" | python3 -m json.tool
```
Expected: `window_minutes: 20`, `row_count: 3`, rows for `test-a` (ingress 1000, egress 2000) and `test-b` (ingress 3000); the `-2 hours` row (9999.0) absent; `ts` values end in `Z` with no milliseconds.

```bash
curl -s "http://localhost:8787/api/current?window=999999" | python3 -c "import sys,json; print(json.load(sys.stdin)['window_minutes'])"
curl -s "http://localhost:8787/api/current?window=1"      | python3 -c "import sys,json; print(json.load(sys.stdin)['window_minutes'])"
curl -s "http://localhost:8787/api/current?window=abc"    | python3 -c "import sys,json; print(json.load(sys.stdin)['window_minutes'])"
```
Expected: `1440`, `5`, `20` (clamping high/low, non-numeric → default).

```bash
curl -s "http://localhost:8787/api/current?window=180" | python3 -c "import sys,json; print(json.load(sys.stdin)['row_count'])"
curl -s -D - -o /dev/null "http://localhost:8787/api/current" | grep -i cache-control
```
Expected: `4` (the 2-hours-old row now included), and `Cache-Control: no-store`.

- [ ] **Step 6: Commit**

```bash
git add worker/src/d1.ts worker/src/api.ts
git commit -m "feat: add GET /api/current bulk raw-window endpoint

One indexed D1 query returns all tunnels' raw 5-min samples for the
trailing window (default 20 min, clamp 5-1440) for external pollers.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Cron light/full split + `*/5` trigger

**Files:**
- Modify: `worker/src/cron.ts:7-55` (`handleCron` only; `handleDailyTasks` and `computeAndStoreBillingP95` unchanged)
- Modify: `worker/wrangler.jsonc.tpl` (crons array, currently `["0 * * * *"]`)

**Interfaces:**
- Consumes: `fetchMetricsTimeSliced(accountId: string, token: string, start: Date, end: Date)` → `{ ingress: NormalizedRow[], egress: NormalizedRow[], warnings: string[] }` from `./graphql`; `storeTunnelMetrics(db, rows, direction)`, `rollupHour`, `setMetadata` from `./d1`; `writeRawToR2(bucket, ingress, egress)` from `./r2`; `snapToHour` from `./utils`. All already imported in `cron.ts`.
- Produces: no new exports. Behavior contract for ops: log line `Cron run: full|light (lookback Nm)` on every run; light runs write D1 only.

- [ ] **Step 1: Rewrite `handleCron` in `worker/src/cron.ts`**

Replace the entire `handleCron` function (lines 7–55) with:

```ts
export async function handleCron(env: Env): Promise<void> {
  const now = new Date();
  // Cron fires every 5 minutes. The minute-0 slot is the authoritative full
  // run (65-min lookback, R2 write, rollups, daily tasks); the other slots
  // are light runs that only refresh recent raw data in D1. The 20-min light
  // lookback covers Analytics API data latency; INSERT OR REPLACE lets
  // late-arriving buckets settle on subsequent runs.
  const fullRun = now.getUTCMinutes() < 5;
  const lookbackMinutes = fullRun ? 65 : 20;
  const windowStart = new Date(now.getTime() - lookbackMinutes * 60 * 1000);

  console.log(`Cron run: ${fullRun ? 'full' : 'light'} (lookback ${lookbackMinutes}m)`);

  // Step 1: Fetch via time-sliced GraphQL
  const { ingress, egress, warnings } = await fetchMetricsTimeSliced(
    env.ACCOUNT_ID,
    env.WAN_API_TOKEN,
    windowStart,
    now,
  );

  if (warnings.length > 0) {
    console.warn(`Data collection warnings: ${warnings.join('; ')}`);
  }

  // Track tunnel count for capacity monitoring
  const tunnelNames = new Set<string>();
  for (const row of ingress) tunnelNames.add(row.tunnelName);
  for (const row of egress) tunnelNames.add(row.tunnelName);
  await setMetadata(env.DB, 'last_tunnel_count', tunnelNames.size.toString());
  await setMetadata(env.DB, 'last_cron_run', now.toISOString());

  if (tunnelNames.size >= 2500) {
    console.warn(`CAPACITY WARNING: ${tunnelNames.size} tunnels detected. GraphQL limit may need increasing.`);
  }

  if (!fullRun) {
    // Light run: D1 only. R2, rollups, and retention stay on the full run so
    // hourly CSV objects and billing p95 remain byte-identical to before.
    await Promise.all([
      storeTunnelMetrics(env.DB, ingress, 'ingress'),
      storeTunnelMetrics(env.DB, egress, 'egress'),
    ]);
    console.log(`D1 (light): stored ${ingress.length} ingress + ${egress.length} egress rows`);
    return;
  }

  // Step 2: Dual-write D1 + R2
  const [, r2Result] = await Promise.all([
    Promise.all([
      storeTunnelMetrics(env.DB, ingress, 'ingress'),
      storeTunnelMetrics(env.DB, egress, 'egress'),
    ]),
    writeRawToR2(env.RAW_METRICS, ingress, egress),
  ]);

  console.log(`D1: stored ${ingress.length} ingress + ${egress.length} egress rows`);
  console.log(`R2: wrote ${r2Result.filesWritten} files, ${r2Result.totalRows} total rows`);

  // Step 3: Hourly rollup (2 hours ago is safe — data is settled)
  const completedHour = snapToHour(new Date(now.getTime() - 2 * 60 * 60 * 1000));
  const rollupChanges = await rollupHour(env.DB, completedHour.toISOString());
  console.log(`Hourly rollup for ${completedHour.toISOString()}: ${rollupChanges} rows`);

  // Step 4: Daily tasks at hour 0 UTC
  if (now.getUTCHours() === 0) {
    await handleDailyTasks(env, now);
  }
}
```

(Imports at the top of the file are unchanged — everything used is already imported.)

- [ ] **Step 2: Update the cron trigger in `worker/wrangler.jsonc.tpl`**

Change:

```jsonc
  "triggers": {
    "crons": ["0 * * * *"]
  },
```

to:

```jsonc
  "triggers": {
    "crons": ["*/5 * * * *"]
  },
```

- [ ] **Step 3: Typecheck**

Run: `cd worker && npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Verify branch selection locally**

With the dev server running (`npm run dev` from `worker/`):

```bash
curl -s "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

Expected in the dev-server terminal: a log line `Cron run: full (lookback 65m)` if the wall-clock UTC minute is 0–4, otherwise `Cron run: light (lookback 20m)`. (The subsequent GraphQL fetch fails without a real `WAN_API_TOKEN` in `.dev.vars` — that's fine; the branch log proves the split logic. If `.dev.vars` has a token, also expect the `D1 (light): stored ...` or `D1: stored ...` line.)

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron.ts worker/wrangler.jsonc.tpl
git commit -m "feat: 5-minute ingest with light/full cron split

*/5 cron: minute-0 runs keep the 65-min window + R2 write + rollups +
daily tasks; other runs fetch a 20-min window and write D1 only. Keeps
R2 objects and billing p95 byte-identical while cutting data staleness
from ~65 min to ~5-10 min.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `scripts/backfill.sh` optional Access service-token headers

**Files:**
- Modify: `scripts/backfill.sh` (env-var docs at lines 15-17; new block after the `BACKFILL_TOKEN` check ending line 42; curl call at lines 85-87)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: script honors optional env vars `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`; when both set, every curl adds `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers. Unset → behavior unchanged.

- [ ] **Step 1: Document the new env vars in the header comment**

Change lines 15–17 from:

```bash
# Required environment variables:
#   WORKER_URL      e.g. https://tf-cf-wanstats.<subdomain>.workers.dev
#   BACKFILL_TOKEN  value from terraform.tfvars
```

to:

```bash
# Required environment variables:
#   WORKER_URL      e.g. https://tf-cf-wanstats.<subdomain>.workers.dev
#   BACKFILL_TOKEN  value from terraform.tfvars
#
# Optional (required when the worker hostname is behind Cloudflare Access):
#   CF_ACCESS_CLIENT_ID      Access service token client ID
#   CF_ACCESS_CLIENT_SECRET  Access service token client secret
```

- [ ] **Step 2: Build the header array after the BACKFILL_TOKEN check**

Insert after the `fi` on line 42 (the `BACKFILL_TOKEN` check):

```bash
# Cloudflare Access service token headers (only when both vars are set).
# The ${arr[@]+...} expansion form is required: macOS ships bash 3.2, where
# expanding an empty array under `set -u` is an unbound-variable error.
ACCESS_HEADERS=()
if [[ -n "${CF_ACCESS_CLIENT_ID:-}" && -n "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
  ACCESS_HEADERS=(
    -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}"
    -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}"
  )
fi
```

- [ ] **Step 3: Add the headers to the curl call**

Change:

```bash
  response=$(curl -s -X POST \
    "${WORKER_URL}/api/backfill?start=${window_start}&end=${window_end}" \
    -H "X-Backfill-Token: ${BACKFILL_TOKEN}")
```

to:

```bash
  response=$(curl -s -X POST \
    "${WORKER_URL}/api/backfill?start=${window_start}&end=${window_end}" \
    -H "X-Backfill-Token: ${BACKFILL_TOKEN}" \
    ${ACCESS_HEADERS[@]+"${ACCESS_HEADERS[@]}"})
```

- [ ] **Step 4: Verify the script parses and both branches work**

```bash
bash -n scripts/backfill.sh
```
Expected: no output, exit 0.

```bash
WORKER_URL=http://localhost:8787 BACKFILL_TOKEN=x ./scripts/backfill.sh 2026-07-17T00:00:00Z 2026-07-17T01:00:00Z; echo "exit=$?"
```
Expected (dev server running, no Access vars): one window attempted, `ERROR` with response `Unauthorized` (local worker rejects the dummy token), `exit=1`. This proves the empty-array branch doesn't trip `set -u` on macOS bash 3.2.

```bash
WORKER_URL=http://localhost:8787 BACKFILL_TOKEN=x CF_ACCESS_CLIENT_ID=id.access CF_ACCESS_CLIENT_SECRET=sec ./scripts/backfill.sh 2026-07-17T00:00:00Z 2026-07-17T01:00:00Z; echo "exit=$?"
```
Expected: same `Unauthorized` / `exit=1` (headers sent, local worker ignores them) — proves the populated branch also parses and runs.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill.sh
git commit -m "feat: optional Access service-token headers in backfill.sh

When CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET are set, curls include
the Access headers so backfill works on Access-protected hostnames.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Documentation — PowerBI guide (committed) + CLAUDE.md (local only)

**Files:**
- Create: `docs/powerbi-integration.md`
- Modify: `CLAUDE.md` (HTTP role endpoint list; cron description) — **do NOT commit CLAUDE.md**

**Interfaces:**
- Consumes: endpoint shape from Task 1, cron behavior from Task 2.
- Produces: customer-facing doc; updated local project instructions.

- [ ] **Step 1: Create `docs/powerbi-integration.md`**

````markdown
# PowerBI integration — polling /api/current

The worker exposes `GET /api/current` for bulk pollers. One request returns
every tunnel's raw 5-minute samples for the trailing window — no pagination.

## Endpoint

```
GET https://tf-cf-wanstats.<subdomain>.workers.dev/api/current[?window=20]
```

- `window` — trailing window in minutes. Default 20, clamped to 5–1440.
  The default matches the ingest lookback: each 5-minute poll picks up the
  newest bucket plus the still-settling recent ones, and up to three missed
  polls self-heal. Larger windows multiply D1 rows read — leave at default
  unless you have a reason.
- Response:

```json
{
  "generated_at": "2026-07-17T18:05:12.345Z",
  "window_minutes": 20,
  "row_count": 4432,
  "rows": [
    { "tunnel_name": "site-a", "direction": "ingress",
      "ts": "2026-07-17T17:55:00Z", "bit_rate_bps": 12345.6 }
  ]
}
```

Rows are keyed by `(tunnel_name, direction, ts)` — dedupe on that key when
accumulating history, since consecutive polls overlap by design.

## Authentication (Cloudflare Access service token)

When the hostname is protected by Cloudflare Access, requests must carry a
service token. In Power Query, use anonymous auth and send the token as
headers via `Web.Contents`:

```m
let
  Source = Json.Document(Web.Contents(
    "https://tf-cf-wanstats.<subdomain>.workers.dev/api/current",
    [Headers = [
      #"CF-Access-Client-Id"    = "<client-id>.access",
      #"CF-Access-Client-Secret" = "<client-secret>"
    ]]
  )),
  rows  = Source[rows],
  tbl   = Table.FromRecords(rows),
  typed = Table.TransformColumnTypes(tbl, {
    {"tunnel_name", type text},
    {"direction", type text},
    {"ts", type datetimezone},
    {"bit_rate_bps", type number}
  })
in
  typed
```

Set the data source credential to **Anonymous** (the headers do the auth).

## Refresh cadence caveat

The Power BI *service* cannot scheduled-refresh an import-mode dataset every
5 minutes (Pro: 8 refreshes/day, Premium/PPU: 48/day). True 5-minute cadence
requires one of: a push/streaming dataset fed by a small poller (e.g. Power
Automate flow calling this endpoint), refreshes triggered via the enhanced
refresh REST API on Premium capacity, or Fabric real-time features. Data in
the worker is at most ~5–10 minutes behind live (ingest runs every 5 minutes;
Cloudflare's Analytics API itself has a few minutes of latency).
````

- [ ] **Step 2: Update `CLAUDE.md` (local only — never commit)**

In the **Cron role** section, change the schedule note `(`scheduled` handler, `0 * * * *` — every hour)` to `(`scheduled` handler, `*/5 * * * *`)` and add at the top of the bullet list:

```markdown
- Light/full split: minute-0 runs are full (65-min window, R2 write, hourly rollup, midnight daily tasks — identical to the old hourly behavior); all other */5 runs are light (20-min window, D1 write only)
```

In the **HTTP role** section, add to the endpoint list after the `/api/metrics` line:

```markdown
- `GET /api/current?window=20` — bulk raw window for ALL tunnels in one query (PowerBI polling); window clamped 5–1440 min; public (Access handles auth at the edge)
```

In the **Backfill historical data** section, add after the `BACKFILL_TOKEN` export line:

```markdown
export CF_ACCESS_CLIENT_ID=...      # only if hostname is behind Cloudflare Access
export CF_ACCESS_CLIENT_SECRET=...
```

- [ ] **Step 3: Commit (docs only)**

```bash
git add docs/powerbi-integration.md
git commit -m "docs: PowerBI integration guide for /api/current

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Verify CLAUDE.md is NOT staged: `git status --short CLAUDE.md` must show ` M CLAUDE.md` (unstaged) or nothing staged.

---

### Task 5: Deploy, live verification, push

**Files:** none (operational task).

**Interfaces:**
- Consumes: all prior tasks committed on `main`.
- Produces: deployed worker on rob-danz account; branch pushed to `origin/main` so the customer can pull.

- [ ] **Step 1: Terraform plan + apply**

```bash
cd terraform && terraform plan
```
Expected: `null_resource.deploy` (and dependents) marked for replacement — trigger hash changed via `worker/src/*` and the rendered wrangler config (cron change). No D1/R2 resource changes.

```bash
terraform apply -auto-approve
```
Expected: completes with `Apply complete`. This renders `worker/wrangler.jsonc` (now with `*/5 * * * *`), runs `wrangler deploy`, and re-sets secrets.

- [ ] **Step 2: Verify the live endpoint (rob-danz deployment, ~7 tunnels)**

```bash
curl -s "https://tf-cf-wanstats.rob-danz.workers.dev/api/current" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('window:', d['window_minutes'], 'rows:', d['row_count'])
print('sample:', d['rows'][0] if d['rows'] else 'EMPTY')"
```
Expected: `window: 20`, `rows:` > 0 once at least one post-deploy cron run has fired (within 5 minutes of deploy; immediately after deploy the last hourly-era data may already be inside the 20-min window — if `rows: 0`, retry with `?window=70` and after 5 minutes).

- [ ] **Step 3: Verify 5-minute cron cadence**

Wait ≥ 11 minutes after deploy, then:

```bash
cd worker && npx wrangler d1 execute tf-cf-wanstats-metrics --remote --command \
  "SELECT key, value FROM cron_metadata WHERE key = 'last_cron_run'"
```
Expected: `last_cron_run` within the past 5 minutes. Optionally `npm run tail` across a 5-minute boundary and confirm a `Cron run: light (lookback 20m)` line, and at the top of an hour a `Cron run: full (lookback 65m)` line.

- [ ] **Step 4: Push**

```bash
git push origin main
```
Expected: all task commits pushed. Customer then runs `git checkout -- worker/package-lock.json` (if dirty from terraform's npm install), `git pull`, `cd terraform && terraform apply`.

- [ ] **Step 5: Customer-scale probe (after the customer redeploys)**

```bash
time curl -s "https://tf-cf-wanstats.accenture-iot.workers.dev/api/current" -o /tmp/current.json
python3 -c "import json; d = json.load(open('/tmp/current.json')); print(d['window_minutes'], d['row_count'])"
```
Expected at ~554 tunnels: < 1.5 s, ~4.4k rows (554 × 2 × 4 buckets). Once the customer enables Access, add `-H "CF-Access-Client-Id: ..." -H "CF-Access-Client-Secret: ..."` to the probe.
