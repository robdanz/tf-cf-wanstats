#!/usr/bin/env bash
# reconcile-history.sh — Re-sync the stores with Cloudflare for a range of
# days, one day at a time, resumably.
#
# Cloudflare rewrites magicTransitNetworkAnalyticsAdaptiveGroups ~10-12 hours
# after each bucket. Hours collected before the late re-poll was deployed
# were never re-fetched, so R2 (and the hourly/daily rollups) hold the
# pre-rewrite values. This walks the history through POST /api/backfill,
# which for hours older than raw retention writes R2 and the rollups (no D1
# raw rows), and for the last 7 days writes D1 as well. After it completes,
# R2 == source for the whole 16-week window and D1 == R2 for the last 7
# days. Verify with:
#   GQL=0 R2_VIA=wrangler ./scripts/gap-probe.sh <day>T00:00:00Z <day+1>T00:00:00Z   (R2 vs D1, last 7 days)
#   VERBOSE=1 R2_VIA=wrangler ./scripts/gap-probe.sh <day>T00:00:00Z <day+1>T00:00:00Z (store vs source)
#
# Usage:
#   ./scripts/reconcile-history.sh [start-day] [end-day]
#     start-day  YYYY-MM-DD, default: 7 days ago (the raw-retention window
#                where D1 must equal R2). Cloudflare serves at most 16 weeks.
#     end-day    YYYY-MM-DD (exclusive), default: today — the cron's own
#                re-poll covers today's hours and the day before, and its
#                first run after deploy reaches 26 hours back, so a range
#                ending at today leaves nothing uncovered.
#   e.g.  ./scripts/reconcile-history.sh 2026-09-01        # September so far
#
# Progress is recorded per completed day in .reconcile-history.state next to
# this script (gitignored). Re-running resumes after the last completed day;
# delete the state file to start over.
#
# Environment: same as backfill.sh (WORKER_URL, BACKFILL_TOKEN, optional
# CF_ACCESS_CLIENT_ID/SECRET). BACKFILL_SLEEP defaults to 10 here: 24 hour
# windows of 12 GraphQL calls each, so a day takes roughly 10-15 minutes at
# ~900 tunnels. Run longer ranges under nohup.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$SCRIPT_DIR/.reconcile-history.state"
export BACKFILL_SLEEP="${BACKFILL_SLEEP:-10}"

: "${WORKER_URL:?WORKER_URL is not set}"
: "${BACKFILL_TOKEN:?BACKFILL_TOKEN is not set}"

day_epoch() { TZ=UTC date -j -f "%Y-%m-%d" "$1" "+%s" 2>/dev/null || date -u -d "$1" "+%s"; }
epoch_day() { date -u -r "$1" "+%Y-%m-%d" 2>/dev/null || date -u -d "@$1" "+%Y-%m-%d"; }

TODAY=$(epoch_day "$(( $(date +%s) / 86400 * 86400 ))")
DEFAULT_START=$(epoch_day "$(( $(day_epoch "$TODAY") - 7 * 86400 ))")
DEFAULT_END=$TODAY   # exclusive: yesterday is the last day walked
if (( $(day_epoch "${1:-$DEFAULT_START}") < $(day_epoch "$TODAY") - 16 * 7 * 86400 + 86400 )); then
  echo "start-day is older than the 16 weeks Cloudflare serves" >&2; exit 1
fi
START_DAY="${1:-$DEFAULT_START}"
END_DAY="${2:-$DEFAULT_END}"

cur=$(day_epoch "$START_DAY"); endp=$(day_epoch "$END_DAY")
if [[ -f "$STATE" ]]; then
  last=$(tail -1 "$STATE")
  if [[ -n "$last" ]]; then
    resume=$(( $(day_epoch "$last") + 86400 ))
    if (( resume > cur )); then cur=$resume; echo "Resuming after $last (from $STATE)"; fi
  fi
fi

echo "Reconciling $(epoch_day "$cur") -> $END_DAY (exclusive) against $WORKER_URL"
while (( cur < endp )); do
  d=$(epoch_day "$cur"); n=$(epoch_day "$(( cur + 86400 ))")
  echo
  echo "=== $d  ($(date -u +%H:%M:%SZ))"
  "$SCRIPT_DIR/backfill.sh" "${d}T00:00:00Z" "${n}T00:00:00Z"
  echo "$d" >>"$STATE"
  cur=$(( cur + 86400 ))
done
echo
echo "Done through $(epoch_day "$(( endp - 86400 ))")."
