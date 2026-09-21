#!/usr/bin/env bash
# query-shape-probe.sh — Does Cloudflare's GraphQL API answer the worker's
# exact request differently from an equivalent one? Sends three requests
# for one 5-minute slice and compares the row sets:
#   A  the worker's exact query text and variables (as collect/repoll send it)
#   B  the same query with a unique comment appended (cache-buster)
#   C  an equivalently filtered query in different wording (gap-probe's)
# If A differs from B and C, the API served a cached response for the
# worker's request body. If all three agree, the worker sees what everyone
# else sees.
#
# Usage: ./scripts/query-shape-probe.sh <slice-start ISO, e.g. 2026-09-20T00:00:00Z>
# Env:   CLOUDFLARE_API_TOKEN (Analytics read), ACCOUNT_ID

set -euo pipefail
START="${1:?slice start ISO required}"
: "${CLOUDFLARE_API_TOKEN:?}"; : "${ACCOUNT_ID:?}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

to_epoch() { TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" "+%s" 2>/dev/null || date -u -d "$1" "+%s"; }
to_iso()   { date -u -r "$1" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "@$1" "+%Y-%m-%dT%H:%M:%SZ"; }
S_MS="${START/Z/.000Z}"; E="$(to_iso $(( $(to_epoch "$START") + 300 )))"; E_MS="${E/Z/.000Z}"

# Worker query text, extracted from graphql.ts exactly as buildQuery(3000) renders it.
WQ=$(node -e '
const fs=require("fs");const src=fs.readFileSync(process.argv[1],"utf8");
const m=src.match(/function buildQuery\(limit: number\): string \{\n  return `([\s\S]*?)`;\n\}/);
process.stdout.write(m[1].replace(/\$\{limit\}/g,"3000"));' "$SCRIPT_DIR/../worker/src/graphql.ts")
PQ='query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){ingress:magicTransitNetworkAnalyticsAdaptiveGroups(limit:3000,orderBy:[datetimeFiveMinutes_ASC],filter:{datetime_geq:$s,datetime_lt:$e,ingressTunnelName_notin:["","device_id"]}){avg{bitRateFiveMinutes} dimensions{datetimeFiveMinutes ingressTunnelName}} egress:magicTransitNetworkAnalyticsAdaptiveGroups(limit:3000,orderBy:[datetimeFiveMinutes_ASC],filter:{datetime_geq:$s,datetime_lt:$e,egressTunnelName_notin:["","device_id"]}){avg{bitRateFiveMinutes} dimensions{datetimeFiveMinutes egressTunnelName}}}}}'

run() { # $1 label, $2 body
  curl -sS https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H 'Content-Type: application/json' --data "$2" \
  | jq -c --arg l "$1" '(.data.viewer.accounts[0] // {}) as $x
      | { label: $l, errors: ((.errors // []) | map(.message)),
          rows: ((($x.ingress // []) | map("i|\(.dimensions.ingressTunnelName)|\(.avg.bitRateFiveMinutes)")) + (($x.egress // []) | map("e|\(.dimensions.egressTunnelName)|\(.avg.bitRateFiveMinutes)")) | sort) }'
}
A=$(run A "$(jq -cn --arg q "$WQ" --arg a "$ACCOUNT_ID" --arg s "$S_MS" --arg e "$E_MS" '{query:$q,variables:{accountTag:$a,datetimeStart:$s,datetimeEnd:$e}}')")
B=$(run B "$(jq -cn --arg q "$WQ
# nonce $(date +%s%N)" --arg a "$ACCOUNT_ID" --arg s "$S_MS" --arg e "$E_MS" '{query:$q,variables:{accountTag:$a,datetimeStart:$s,datetimeEnd:$e}}')")
C=$(run C "$(jq -cn --arg q "$PQ" --arg a "$ACCOUNT_ID" --arg s "$START" --arg e "$E" '{query:$q,variables:{a:$a,s:$s,e:$e}}')")

echo "slice $START -> $E   account $ACCOUNT_ID   now $(to_iso "$(date +%s)")"
jq -rn --argjson A "$A" --argjson B "$B" --argjson C "$C" '
  def n: .rows | length;
  def sum: [.rows[] | split("|")[2] | tonumber] | add // 0;
  ([$A,$B,$C][] | "  \(.label): rows=\(n)  sum_bps=\(sum | floor)  errors=\(.errors | join("; "))"),
  "",
  (if ($A.rows == $B.rows and $B.rows == $C.rows) then "  ALL SAME: the worker'"'"'s request is served the same data as any other wording"
   else
     "  DIFFERENT:",
     "    A vs B (same query, nonce comment): \(($A.rows - $B.rows) | length) only in A, \(($B.rows - $A.rows) | length) only in B",
     "    A vs C (different wording):        \(($A.rows - $C.rows) | length) only in A, \(($C.rows - $A.rows) | length) only in C",
     "    B vs C:                            \(($B.rows - $C.rows) | length) only in B, \(($C.rows - $B.rows) | length) only in C",
     (if $A.rows != $B.rows and $B.rows == $C.rows then "  => the API is caching the worker'"'"'s exact request body; a cache-buster fixes it" else empty end)
   end)'
