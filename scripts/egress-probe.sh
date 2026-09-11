#!/usr/bin/env bash
# egress-probe.sh — Compute aggregate p95 Mbps for one period under several
# candidate definitions of "ingress" and "egress", straight from GraphQL.
#
# Use this to find which definition an external/billing figure corresponds
# to. Each definition is one GraphQL query per period, grouped by 5-minute
# bucket with sum{bits}; p95 is taken over the per-bucket sums (the same
# method as /api/billing).
#
# Usage:
#   ./scripts/egress-probe.sh 2026-08-01T00:00:00Z 2026-09-01T00:00:00Z
#
# Required environment variables:
#   CLOUDFLARE_API_TOKEN  token with Account Analytics: Read (the worker's
#                         WAN_API_TOKEN / terraform.tfvars wan_api_token works)
#   ACCOUNT_ID            Cloudflare account ID
#
# Requires curl and jq.

set -euo pipefail

START="${1:-}"; END="${2:-}"
if [[ -z "$START" || -z "$END" ]]; then echo "Usage: $0 <start-iso> <end-iso>" >&2; exit 1; fi
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is not set}"
: "${ACCOUNT_ID:?ACCOUNT_ID is not set}"

# name|filter-fragment (GraphQL filter object body, without datetime bounds)
DEFS=(
  "A  ours: ingressTunnelName set               |ingressTunnelName_notin: [\"\", \"device_id\"]"
  "B  ours: egressTunnelName set                |egressTunnelName_notin: [\"\", \"device_id\"]"
  "C  direction=ingress (all)                   |direction: \"ingress\""
  "D  direction=egress (all)                    |direction: \"egress\""
  "E  direction=ingress, onRamp GRE/IPsec       |direction: \"ingress\", onRamp_in: [\"GRE\", \"IPsec\"]"
  "F  direction=egress, offRamp GRE/IPsec       |direction: \"egress\", offRamp_in: [\"GRE\", \"IPsec\"]"
  "G  direction=egress, onRamp GRE/IPsec        |direction: \"egress\", onRamp_in: [\"GRE\", \"IPsec\"]"
  "H  site -> Public Internet                   |ingressTunnelName_notin: [\"\", \"device_id\"], offRamp: \"Public Internet\""
  "I  Public Internet -> site                   |egressTunnelName_notin: [\"\", \"device_id\"], onRamp: \"Public Internet\""
  "J  WARP/Gateway -> site                      |egressTunnelName_notin: [\"\", \"device_id\"], onRamp_in: [\"WARP\", \"Gateway\"]"
  "K  site -> site                              |ingressTunnelName_notin: [\"\", \"device_id\"], egressTunnelName_notin: [\"\", \"device_id\"]"
  "L  offRamp Public Internet (all)             |offRamp: \"Public Internet\""
  "M  onRamp Public Internet (all)              |onRamp: \"Public Internet\""
)

query_p95() {
  local filter="$1"
  local q="query(\$a:String!,\$s:Time!,\$e:Time!){ viewer { accounts(filter:{accountTag:\$a}) {
    rows: magicTransitNetworkAnalyticsAdaptiveGroups(limit: 10000, orderBy: [datetimeFiveMinutes_ASC],
      filter:{datetime_geq:\$s, datetime_lt:\$e, ${filter}}) {
      dimensions { datetimeFiveMinutes } sum { bits } } } } }"
  local body
  body=$(jq -cn --arg q "$q" --arg a "$ACCOUNT_ID" --arg s "$START" --arg e "$END" '{query:$q, variables:{a:$a, s:$s, e:$e}}')
  local resp
  resp=$(curl -sS https://api.cloudflare.com/client/v4/graphql \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H 'Content-Type: application/json' --data "$body")
  if echo "$resp" | jq -e '.errors and (.errors|length>0)' >/dev/null; then
    echo "ERROR: $(echo "$resp" | jq -c '.errors[0].message')"
    return
  fi
  # p95 over per-bucket Mbps (bits / 300 s). Buckets with no rows are absent,
  # not zero — same as the worker's R2-based computation.
  echo "$resp" | jq -r '
    [.data.viewer.accounts[0].rows[] | (.sum.bits / 300 / 1e6)] as $v
    | if ($v|length) == 0 then "no rows"
      else ($v | sort) as $s | ($s|length) as $n
        | "p95=\(($s[(($n * 0.95)|ceil) - 1] * 100 | round) / 100) Mbps  buckets=\($n)  max=\(($s[$n-1]*100|round)/100)"
      end'
}

echo "Period: $START -> $END   account: $ACCOUNT_ID"
echo
for def in "${DEFS[@]}"; do
  name="${def%%|*}"; filter="${def#*|}"
  printf "%-46s %s\n" "$name" "$(query_p95 "$filter")"
done
