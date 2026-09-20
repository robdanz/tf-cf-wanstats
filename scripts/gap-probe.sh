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
#       Explain reported gaps. Each bucket the consumer is missing is classed:
#         NOT_AT_SOURCE   absent from GraphQL now and from D1 — Cloudflare has
#                         no row for that tunnel/bucket. Nothing to backfill.
#         AT_SOURCE_NOW   GraphQL has it now, D1 does not — it arrived (or was
#                         revised in) after the collector's last look. backfill.sh
#                         over that hour stores it; commands are printed.
#         STORED          D1 has the row — the collector delivered; the
#                         consumer did not pick it up (check its
#                         /api/current?since= paging loops on `truncated`).
#       Other buckets in the window are marked REMOVED_AT_SOURCE when D1 has
#       a row GraphQL no longer returns, and ~ when the value differs.
#
#   ./scripts/gap-probe.sh <start-iso> <end-iso>
#       Audit only: per-bucket population and revision table for the range
#       (max 24h). Use this to size how much the source changes after the
#       fact at the customer's tunnel count.
#
# gaps-file: one gap per line, either
#   tunnel,direction,<last-seen ISO 8601>,<gap minutes>
# or the consumer export shape (dd-mm-yyyy and h:mm:ss duration):
#   tunnel,direction,dd-mm-yyyy,HH:MM:SS,<last value>,H:MM:SS
# Blank lines and lines starting with # are ignored. Times are taken as UTC;
# set TZ_OFFSET_MIN if the consumer reported local time (e.g. -120 for UTC+2).
# pad-minutes (default 30) widens each window on both sides.
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
    else
      last_seen="${f3// }"; gap_min="${f4// }"
    fi
    if [[ "$f2" != "ingress" && "$f2" != "egress" ]] || ! is_iso "$last_seen"; then
      echo "skip: cannot parse '$line'" >&2; continue
    fi
    ls_epoch=$(( $(to_epoch "$last_seen") - TZ_OFFSET_MIN * 60 ))
    ws=$(floor5 $(( ls_epoch - PAD_MIN * 60 )))
    we=$(ceil5  $(( ls_epoch + gap_min * 60 + PAD_MIN * 60 + 300 )))
    n=$((n + 1))
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "$f1" "$f2" "$(to_iso "$ws")" "$(to_iso "$we")" "$(to_iso "$ls_epoch")" "$gap_min" >>"$WORK/gaps.tsv"
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
    cat "$WORK"/d1/*.json | jq -sc 'add' >"$WORK/d1.json"
    d1_query "SELECT ts, attempts, first_detected, confirmed_empty_at FROM gap_buckets WHERE ts >= '$RANGE_START' AND ts < '$RANGE_END' ORDER BY ts" >"$WORK/gaps_d1.json"
  fi
fi
[[ "$D1_OK" == true ]] || { echo null >"$WORK/d1.json"; echo null >"$WORK/gaps_d1.json"; }
echo

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
if [[ "$GQL" != "0" ]]; then
echo "== Per bucket: rows in D1 vs GraphQL now.  +N rows at source only, -N in D1 only, ~N value changed (>0.5%)"
jq -r --slurpfile gqlf "$WORK/gql.json" --slurpfile d1f "$WORK/d1.json" --slurpfile gapsf "$WORK/gaps_d1.json" \
  --rawfile buckets "$WORK/buckets.txt" -n '
  ($gqlf[0]) as $gql | ($d1f[0]) as $d1 | ($gapsf[0]) as $gaps
  | '"$JQ_PRELUDE"'
  ($buckets | split("\n") | map(select(length > 0))) as $B
  | ([$gql[] | .errors[]] | unique) as $errs
  | ([$gql[] | select(.limit_hit) | .ts]) as $lim
  | (if ($errs | length) > 0 then "  GraphQL errors (\([$gql[] | select(.errors | length > 0)] | length) slice(s)): \($errs | join("; "))" else empty end),
    (if ($lim | length) > 0 then "  WARNING: 3000-row limit hit in \($lim | length) slice(s) — truncated like the collector" else empty end),
    (if $D == null then "  (D1 unavailable: only GraphQL counts shown)" else empty end),
    "  bucket                 | ingress: D1  GQL   +add  -rem  ~chg | egress:  D1  GQL   +add  -rem  ~chg | gap_buckets",
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
        | "  totals: D1 rows \(.d1), source rows now \(.gql): +\(.add) only at source, -\(.rem) only in D1, ~\(.chg) values changed"
          + (if .dbits > 0 then "; sum of bit rates now vs stored: \(((.gbits / .dbits - 1) * 10000 | round) / 100)%" else "" end) )
     else empty end)
' >"$WORK/pop.txt" 2>"$WORK/pop.err" || { echo "  population table failed:"; cat "$WORK/pop.err"; }
cat "$WORK/pop.txt"
echo
fi

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
        | ([range(($rs | epoch); ($re | epoch); 3600)] | map(iso | .[0:13])) as $H
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

echo "== Per reported gap: bucket × source (. = no row; > = inside the reported gap).  D1 shows value@+minutes after bucket"
: >"$WORK/summary.jsonl"
while IFS=$'\t' read -r idx tunnel dir ws we last_seen gap_min; do
  echo
  echo "-- [$idx] $tunnel $dir   reported last seen $last_seen, gap ${gap_min}m   window $ws -> $we"
  jq -r --slurpfile gqlf "$WORK/gql.json" --slurpfile d1f "$WORK/d1.json" --slurpfile gapsf "$WORK/gaps_d1.json" --slurpfile r2f "$WORK/r2.json" \
     --arg s "$ws" --arg e "$we" --arg dir "$dir" --arg ls "$last_seen" --argjson gap "$gap_min" \
     --arg idx "$idx" --arg tunnel "$tunnel" -n '
    ($gqlf[0]) as $gql | ($d1f[0]) as $d1 | ($gapsf[0]) as $gaps
    | (if $r2f[0] == null then null else ($r2f[0] | map(select(.t == $tunnel))) end) as $r2
    | '"$JQ_PRELUDE"'
    def fmt: if . == null then "." else (. | round | tostring) end;
    ($s | epoch) as $se | ($e | epoch) as $ee
    | ($ls | epoch) as $lse | ($lse + 300) as $miss_start | ($lse + $gap * 60) as $miss_end
    | (if $r2 == null then null else ($r2 | map(select(.dir == $dir)) | map({key: .ts, value: .v}) | from_entries) end) as $R
    | "  bucket                  GQL now   D1 (arrived)       R2        class",
      ( [range($se; $ee; 300)] | map(
          iso as $ts
          | ($G[$dir + "|" + $ts] // {})[$tunnel] as $gv
          | (if $D == null then null else ($D[$dir + "|" + $ts] // {})[$tunnel] end) as $dv
          | (if $R == null then null else $R[$ts] end) as $rv
          | (($ts | epoch) >= $miss_start and ($ts | epoch) < $miss_end) as $rep
          | (if $D == null then
               (if $gv != null then "at_source" elif $rv != null then "r2_only" elif $rep then "NOT_AT_SOURCE?" else "" end)
             elif $dv != null then
               (if $gv == null then "REMOVED_AT_SOURCE" elif changed($gv; $dv.v) then "~" else "" end) + (if $rep then " STORED" else "" end)
             elif $gv != null then "AT_SOURCE_NOW"
             elif $rv != null then "R2_ONLY"
             elif $rep then "NOT_AT_SOURCE" else "" end) as $class
          | { ts: $ts, rep: $rep, class: ($class | ltrimstr(" ")), gv: $gv, dv: $dv,
              line: ("  \($ts)  \(if $rep then ">" else " " end) \($gv | fmt | pad(8))  \(if $dv == null then "." else "\($dv.v | fmt)@+\((($dv.w | epoch) - ($ts | epoch)) / 60 | floor)m" end | (. + "                  ")[0:18])  \($rv | fmt | pad(8))  \($class | ltrimstr(" "))") }
        )) as $rows
    | ($rows[] | .line),
      ({ idx: $idx, tunnel: $tunnel, dir: $dir, d1_available: ($D != null),
         reported: ($rows | map(select(.rep)) | group_by(.class) | map({key: .[0].class, value: length}) | from_entries),
         at_source_now: [$rows[] | select(.class == "AT_SOURCE_NOW") | .ts],
         removed: [$rows[] | select(.class | startswith("REMOVED")) | .ts],
         r2_only: [$rows[] | select(.class == "R2_ONLY") | .ts],
         stored_lag_max_min: ([$rows[] | select(.rep and .dv != null) | ((.dv.w | epoch) - (.ts | epoch)) / 60] | max) } | "@@" + tojson)
  ' | { while IFS= read -r l; do if [[ "$l" == @@* ]]; then echo "${l#@@}" >>"$WORK/summary.jsonl"; else echo "$l"; fi; done; }
done <"$WORK/gaps.tsv"

# ── summary ─────────────────────────────────────────────────────────────────
echo
echo "== Summary"
jq -rs '
  def epoch: (sub("Z$"; "") | strptime("%Y-%m-%dT%H:%M:%S") | mktime);
  def iso: strftime("%Y-%m-%dT%H:%M:%SZ");
  (map(.reported | to_entries[]) | group_by(.key) | map("\(.[0].key)=\(map(.value) | add)") | join("  ")) as $totals
  | "  reported buckets by class: \($totals)",
    (if (map(select(.d1_available | not)) | length) > 0 then "  NOTE: D1 unavailable; classes marked ? are GraphQL/R2 only" else empty end),
    (if ([.[] | .stored_lag_max_min | select(. != null)] | length) > 0 then
       "  STORED: collector has rows for reported buckets (max arrival lag \([.[] | .stored_lag_max_min | select(. != null)] | max | floor)m after bucket) — check the consumer'"'"'s since/truncated paging" else empty end),
    (if ([.[] | .removed[]] | length) > 0 then "  REMOVED_AT_SOURCE: \([.[] | .removed[]] | length) bucket(s) in these windows have a D1 row the source no longer returns — Cloudflare revises after collection" else empty end),
    (if ([.[] | .r2_only[]] | length) > 0 then "  R2_ONLY: \([.[] | .r2_only[]] | length) bucket(s) in the archive but not D1 (purged, or D1 write lost); export/billing unaffected" else empty end),
    ([.[] | .at_source_now[]] | unique) as $late
    | if ($late | length) == 0 then "  AT_SOURCE_NOW: none — nothing to backfill"
      else "  AT_SOURCE_NOW: \($late | length) bucket(s) exist at Cloudflare but not in D1. Backfill these hours (re-fetches every tunnel; revised values overwrite stored ones):",
           ($late | map(epoch / 3600 | floor * 3600) | unique | .[] | "    ./scripts/backfill.sh \(iso) \(. + 3600 | iso)")
      end
' "$WORK/summary.jsonl"
