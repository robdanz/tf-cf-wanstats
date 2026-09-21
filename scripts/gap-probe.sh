#!/usr/bin/env bash
# gap-probe.sh — Explain per-tunnel data gaps, and measure how much Cloudflare
# revises the analytics data after the collector's last look.
#
# Three views of every 5-minute bucket are compared:
#
#   GQL  what Cloudflare's GraphQL API returns for that bucket right now,
#        fetched exactly as the collector does (one 5-minute slice, both
#        directions, all tunnels)
#   D1   what the worker holds in tunnel_metrics, with written_at (when the
#        row landed), read via `wrangler d1 execute --remote`
#   R2   what the worker's raw CSV archive holds, read via /api/export
#
# Modes:
#   ./scripts/gap-probe.sh <gaps-file> [pad-minutes]
#       Answer, per reported gap, whether the rows are (a) in our stores,
#       (b) missing from our stores but available at Cloudflare now, or
#       (c) nowhere. The verdict table at the end is the deliverable:
#         IN OUR STORES   D1 or R2 has the rows -> consumer side, or the
#                         report's timestamp semantics are off
#         RECOVERABLE     not stored, Cloudflare has them now -> backfill
#                         (the exact backfill.sh commands are printed)
#         LEGIT           not stored and Cloudflare has nothing -> the tunnel
#                         had no sampled traffic in those buckets
#       VERBOSE=1 adds the per-bucket population/revision table and a
#       bucket-by-bucket matrix per gap (GQL now / D1 with arrival lag / R2).
#
#   ./scripts/gap-probe.sh <start-iso> <end-iso>
#       Audit only: R2 vs D1 per hour, and (unless GQL=0) the per-bucket
#       population and revision table for the range (max 24h).
#
# gaps-file: one gap per line, either
#   tunnel,direction,<ISO 8601 timestamp>,<gap minutes>
# or the consumer export shape (dd-mm-yyyy and h:mm:ss duration):
#   tunnel,direction,dd-mm-yyyy,HH:MM:SS,<value>,H:MM:SS
# Blank lines and lines starting with # are ignored. Times are taken as UTC;
# set TZ_OFFSET_MIN if the consumer reported local time (e.g. -120 for UTC+2).
# pad-minutes (default 30) widens each probed window on both sides so the
# tunnel's normal cadence around the gap is visible.
#
# Timestamp semantics: the consumer export shape is read as "data resumed at
# T, N minutes after the previous row" (missing buckets T-N+5m .. T-5m). The
# 4-column shape is read as "last row at T, then N minutes missing" (missing
# buckets T+5m .. T+N).
# GAP_BEFORE=1 or GAP_BEFORE=0 overrides for every line.
#
# Once raw D1 rows have aged out (7 days) R2 is the store of record and the
# verdict uses it. GraphQL only reaches back as far as Cloudflare retains the
# dataset; if it returns nothing for the whole range the verdict says so
# instead of calling the gaps LEGIT.
#
# Required environment variables:
#   CLOUDFLARE_API_TOKEN  Account Analytics: Read (the worker's WAN_API_TOKEN)
#   ACCOUNT_ID            Cloudflare account ID
#
# Optional:
#   D1_API_TOKEN          token wrangler uses for D1 and R2 (the terraform
#                         deploy token works); defaults to CLOUDFLARE_API_TOKEN.
#                         Set D1=0 to skip the D1 sections.
#   GQL=0                 skip the GraphQL pass (R2-vs-D1 audit only; cheap)
#   R2_VIA                "export" (default: /api/export, needs WORKER_URL and
#                         Access headers if gated) or "wrangler" (reads the
#                         hour objects raw/YYYY-MM-DD/HH.csv with the deploy
#                         token; needs R2_BUCKET, default tf-cf-wanstats-raw-metrics).
#                         Falls back to wrangler when the export is refused.
#   WORKER_DIR            directory holding the rendered wrangler.jsonc
#                         (default: ../worker relative to this script)
#   D1_DATABASE           D1 database name (default tf-cf-wanstats-metrics)
#   WORKER_URL            enables the R2 (/api/export) and /api/health checks
#   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET   Access service token
#   VERBOSE=1             print the per-bucket tables (default: verdict only)
#   PROBE_SLEEP           seconds between GraphQL calls (default 0.5). One
#                         call per bucket, from the same ~300-per-5-min
#                         budget the live cron uses.
#   KEEP                  set to 1 to keep the raw fetches (path is printed)
#
# Requires curl, jq, gzip and (for D1) npx + wrangler in WORKER_DIR.
#
# Raw D1 rows live 7 days: run before the day in question ages out, or only
# the GraphQL and R2 columns populate.

set -euo pipefail

ARG1="${1:-}"; ARG2="${2:-}"
if [[ -z "$ARG1" ]]; then
  echo "Usage: $0 <gaps-file> [pad-minutes]  |  $0 <start-iso> <end-iso>" >&2; exit 1
fi
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is not set}"
: "${ACCOUNT_ID:?ACCOUNT_ID is not set}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="${WORKER_DIR:-$SCRIPT_DIR/../worker}"
D1_DATABASE="${D1_DATABASE:-tf-cf-wanstats-metrics}"
D1_API_TOKEN="${D1_API_TOKEN:-$CLOUDFLARE_API_TOKEN}"
D1="${D1:-1}"
GQL="${GQL:-1}"
R2_VIA="${R2_VIA:-export}"
R2_BUCKET="${R2_BUCKET:-tf-cf-wanstats-raw-metrics}"
PROBE_SLEEP="${PROBE_SLEEP:-0.5}"
TZ_OFFSET_MIN="${TZ_OFFSET_MIN:-0}"
GAP_BEFORE="${GAP_BEFORE:-}"   # empty = per-line default by input shape
VERBOSE="${VERBOSE:-0}"
MAX_BUCKETS=288

ACCESS_HEADERS=()
if [[ -n "${CF_ACCESS_CLIENT_ID:-}" && -n "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
  ACCESS_HEADERS=(-H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}")
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gap-probe.XXXXXX")"
mkdir -p "$WORK/gql" "$WORK/d1"
if [[ "${KEEP:-0}" == "1" ]]; then echo "Raw fetches kept in $WORK"; else trap 'rm -rf "$WORK"' EXIT; fi

# ── time helpers (macOS bash 3.2 + Linux) ───────────────────────────────────
to_epoch() { TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" "+%s" 2>/dev/null || date -u -d "$1" "+%s"; }
to_iso()   { date -u -r "$1" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "@$1" "+%Y-%m-%dT%H:%M:%SZ"; }
floor5()   { echo $(( $1 / 300 * 300 )); }
ceil5()    { echo $(( ($1 + 299) / 300 * 300 )); }
is_iso()   { [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; }

# ── inputs → $WORK/gaps.tsv (idx tunnel dir wstart wend last_seen gap_min)
#              $WORK/buckets.txt (sorted unique bucket ISO timestamps)
MODE=gaps
if is_iso "$ARG1"; then
  MODE=range
  is_iso "${ARG2:-}" || { echo "range mode needs <start-iso> <end-iso>" >&2; exit 1; }
  rs=$(floor5 "$(to_epoch "$ARG1")"); re=$(ceil5 "$(to_epoch "$ARG2")")
  (( re > rs )) || { echo "end must be after start" >&2; exit 1; }
  : >"$WORK/gaps.tsv"
  cur=$rs; while (( cur < re )); do to_iso "$cur"; cur=$((cur + 300)); done >"$WORK/buckets.txt"
else
  [[ -r "$ARG1" ]] || { echo "cannot read gaps file $ARG1" >&2; exit 1; }
  PAD_MIN="${ARG2:-30}"
  n=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line// }" || "${line:0:1}" == "#" ]] && continue
    IFS=',' read -r f1 f2 f3 f4 f5 f6 <<<"$line"
    f1="${f1// }"; f2="${f2// }"
    if [[ -n "${f6:-}" ]]; then
      d="${f3// }"; t="${f4// }"; dur="${f6// }"
      last_seen="${d:6:4}-${d:3:2}-${d:0:2}T${t}Z"
      IFS=':' read -r dh dm _ <<<"$dur"
      gap_min=$((10#$dh * 60 + 10#$dm))
      before="${GAP_BEFORE:-1}"
    else
      last_seen="${f3// }"; gap_min="${f4// }"
      before="${GAP_BEFORE:-0}"
    fi
    if [[ "$f2" != "ingress" && "$f2" != "egress" ]] || ! is_iso "$last_seen"; then
      echo "skip: cannot parse '$line'" >&2; continue
    fi
    ls_epoch=$(( $(to_epoch "$last_seen") - TZ_OFFSET_MIN * 60 ))
    if [[ "$before" == "1" ]]; then
      ws=$(floor5 $(( ls_epoch - gap_min * 60 - PAD_MIN * 60 )))
      we=$(ceil5  $(( ls_epoch + PAD_MIN * 60 + 300 )))
    else
      ws=$(floor5 $(( ls_epoch - PAD_MIN * 60 )))
      we=$(ceil5  $(( ls_epoch + gap_min * 60 + PAD_MIN * 60 + 300 )))
    fi
    n=$((n + 1))
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "$f1" "$f2" "$(to_iso "$ws")" "$(to_iso "$we")" "$(to_iso "$ls_epoch")" "$gap_min" "$before" >>"$WORK/gaps.tsv"
    cur=$ws; while (( cur < we )); do to_iso "$cur"; cur=$((cur + 300)); done >>"$WORK/buckets.raw"
  done <"$ARG1"
  (( n > 0 )) || { echo "No gaps parsed from $ARG1" >&2; exit 1; }
  sort -u "$WORK/buckets.raw" >"$WORK/buckets.txt"
fi

BUCKET_COUNT=$(wc -l <"$WORK/buckets.txt" | tr -d ' ')
if (( BUCKET_COUNT > MAX_BUCKETS )); then
  echo "Probe covers $BUCKET_COUNT buckets; max is $MAX_BUCKETS (one day). Split the input." >&2; exit 1
fi
RANGE_START=$(head -1 "$WORK/buckets.txt")
RANGE_END=$(to_iso $(( $(to_epoch "$(tail -1 "$WORK/buckets.txt")") + 300 )))

echo "gap-probe ($MODE): $BUCKET_COUNT bucket(s) $RANGE_START -> $RANGE_END   account: $ACCOUNT_ID"
[[ "$MODE" == "gaps" ]] && echo "  $(wc -l <"$WORK/gaps.tsv" | tr -d ' ') reported gap(s), pad ${PAD_MIN}m, tz offset ${TZ_OFFSET_MIN}m"
echo "  now: $(to_iso "$(date +%s)")"
echo

# ── /api/health ─────────────────────────────────────────────────────────────
if [[ -n "${WORKER_URL:-}" ]]; then
  echo "== /api/health"
  if h=$(curl -sS "${WORKER_URL}/api/health" ${ACCESS_HEADERS[@]+"${ACCESS_HEADERS[@]}"}) && echo "$h" | jq -e . >/dev/null 2>&1; then
    echo "$h" | jq -r 'to_entries[] | "  \(.key): \(.value | tojson)"'
  else
    echo "  unavailable (Access login page or error) — set CF_ACCESS_CLIENT_ID/SECRET"
  fi
  echo
fi

# ── GraphQL: one 5-min slice per bucket, exactly like the collector ─────────
GQL_QUERY='query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
  ingress: magicTransitNetworkAnalyticsAdaptiveGroups(limit: 3000, orderBy: [datetimeFiveMinutes_ASC], filter:{datetime_geq:$s, datetime_lt:$e, ingressTunnelName_notin:["","device_id"]}) { avg { bitRateFiveMinutes } dimensions { datetimeFiveMinutes ingressTunnelName } }
  egress:  magicTransitNetworkAnalyticsAdaptiveGroups(limit: 3000, orderBy: [datetimeFiveMinutes_ASC], filter:{datetime_geq:$s, datetime_lt:$e, egressTunnelName_notin:["","device_id"]}) { avg { bitRateFiveMinutes } dimensions { datetimeFiveMinutes egressTunnelName } } } } }'

cut -c1-13 "$WORK/buckets.txt" | sort -u >"$WORK/hours.txt"

if [[ "$GQL" == "0" ]]; then
  echo "GraphQL pass skipped (GQL=0)"; echo '[]' >"$WORK/gql.json"
else
printf "Fetching %s GraphQL slice(s)" "$BUCKET_COUNT"
i=0
while IFS= read -r ts; do
  end=$(to_iso $(( $(to_epoch "$ts") + 300 )))
  body=$(jq -cn --arg q "$GQL_QUERY" --arg a "$ACCOUNT_ID" --arg s "$ts" --arg e "$end" '{query:$q, variables:{a:$a, s:$s, e:$e}}')
  resp=$(curl -sS https://api.cloudflare.com/client/v4/graphql \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H 'Content-Type: application/json' --data "$body" 2>&1) || resp='{"errors":[{"message":"curl failed"}]}'
  echo "$resp" | jq -c --arg ts "$ts" '(.data.viewer.accounts[0] // {}) as $x
    | {ts: $ts, errors: ((.errors // []) | map(.message)),
       limit_hit: ((($x.ingress // []) | length) >= 3000 or (($x.egress // []) | length) >= 3000),
       ingress: (($x.ingress // []) | map({t: .dimensions.ingressTunnelName, v: .avg.bitRateFiveMinutes})),
       egress:  (($x.egress  // []) | map({t: .dimensions.egressTunnelName,  v: .avg.bitRateFiveMinutes}))}' \
    >"$WORK/gql/$ts.json" 2>/dev/null || echo "{\"ts\":\"$ts\",\"errors\":[\"unparseable response\"],\"limit_hit\":false,\"ingress\":[],\"egress\":[]}" >"$WORK/gql/$ts.json"
  i=$((i + 1)); (( i % 10 == 0 )) && printf "."
  sleep "$PROBE_SLEEP"
done <"$WORK/buckets.txt"
echo " done"
cat "$WORK"/gql/*.json | jq -sc '.' >"$WORK/gql.json"
fi

# ── D1 via wrangler: rows per hour covering the buckets, plus gap_buckets ───
d1_query() {
  local out
  if ! out=$(cd "$WORKER_DIR" && CLOUDFLARE_API_TOKEN="$D1_API_TOKEN" npx --no-install wrangler d1 execute "$D1_DATABASE" --remote --json --command "$1" 2>&1); then
    echo "  D1 query failed: $(echo "$out" | grep -v '^\s*$' | tail -2 | tr '\n' ' ')" >&2
    echo null; return
  fi
  echo "$out" | jq -c '.[0].results' 2>/dev/null || { echo "  D1: unparseable wrangler output: $(echo "$out" | tr '\n' ' ' | cut -c1-300)" >&2; echo null; }
}

D1_OK=false
if [[ "$D1" != "0" ]]; then
  printf "Fetching D1 rows for %s hour(s)" "$(wc -l <"$WORK/hours.txt" | tr -d ' ')"
  D1_OK=true
  while IFS= read -r hp; do
    hs="${hp}:00:00Z"; he=$(to_iso $(( $(to_epoch "$hs") + 3600 )))
    r=$(d1_query "SELECT tunnel_name, direction, ts, bit_rate, written_at FROM tunnel_metrics WHERE direction = 'ingress' AND ts >= '$hs' AND ts < '$he' UNION ALL SELECT tunnel_name, direction, ts, bit_rate, written_at FROM tunnel_metrics WHERE direction = 'egress' AND ts >= '$hs' AND ts < '$he'")
    if [[ "$r" == "null" ]]; then D1_OK=false; break; fi
    echo "$r" >"$WORK/d1/$hp.json"; printf "."
  done <"$WORK/hours.txt"
  echo " $([[ $D1_OK == true ]] && echo done || echo FAILED)"
  if [[ "$D1_OK" == true ]]; then
    # Same [RANGE_START, RANGE_END) filter as R2 below, or partial hours
    # show D1-only rows that are simply outside the probed range.
    cat "$WORK"/d1/*.json | jq -sc --arg s "$RANGE_START" --arg e "$RANGE_END" 'add | map(select(.ts >= $s and .ts < $e))' >"$WORK/d1.json"
    d1_query "SELECT ts, attempts, first_detected, confirmed_empty_at FROM gap_buckets WHERE ts >= '$RANGE_START' AND ts < '$RANGE_END' ORDER BY ts" >"$WORK/gaps_d1.json"
  fi
fi
[[ "$D1_OK" == true ]] || { echo null >"$WORK/d1.json"; echo null >"$WORK/gaps_d1.json"; }
echo

# ── R2 via /api/export: one export for the whole probed range, all tunnels ──
# Compared per hour (one R2 object per hour) against D1. Light runs write D1
# only; the minute-0 full run writes R2 for the previous 65 min, and the
# ledger rebuilds each hour's object from D1 ~2h after the hour. A consumer
# reading R2 sees an hour settle in two steps: H+1h (full run) and H+2..3h
# (ledger). Anything still missing after that is a real gap between stores.
echo null >"$WORK/r2.json"
R2_OK=false
if [[ "$R2_VIA" == "export" && -n "${WORKER_URL:-}" ]]; then
  printf "Fetching R2 export %s -> %s" "$RANGE_START" "$RANGE_END"
  code=$(curl -sS -o "$WORK/export.gz" -w '%{http_code}' \
    "${WORKER_URL}/api/export?start=${RANGE_START}&end=${RANGE_END}" \
    ${ACCESS_HEADERS[@]+"${ACCESS_HEADERS[@]}"}) || code=000
  if [[ "$code" == "200" ]] && gzip -dc "$WORK/export.gz" >"$WORK/export.csv" 2>/dev/null; then
    echo " done"; R2_OK=true
  else
    echo " FAILED (HTTP $code — Access login page or error); falling back to wrangler r2"
  fi
fi
if [[ "$R2_OK" != true ]]; then
  # Read the hour objects directly; export filters by ts, so do the same below.
  printf "Fetching %s R2 hour object(s) via wrangler" "$(wc -l <"$WORK/hours.txt" | tr -d ' ')"
  : >"$WORK/export.csv"; R2_OK=true; missing_objs=0
  while IFS= read -r hp; do
    key="raw/${hp:0:10}/${hp:11:2}.csv"
    if out=$(cd "$WORKER_DIR" && CLOUDFLARE_API_TOKEN="$D1_API_TOKEN" npx --no-install wrangler r2 object get "${R2_BUCKET}/${key}" --file "$WORK/hour.csv" --remote 2>&1); then
      cat "$WORK/hour.csv" >>"$WORK/export.csv"; printf "."
    elif echo "$out" | grep -qi "not found\|does not exist\|10007"; then
      missing_objs=$((missing_objs + 1)); printf "x"
    else
      echo " FAILED on $key: $(echo "$out" | grep -v '^\s*$' | tail -2 | tr '\n' ' ')"; R2_OK=false; break
    fi
  done <"$WORK/hours.txt"
  [[ "$R2_OK" == true ]] && echo " done ($missing_objs object(s) absent)"
fi
if [[ "$R2_OK" == true ]]; then
  jq -Rsc --arg s "$RANGE_START" --arg e "$RANGE_END" '[split("\n")[] | select(length > 0 and (startswith("tunnel_name,") | not)) | split(",")
            | select(length >= 4) | {t: .[0], dir: .[1], ts: .[2], v: (.[3] | tonumber)} | select(.ts >= $s and .ts < $e)]' "$WORK/export.csv" >"$WORK/r2.json"
  echo "  R2 rows in range: $(jq length "$WORK/r2.json")"
fi

# ── shared jq prelude: index both sources by "dir|ts" → {tunnel: {...}} ─────
JQ_PRELUDE='
  def epoch: (sub("\\.[0-9]+Z$"; "Z") | sub("Z$"; "") | strptime("%Y-%m-%dT%H:%M:%S") | mktime);
  def iso: strftime("%Y-%m-%dT%H:%M:%SZ");
  def pad($n): tostring | (" " * $n + .)[-$n:];
  ($gql | map(
      (.ts) as $ts
      | {key: ("ingress|" + $ts), value: (.ingress | map({key: .t, value: .v}) | from_entries)},
        {key: ("egress|" + $ts),  value: (.egress  | map({key: .t, value: .v}) | from_entries)}
    ) | from_entries) as $G
  | (if $d1 == null then null else
      ($d1 | group_by(.direction + "|" + .ts)
           | map({key: (.[0].direction + "|" + .[0].ts), value: (map({key: .tunnel_name, value: {v: .bit_rate, w: .written_at}}) | from_entries)})
           | from_entries) end) as $D
  | (if $gaps == null then {} else ($gaps | map({key: .ts, value: (if .confirmed_empty_at then "confirmed_empty" else "pending(\(.attempts))" end)}) | from_entries) end) as $GAPS
  | def changed($a; $b): (($a - $b) | fabs) > ([1, ($a | fabs) * 0.005] | max);
'

# ── population + revision table ─────────────────────────────────────────────
if [[ "$GQL" != "0" && ( "$VERBOSE" == "1" || "$MODE" == "range" ) ]]; then
STORE_LABEL=D1
if [[ "$(jq 'if . == null then 0 else length end' "$WORK/d1.json")" == "0" && "$(jq 'if . == null then 0 else length end' "$WORK/r2.json" 2>/dev/null || echo 0)" != "0" ]]; then STORE_LABEL=R2; fi
echo "== Per bucket: rows in $STORE_LABEL vs GraphQL now.  +N rows at source only, -N in $STORE_LABEL only, ~N value changed (>0.5%)"
jq -r --slurpfile gqlf "$WORK/gql.json" --slurpfile d1f "$WORK/d1.json" --slurpfile gapsf "$WORK/gaps_d1.json" --slurpfile r2f "$WORK/r2.json" \
  --rawfile buckets "$WORK/buckets.txt" --arg lbl "$STORE_LABEL" -n '
  ($gqlf[0]) as $gql | ($gapsf[0]) as $gaps
  | (if ($d1f[0] | if . == null then 0 else length end) == 0 and ($r2f[0] | if . == null then 0 else length end) > 0
     then ($r2f[0] | map({tunnel_name: .t, direction: .dir, ts: .ts, bit_rate: .v, written_at: null}))
     else $d1f[0] end) as $d1
  | '"$JQ_PRELUDE"'
  ($buckets | split("\n") | map(select(length > 0))) as $B
  | ([$gql[] | .errors[]] | unique) as $errs
  | ([$gql[] | select(.limit_hit) | .ts]) as $lim
  | (if ($errs | length) > 0 then "  GraphQL errors (\([$gql[] | select(.errors | length > 0)] | length) slice(s)): \($errs | join("; "))" else empty end),
    (if ($lim | length) > 0 then "  WARNING: 3000-row limit hit in \($lim | length) slice(s) — truncated like the collector" else empty end),
    (if $D == null then "  (no store rows for this range: only GraphQL counts shown)" else empty end),
    "  bucket                 | ingress: \($lbl | .[0:2])  GQL   +add  -rem  ~chg | egress:  \($lbl | .[0:2])  GQL   +add  -rem  ~chg | gap_buckets",
    ( $B[] | . as $ts
      | [ "ingress", "egress" ] | map(
          . as $dir | ($G[$dir + "|" + $ts] // {}) as $g | (if $D == null then null else ($D[$dir + "|" + $ts] // {}) end) as $d
          | if $d == null then "  -   \($g | length | pad(4))      -     -     -"
            else ($g | keys) as $gk | ($d | keys) as $dk
              | ($gk | map(select($d[.] == null)) | length) as $add | ($dk | map(select($g[.] == null)) | length) as $rem
              | ([ $gk[] | select($d[.] != null) | select(changed($g[.]; $d[.].v)) ] | length) as $chg
              | "\($d | length | pad(4)) \($g | length | pad(4))   \($add | pad(4))  \($rem | pad(4))  \($chg | pad(4))"
            end)
      | "  \($ts)  | \(.[0]) | \(.[1]) | \($GAPS[$ts] // "")" ),
    (if $D != null then
      ( [ $B[] as $ts | ["ingress","egress"][] as $dir
          | ($G[$dir + "|" + $ts] // {}) as $g | ($D[$dir + "|" + $ts] // {}) as $d
          | ($g | keys) as $gk | ($d | keys) as $dk
          | { d1: ($dk | length), gql: ($gk | length), add: ($gk | map(select($d[.] == null)) | length), rem: ($dk | map(select($g[.] == null)) | length),
              chg: ([ $gk[] | select($d[.] != null) | select(changed($g[.]; $d[.].v)) ] | length),
              gbits: ([ $g[] ] | add // 0), dbits: ([ $d[] | .v ] | add // 0) } ]
        | { d1: (map(.d1) | add), gql: (map(.gql) | add), add: (map(.add) | add), rem: (map(.rem) | add), chg: (map(.chg) | add),
            gbits: (map(.gbits) | add), dbits: (map(.dbits) | add) }
        | "  totals: \($lbl) rows \(.d1), source rows now \(.gql): +\(.add) only at source, -\(.rem) only in \($lbl), ~\(.chg) values changed"
          + (if .dbits > 0 then "; sum of bit rates now vs stored: \(((.gbits / .dbits - 1) * 10000 | round) / 100)%" else "" end) ),
      # Per-hour subtotals: an hour at or before a re-poll watermark should be
      # all zeros; an hour after it may differ until its pass runs.
      "  per hour (+at source only / -in \($lbl) only / ~changed):",
      ( [ $B[] as $ts | ["ingress","egress"][] as $dir
          | ($G[$dir + "|" + $ts] // {}) as $g | ($D[$dir + "|" + $ts] // {}) as $d
          | ($g | keys) as $gk | ($d | keys) as $dk
          | { h: ($ts | .[0:13]), add: ($gk | map(select($d[.] == null)) | length), rem: ($dk | map(select($g[.] == null)) | length),
              chg: ([ $gk[] | select($d[.] != null) | select(changed($g[.]; $d[.].v)) ] | length) } ]
        | group_by(.h) | .[] | "    \(.[0].h):00Z  +\(map(.add) | add)  -\(map(.rem) | add)  ~\(map(.chg) | add)" )
     else empty end)
' >"$WORK/pop.txt" 2>"$WORK/pop.err" || { echo "  population table failed:"; cat "$WORK/pop.err"; }
cat "$WORK/pop.txt"
echo
fi

if true; then
  echo
  echo "== R2 archive vs D1 per hour (rows in either store; -N in D1 but not R2, +N in R2 but not D1, ~N value differs >0.5%)"
  jq -r --slurpfile d1f "$WORK/d1.json" --slurpfile r2f "$WORK/r2.json" --rawfile hours "$(if [[ -s "$WORK/hours.txt" ]]; then echo "$WORK/hours.txt"; else echo /dev/null; fi)" \
     --arg rs "$RANGE_START" --arg re "$RANGE_END" -n '
    def pad($n): tostring | (" " * $n + .)[-$n:];
    def changed($a; $b): (($a - $b) | fabs) > ([1, ($a | fabs) * 0.005] | max);
    def epoch: (sub("Z$"; "") | strptime("%Y-%m-%dT%H:%M:%S") | mktime);
    def iso: strftime("%Y-%m-%dT%H:%M:%SZ");
    ($d1f[0]) as $d1 | ($r2f[0]) as $r2
    | if $r2 == null then "  R2 export unavailable"
      elif $d1 == null then "  D1 unavailable: R2 has \($r2 | length) rows in range"
      else
        ($d1 | map({key: (.tunnel_name + "|" + .direction + "|" + .ts), value: .bit_rate}) | from_entries) as $D
        | ($r2 | map({key: (.t + "|" + .dir + "|" + .ts), value: .v}) | from_entries) as $R
        | ([range((($rs | epoch) / 3600 | floor * 3600); ($re | epoch); 3600)] | map(iso | .[0:13])) as $H
        # One linear pass per store with object lookups: array subtraction in
        # jq is a linear search per element and never finishes at 200k rows.
        | ($D | keys_unsorted | map(select($R[.] == null))) as $missing
        | ($R | keys_unsorted | map(select($D[.] == null))) as $extra
        | ($D | keys_unsorted | map(select($R[.] != null and changed($R[.]; $D[.])))) as $diffs
        | def byhour: reduce .[] as $k ({}; .[$k[-20:-7]] += 1);
          ($D | keys_unsorted | byhour) as $dn | ($R | keys_unsorted | byhour) as $rn
        | ($missing | byhour) as $mn | ($extra | byhour) as $en | ($diffs | byhour) as $cn
        | "  hour              D1 rows  R2 rows  -D1only  +R2only  ~diff",
          ( $H[] as $h
            | "  \($h):00Z  \($dn[$h] // 0 | pad(7))  \($rn[$h] // 0 | pad(7))  \($mn[$h] // 0 | pad(7))  \($en[$h] // 0 | pad(7))  \($cn[$h] // 0 | pad(5))" ),
          "  totals: D1 \($D | length), R2 \($R | length), missing from R2 \($missing | length), only in R2 \($extra | length), value differs \($diffs | length)",
          (if ($missing | length) > 0 then "  sample missing: " + ($missing | sort | .[0:5] | join("  ")) else empty end),
          (if ($extra | length) > 0 then "  sample R2-only: " + ($extra | sort | .[0:5] | join("  ")) else empty end)
      end
  '
  echo
fi

[[ "$MODE" == "range" ]] && exit 0

GQL_TOTAL_ROWS=$(jq '[.[] | (.ingress | length) + (.egress | length)] | add // 0' "$WORK/gql.json")
D1_ROWS_IN_RANGE=$(jq 'if . == null then -1 else length end' "$WORK/d1.json")
R2_ROWS_IN_RANGE=$(jq 'if . == null then -1 else length end' "$WORK/r2.json")

[[ "$VERBOSE" == "1" ]] && echo "== Per reported gap: bucket × source (. = no row; > = inside the reported gap).  D1 shows value@+minutes after bucket"
: >"$WORK/summary.jsonl"
while IFS=$'\t' read -r idx tunnel dir ws we last_seen gap_min before; do
  if [[ "$VERBOSE" == "1" ]]; then
    echo
    echo "-- [$idx] $tunnel $dir   reported $([[ "$before" == "1" ]] && echo "resumed at" || echo "last seen") $last_seen, gap ${gap_min}m   window $ws -> $we"
  fi
  jq -r --slurpfile gqlf "$WORK/gql.json" --slurpfile d1f "$WORK/d1.json" --slurpfile gapsf "$WORK/gaps_d1.json" --slurpfile r2f "$WORK/r2.json" \
     --arg s "$ws" --arg e "$we" --arg dir "$dir" --arg ls "$last_seen" --argjson gap "$gap_min" \
     --arg idx "$idx" --arg tunnel "$tunnel" --argjson before "$before" --argjson verbose "$VERBOSE" \
     --argjson gql_ran "$([[ "$GQL" == "0" ]] && echo 0 || echo 1)" --argjson gql_total "$GQL_TOTAL_ROWS" -n '
    ($gqlf[0]) as $gql | ($d1f[0]) as $d1 | ($gapsf[0]) as $gaps
    | (if $r2f[0] == null then null else ($r2f[0] | map(select(.t == $tunnel))) end) as $r2
    | '"$JQ_PRELUDE"'
    def fmt: if . == null then "." else (. | round | tostring) end;
    ($s | epoch) as $se | ($e | epoch) as $ee
    | ($ls | epoch) as $lse
    # Consumer shape: gap N is measured from the last row'"'"'s bucket to the
    # resume bucket, so the first missing bucket is T - N + 5m.
    | (if $before == 1 then $lse - $gap * 60 + 300 else $lse + 300 end) as $miss_start
    | (if $before == 1 then $lse else $lse + $gap * 60 end) as $miss_end
    | (if $r2 == null then null else ($r2 | map(select(.dir == $dir)) | map({key: .ts, value: .v}) | from_entries) end) as $R
    | ($gql_ran == 1 and $gql_total > 0) as $source_ok
    | ( [range($se; $ee; 300)] | map(
          iso as $ts
          | ($G[$dir + "|" + $ts] // {})[$tunnel] as $gv
          | (if $D == null then null else ($D[$dir + "|" + $ts] // {})[$tunnel] end) as $dv
          | (if $R == null then null else $R[$ts] end) as $rv
          | (($ts | epoch) >= $miss_start and ($ts | epoch) < $miss_end) as $rep
          | ($dv != null or $rv != null) as $stored
          | (if $stored then
               (if $rep then "STORED" else "" end)
               + (if $dv == null then " (R2 only)" else "" end)
               + (if $source_ok and $gv == null then " (source dropped it)"
                  elif $gv != null and changed($gv; (if $dv != null then $dv.v else $rv end)) then " (~value)"
                  else "" end)
             elif $gv != null then "RECOVERABLE"
             elif $rep then (if $source_ok then "NONE" else "NOT STORED (source unavailable)" end)
             else "" end | ltrimstr(" ")) as $class
          | { ts: $ts, rep: $rep, stored: $stored, gv: $gv, dv: $dv, rv: $rv, class: $class,
              line: ("  \($ts)  \(if $rep then ">" else " " end) \($gv | fmt | pad(8))  \(if $dv == null then "." else "\($dv.v | fmt)@+\((($dv.w | epoch) - ($ts | epoch)) / 60 | floor)m" end | (. + "                  ")[0:18])  \($rv | fmt | pad(8))  \($class)") }
        )) as $rows
    | (if $verbose == 1 then "  bucket                  GQL now   D1 (arrived)       R2        class", ($rows[] | .line) else empty end),
      ( ($rows | map(select(.rep))) as $rep
        | { idx: $idx, tunnel: $tunnel, dir: $dir,
            miss_start: ($miss_start | iso), miss_end: ($miss_end | iso),
            n: ($rep | length),
            stored: ($rep | map(select(.stored)) | length),
            recoverable: ($rep | map(select((.stored | not) and .gv != null)) | length),
            none: ($rep | map(select((.stored | not) and .gv == null)) | length),
            source_ok: $source_ok,
            recoverable_ts: [$rep[] | select((.stored | not) and .gv != null) | .ts],
            dropped: ($rows | map(select(.stored and $source_ok and .gv == null)) | length),
            stored_lag_max_min: ([$rep[] | select(.stored and .dv != null) | ((.dv.w | epoch) - (.ts | epoch)) / 60] | max) }
        | "@@" + tojson )
  ' | { while IFS= read -r l; do if [[ "$l" == @@* ]]; then echo "${l#@@}" >>"$WORK/summary.jsonl"; else echo "$l"; fi; done; }
done <"$WORK/gaps.tsv"

# ── verdict ─────────────────────────────────────────────────────────────────
echo
echo "== Verdict per reported gap (stored = D1 or R2; recoverable = at Cloudflare now, not stored; none = nowhere)"
jq -rs --argjson d1n "$D1_ROWS_IN_RANGE" --argjson r2n "$R2_ROWS_IN_RANGE" --argjson gql_total "$GQL_TOTAL_ROWS" \
   --argjson gql_ran "$([[ "$GQL" == "0" ]] && echo 0 || echo 1)" '
  def epoch: (sub("Z$"; "") | strptime("%Y-%m-%dT%H:%M:%S") | mktime);
  def iso: strftime("%Y-%m-%dT%H:%M:%SZ");
  def pad($n): tostring | (" " * $n + .)[-$n:];
  def rpad($n): tostring | (. + (" " * $n))[0:$n];
  def verdict:
    if .n == 0 then "EMPTY WINDOW"
    elif .source_ok | not then (if .stored == .n then "IN OUR STORES" elif .stored > 0 then "PARTLY IN OUR STORES; source unavailable" else "NOT STORED; source unavailable" end)
    elif .stored == .n then "IN OUR STORES"
    elif .recoverable == .n then "RECOVERABLE (backfill)"
    elif .none == .n then "LEGIT (nowhere)"
    elif .stored > 0 then "PARTLY IN OUR STORES (\(.stored) stored, \(.recoverable) recoverable, \(.none) nowhere)"
    else "PARTLY RECOVERABLE (\(.recoverable) recoverable, \(.none) nowhere)" end;
  (if $gql_ran == 0 then "  NOTE: GraphQL pass skipped (GQL=0): cannot tell RECOVERABLE from LEGIT"
   elif $gql_total == 0 then "  NOTE: Cloudflare returned no rows for the whole range (beyond its retention, or wrong token/account): cannot tell RECOVERABLE from LEGIT"
   else empty end),
  (if $d1n == -1 then "  NOTE: D1 unavailable (wrangler failed); stored = R2 only"
   elif $d1n == 0 and $r2n > 0 then "  NOTE: D1 has no rows for this range (aged out, 7-day retention); stored = R2"
   elif $d1n == 0 and $r2n == 0 then "  NOTE: neither D1 (7-day retention) nor R2 (6-month retention) has any rows for this range"
   elif $r2n == -1 then "  NOTE: R2 unavailable; stored = D1 only" else empty end),
  "  \("#" | pad(3))  \("tunnel" | rpad(35))  \("dir" | rpad(7))  \("missing window (UTC)" | rpad(25))  bkts stored recov none  verdict",
  ( .[] | "  \(.idx | pad(3))  \(.tunnel | rpad(35))  \(.dir | rpad(7))  \(.miss_start[0:10] + " " + .miss_start[11:16] + " -> " + .miss_end[11:16] | rpad(25))  \(.n | pad(4)) \(.stored | pad(6)) \(.recoverable | pad(5)) \(.none | pad(4))  \(verdict)" ),
  "",
  ( length as $total
    | group_by(verdict | split(" (")[0]) | map("\(length) \(.[0] | verdict | split(" (")[0])")
    | "  overall: \($total) gap(s): " + join(", ") ),
  (if ([.[] | .stored_lag_max_min | select(. != null)] | length) > 0 then
     "  stored rows arrived at most \([.[] | .stored_lag_max_min | select(. != null)] | max | floor)m after their bucket — collector was on time; if the consumer lacks them, check its export timing (R2 hour is final at H+2h) or the report'"'"'s timestamp semantics (GAP_BEFORE)" else empty end),
  (if ([.[] | .dropped] | add) > 0 then "  \([.[] | .dropped] | add) stored row(s) in these windows are no longer returned by Cloudflare — it revises this dataset after collection; our copy is the earlier one" else empty end),
  ([.[] | .recoverable_ts[]] | unique) as $rec
  | if ($rec | length) == 0 then "  nothing to backfill"
    else "  \($rec | length) bucket(s) in these windows exist at Cloudflare but not in our stores. Backfill (re-fetches every tunnel for the hour; revised values overwrite):",
         ($rec | map(epoch / 3600 | floor * 3600) | unique | .[] | "    ./scripts/backfill.sh \(iso) \(. + 3600 | iso)")
    end
' "$WORK/summary.jsonl"
