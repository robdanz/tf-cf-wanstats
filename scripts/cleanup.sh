#!/usr/bin/env bash
# cleanup.sh — Scrub duplicate rows from historical R2 raw CSVs.
#
# Calls POST /api/cleanup on the worker for each day in the range. Each hour
# file is collapsed to one row per tunnel/direction/timestamp, keeping the
# highest bit rate (partial-bucket duplicates are always the lower value).
# Idempotent — safe to re-run.
#
# Use this only for days older than the GraphQL retention window. For days
# GraphQL can still serve, prefer ./scripts/backfill.sh, which replaces stale
# values with fully settled ones instead of guessing.
#
# Usage:
#   ./scripts/cleanup.sh <start-date> <end-date>
#
# Arguments:
#   start-date  inclusive, e.g. 2026-01-15
#   end-date    exclusive, e.g. 2026-04-01
#
# Required environment variables:
#   WORKER_URL      e.g. https://tf-cf-wanstats.<subdomain>.workers.dev
#   BACKFILL_TOKEN  value from terraform.tfvars
#
# Optional (required when the worker hostname is behind Cloudflare Access):
#   CF_ACCESS_CLIENT_ID      Access service token client ID
#   CF_ACCESS_CLIENT_SECRET  Access service token client secret
#
# Example:
#   export WORKER_URL=https://tf-cf-wanstats.mysubdomain.workers.dev
#   export BACKFILL_TOKEN=<your-token>
#   ./scripts/cleanup.sh 2026-01-15 2026-04-01

set -euo pipefail

START="${1:-}"
END="${2:-}"

if [[ -z "$START" || -z "$END" ]]; then
  echo "Usage: $0 <start-date> <end-date>  (YYYY-MM-DD, end exclusive)" >&2
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

# Convert date to epoch seconds (macOS date, Linux fallback)
# TZ=UTC is required: -f parses in the local zone, silently shifting the
# range by the UTC offset.
to_epoch() {
  TZ=UTC date -j -f "%Y-%m-%d" "$1" "+%s" 2>/dev/null \
    || date -u -d "$1" "+%s"
}

# Convert epoch seconds back to YYYY-MM-DD
to_date() {
  date -u -r "$1" "+%Y-%m-%d" 2>/dev/null \
    || date -u -d "@$1" "+%Y-%m-%d"
}

start_epoch=$(to_epoch "$START")
end_epoch=$(to_epoch "$END")

if [[ "$start_epoch" -ge "$end_epoch" ]]; then
  echo "Error: start must be before end" >&2
  exit 1
fi

DAY=86400
current=$start_epoch

echo "Cleaning up R2 raw CSVs from $START to $END (exclusive)"
echo "Worker: $WORKER_URL"
echo ""

total_files=0
total_removed=0
days=0

while [[ "$current" -lt "$end_epoch" ]]; do
  day=$(to_date "$current")

  printf "  %s ... " "$day"

  response=$(curl -s -X POST \
    "${WORKER_URL}/api/cleanup?date=${day}" \
    -H "X-Backfill-Token: ${BACKFILL_TOKEN}" \
    ${ACCESS_HEADERS[@]+"${ACCESS_HEADERS[@]}"})

  if echo "$response" | grep -q '"filesProcessed"'; then
    files=$(echo "$response" | sed 's/.*"filesProcessed":\([0-9]*\).*/\1/')
    removed=$(echo "$response" | sed 's/.*"duplicatesRemoved":\([0-9]*\).*/\1/')
    echo "files=${files} duplicates_removed=${removed}"
    total_files=$((total_files + files))
    total_removed=$((total_removed + removed))
    days=$((days + 1))
  else
    echo "ERROR"
    echo "    Response: $response" >&2
    exit 1
  fi

  current=$((current + DAY))
done

echo ""
echo "Done. ${days} days processed, ${total_files} files scanned, ${total_removed} duplicate rows removed."
