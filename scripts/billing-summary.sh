#!/usr/bin/env bash
# billing-summary.sh — Print a text summary of billing-grade p95 stats.
#
# Calls GET /api/billing on the worker and prints last month's p95 and the
# current month-to-date p95, ingress and egress in separate columns.
#
# Usage:
#   ./scripts/billing-summary.sh            # human-readable table (Mbps/Gbps)
#   ./scripts/billing-summary.sh --raw      # same table, values in bps
#   ./scripts/billing-summary.sh --json     # pass through the API JSON
#
# Required environment variables:
#   WORKER_URL      e.g. https://tf-cf-wanstats.<subdomain>.workers.dev
#
# Optional (required when the worker hostname is behind Cloudflare Access):
#   CF_ACCESS_CLIENT_ID      Access service token client ID
#   CF_ACCESS_CLIENT_SECRET  Access service token client secret
#
# /api/billing has no token check of its own — Access handles auth at the
# edge. Requires jq.

set -euo pipefail

MODE="table"
case "${1:-}" in
  "") ;;
  --raw)  MODE="raw" ;;
  --json) MODE="json" ;;
  -h|--help)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 0 ;;
  *)
    echo "Unknown option: $1 (use --raw, --json, or --help)" >&2
    exit 1 ;;
esac

if [[ -z "${WORKER_URL:-}" ]]; then
  echo "Error: WORKER_URL is not set" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required (brew install jq)" >&2
  exit 1
fi

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

# -sS: quiet on success but still print curl's own error (DNS, TLS,
# connection refused). -w appends the HTTP status so a redirect to the
# Access login page (HTML, not JSON) is reported instead of parsed.
response=$(curl -sS -w '\n%{http_code}' "${WORKER_URL}/api/billing" \
  ${ACCESS_HEADERS[@]+"${ACCESS_HEADERS[@]}"}) || {
  echo "Error: curl failed (exit $?) for ${WORKER_URL} — check WORKER_URL, network, and TLS" >&2
  exit 1
}

http_code="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$http_code" != "200" ]]; then
  echo "Error: HTTP ${http_code} from ${WORKER_URL}/api/billing" >&2
  if [[ "$http_code" == "302" || "$http_code" == "403" ]]; then
    echo "  Looks like Cloudflare Access — set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET" >&2
  fi
  exit 1
fi

if ! echo "$body" | jq -e '.current and .previous' >/dev/null 2>&1; then
  echo "Error: unexpected response from /api/billing:" >&2
  echo "$body" | head -c 500 >&2
  echo >&2
  exit 1
fi

if [[ "$MODE" == "json" ]]; then
  echo "$body" | jq .
  exit 0
fi

# Same thresholds as the dashboard's formatBps(). Null p95 (no data for the
# period yet, or the midnight billing run hasn't happened) prints as N/A.
echo "$body" | jq -r --arg mode "$MODE" '
  def na: if . == null then "N/A" else . end;
  def show:
    if . == null then "N/A"
    elif $mode == "raw" then tostring
    elif . >= 1e9 then (. / 1e9 * 100 | round / 100 | tostring) + " Gbps"
    elif . >= 1e6 then (. / 1e6 * 100 | round / 100 | tostring) + " Mbps"
    elif . >= 1e3 then (. / 1e3 * 100 | round / 100 | tostring) + " Kbps"
    else (round | tostring) + " bps" end;
  [
    ["Period", "Ingress p95", "Egress p95", "Computed at"],
    ["Last month (" + .previous.period + ")",
      (.previous.p95_ingress_bps | show), (.previous.p95_egress_bps | show),
      (.previous.computed_at | na)],
    ["Month to date (" + .current.period + ")",
      (.current.p95_ingress_bps | show), (.current.p95_egress_bps | show),
      (.current.computed_at | na)]
  ] | .[] | @tsv
' | column -t -s $'\t'
