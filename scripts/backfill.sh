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
# Optional (required when the worker hostname is behind Cloudflare Access):
#   CF_ACCESS_CLIENT_ID      Access service token client ID
#   CF_ACCESS_CLIENT_SECRET  Access service token client secret
#
# Optional tuning:
#   BACKFILL_SLEEP  seconds to pause between hour windows (default 15) —
#                   each window costs 12 GraphQL queries against a shared
#                   ~300-per-5-min API budget the live cron also uses
#   RETRY_SLEEP     seconds to wait after a 429 before retrying (default 90)
#   MAX_RETRIES     429 retries per window before giving up (default 5)
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

# Convert ISO 8601 to epoch seconds (macOS date)
# TZ=UTC is required: -f parses in the local zone and treats the trailing
# "Z" as a literal, silently shifting the range by the UTC offset.
to_epoch() {
  TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" "+%s" 2>/dev/null \
    || date -u -d "$1" "+%s"  # Linux fallback
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

BACKFILL_SLEEP="${BACKFILL_SLEEP:-15}"
RETRY_SLEEP="${RETRY_SLEEP:-90}"
MAX_RETRIES="${MAX_RETRIES:-5}"

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

  attempt=1
  while :; do
    response=$(curl -s -X POST \
      "${WORKER_URL}/api/backfill?start=${window_start}&end=${window_end}" \
      -H "X-Backfill-Token: ${BACKFILL_TOKEN}" \
      ${ACCESS_HEADERS[@]+"${ACCESS_HEADERS[@]}"})

    if echo "$response" | grep -q '"ingress_rows"'; then
      in_rows=$(echo "$response" | sed 's/.*"ingress_rows":\([0-9]*\).*/\1/')
      eg_rows=$(echo "$response" | sed 's/.*"egress_rows":\([0-9]*\).*/\1/')
      echo "ingress=${in_rows} egress=${eg_rows}"
      total_ingress=$((total_ingress + in_rows))
      total_egress=$((total_egress + eg_rows))
      windows=$((windows + 1))
      # Show any data collection warnings (e.g., GraphQL limit reached)
      if echo "$response" | grep -q '"warnings":\[\"'; then
        echo "    WARNINGS in response" >&2
      fi
      break
    elif echo "$response" | grep -q '429'; then
      if [[ "$attempt" -ge "$MAX_RETRIES" ]]; then
        echo "ERROR"
        echo "    Rate limited after ${MAX_RETRIES} attempts. Re-run from ${window_start} later." >&2
        exit 1
      fi
      printf "rate limited, waiting %ss (attempt %s/%s) ... " "$RETRY_SLEEP" "$attempt" "$MAX_RETRIES"
      sleep "$RETRY_SLEEP"
      attempt=$((attempt + 1))
    else
      echo "ERROR"
      echo "    Response: $response" >&2
      exit 1
    fi
  done

  current=$next
  # Pace requests: each hour window costs 12 GraphQL queries against a
  # shared ~300-per-5-min budget that the live cron also draws from.
  if [[ "$current" -lt "$end_epoch" ]]; then
    sleep "$BACKFILL_SLEEP"
  fi
done

echo ""
echo "Done. ${windows} windows processed."
echo "Total rows upserted: ingress=${total_ingress} egress=${total_egress}"
