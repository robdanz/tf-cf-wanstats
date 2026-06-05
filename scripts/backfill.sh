#!/usr/bin/env bash
# backfill.sh — Backfill WAN metrics for a historical date range.
#
# Calls POST /api/backfill on the worker for each hour in the range.
# Each request is one hour of data — safe within GraphQL and Worker limits.
# INSERT OR REPLACE in the worker makes re-runs idempotent.
#
# Usage:
#   ./scripts/backfill.sh <start> <end>
#
# Arguments:
#   start  ISO 8601 datetime, e.g. 2026-06-01T00:00:00Z
#   end    ISO 8601 datetime, e.g. 2026-06-05T00:00:00Z
#
# Required environment variables:
#   WORKER_URL      e.g. https://tf-cf-wanstats.<subdomain>.workers.dev
#   BACKFILL_TOKEN  value from terraform.tfvars
#
# Example:
#   export WORKER_URL=https://tf-cf-wanstats.mysubdomain.workers.dev
#   export BACKFILL_TOKEN=<your-token>
#   ./scripts/backfill.sh 2026-06-01T00:00:00Z 2026-06-05T00:00:00Z

set -euo pipefail

START="${1:-}"
END="${2:-}"

if [[ -z "$START" || -z "$END" ]]; then
  echo "Usage: $0 <start-iso> <end-iso>" >&2
  exit 1
fi

if [[ -z "${WORKER_URL:-}" ]]; then
  echo "Error: WORKER_URL is not set" >&2
  exit 1
fi

if [[ -z "${BACKFILL_TOKEN:-}" ]]; then
  echo "Error: BACKFILL_TOKEN is not set" >&2
  exit 1
fi

# Convert ISO 8601 to epoch seconds (macOS date)
to_epoch() {
  date -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" "+%s" 2>/dev/null \
    || date -d "$1" "+%s"  # Linux fallback
}

# Convert epoch seconds back to ISO 8601
to_iso() {
  date -u -r "$1" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
    || date -u -d "@$1" "+%Y-%m-%dT%H:%M:%SZ"  # Linux fallback
}

start_epoch=$(to_epoch "$START")
end_epoch=$(to_epoch "$END")

if [[ "$start_epoch" -ge "$end_epoch" ]]; then
  echo "Error: start must be before end" >&2
  exit 1
fi

HOUR=3600
current=$start_epoch

echo "Backfilling from $START to $END"
echo "Worker: $WORKER_URL"
echo ""

total_ingress=0
total_egress=0
windows=0

while [[ "$current" -lt "$end_epoch" ]]; do
  window_start=$(to_iso "$current")
  next=$((current + HOUR))
  if [[ "$next" -gt "$end_epoch" ]]; then
    next=$end_epoch
  fi
  window_end=$(to_iso "$next")

  printf "  %s → %s ... " "$window_start" "$window_end"

  response=$(curl -s -X POST \
    "${WORKER_URL}/api/backfill?start=${window_start}&end=${window_end}" \
    -H "X-Backfill-Token: ${BACKFILL_TOKEN}")

  if echo "$response" | grep -q '"ingress_rows"'; then
    in_rows=$(echo "$response" | sed 's/.*"ingress_rows":\([0-9]*\).*/\1/')
    eg_rows=$(echo "$response" | sed 's/.*"egress_rows":\([0-9]*\).*/\1/')
    echo "ingress=${in_rows} egress=${eg_rows}"
    total_ingress=$((total_ingress + in_rows))
    total_egress=$((total_egress + eg_rows))
    windows=$((windows + 1))
  else
    echo "ERROR"
    echo "    Response: $response" >&2
    exit 1
  fi

  current=$next
done

echo ""
echo "Done. ${windows} windows processed."
echo "Total rows upserted: ingress=${total_ingress} egress=${total_egress}"
