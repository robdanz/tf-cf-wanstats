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
