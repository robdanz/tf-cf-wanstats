import type { Env, GapCell, TrackedGapCell, NormalizedRow } from './types';
import { fetchMetricsTimeSliced } from './graphql';
import {
  getPendingGaps, deleteResolvedGaps, incrementOrConfirmGaps, storeTunnelMetrics,
  rollupHour, rollupDay,
} from './d1';
import { writeRawToR2 } from './r2';
import { snapToHour, snapToDay } from './utils';

// Budget per cron run, counted in 5-minute buckets: fetchMetricsTimeSliced
// issues one sequential GraphQL request per bucket, so ranges (which can span
// arbitrarily many buckets) are the wrong unit to cap on.
const MAX_BUCKETS_PER_RUN = 20;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
// Max *distinct timestamps* pulled from gap_tracking per run — every cell for
// a selected ts comes back, since one GraphQL call covers all tunnels for it.
const MAX_PENDING_TIMESTAMPS = 500;

export interface ContiguousRange {
  start: string;
  end: string;
  cells: TrackedGapCell[];
}

export function groupIntoContiguousRanges(cells: TrackedGapCell[]): ContiguousRange[] {
  const byTs = new Map<string, TrackedGapCell[]>();
  for (const cell of cells) {
    if (!byTs.has(cell.ts)) byTs.set(cell.ts, []);
    byTs.get(cell.ts)!.push(cell);
  }

  const sortedTs = Array.from(byTs.keys()).sort();
  const ranges: ContiguousRange[] = [];
  let currentTsList: string[] = [];

  for (const ts of sortedTs) {
    const last = currentTsList[currentTsList.length - 1];
    if (last !== undefined && new Date(ts).getTime() - new Date(last).getTime() === FIVE_MINUTES_MS) {
      currentTsList.push(ts);
    } else {
      if (currentTsList.length > 0) ranges.push(finalizeRange(currentTsList, byTs));
      currentTsList = [ts];
    }
  }
  if (currentTsList.length > 0) ranges.push(finalizeRange(currentTsList, byTs));

  // reduce(), not Math.min(...spread) — a very large cell array would blow the
  // argument limit and throw RangeError.
  const earliest = (cells: TrackedGapCell[]) =>
    cells.reduce((min, c) => Math.min(min, new Date(c.firstDetected).getTime()), Infinity);
  ranges.sort((a, b) => earliest(a.cells) - earliest(b.cells));

  return ranges;
}

function finalizeRange(tsList: string[], byTs: Map<string, TrackedGapCell[]>): ContiguousRange {
  const cells = tsList.flatMap((ts) => byTs.get(ts)!);
  const start = tsList[0];
  const endMs = new Date(tsList[tsList.length - 1]).getTime() + FIVE_MINUTES_MS;
  // Raw ts format has no milliseconds ('...Z', not '...000Z'); inputs are
  // always 5-min-aligned so the millisecond component is always exactly
  // zero here — safe to strip rather than reformat by hand.
  const end = new Date(endMs).toISOString().replace('.000Z', 'Z');
  return { start, end, cells };
}

export async function retryPendingGaps(env: Env, now: Date): Promise<void> {
  const pending = await getPendingGaps(env.DB, MAX_PENDING_TIMESTAMPS);
  if (pending.length === 0) return;

  const ranges = groupIntoContiguousRanges(pending);
  // Take whole ranges (never split one) until the next would blow the bucket
  // budget. The toProcess.length > 0 guard lets a single oversized range run
  // alone rather than starving behind the cap forever.
  const toProcess: ContiguousRange[] = [];
  let bucketCount = 0;
  for (const range of ranges) {
    const rangeBuckets = (new Date(range.end).getTime() - new Date(range.start).getTime()) / FIVE_MINUTES_MS;
    if (toProcess.length > 0 && bucketCount + rangeBuckets > MAX_BUCKETS_PER_RUN) break;
    toProcess.push(range);
    bucketCount += rangeBuckets;
  }
  if (ranges.length > toProcess.length) {
    console.warn(`Gap repoll: deferring ${ranges.length - toProcess.length} window(s) to next run (budget cap)`);
  }

  const resolvedHours = new Set<string>();
  const resolvedDays = new Set<string>();

  for (const range of toProcess) {
    let ingress: NormalizedRow[];
    let egress: NormalizedRow[];
    let failedSlices: string[];
    try {
      ({ ingress, egress, failedSlices } = await fetchMetricsTimeSliced(
        env.ACCOUNT_ID, env.WAN_API_TOKEN, new Date(range.start), new Date(range.end),
      ));
    } catch (err) {
      console.warn(`Gap repoll fetch failed for ${range.start}-${range.end}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    // failedSlices carries toISOString() timestamps; raw ts has no
    // milliseconds. Normalise once so the per-cell check is a plain lookup.
    const failedTs = new Set(failedSlices.map((s) => s.replace('.000Z', 'Z')));

    await Promise.all([
      storeTunnelMetrics(env.DB, ingress, 'ingress'),
      storeTunnelMetrics(env.DB, egress, 'egress'),
    ]);
    await writeRawToR2(env.RAW_METRICS, ingress, egress);

    const present = new Map<string, Set<string>>();
    for (const row of ingress) {
      if (!present.has(row.ts)) present.set(row.ts, new Set());
      present.get(row.ts)!.add(`${row.tunnelName}|ingress`);
    }
    for (const row of egress) {
      if (!present.has(row.ts)) present.set(row.ts, new Set());
      present.get(row.ts)!.add(`${row.tunnelName}|egress`);
    }

    const resolved: GapCell[] = [];
    const stillMissing: GapCell[] = [];
    let skipped = 0;
    for (const cell of range.cells) {
      // A failed slice says nothing about the cell: no resolve, no attempt burned.
      if (failedTs.has(cell.ts)) { skipped++; continue; }
      const key = `${cell.tunnelName}|${cell.direction}`;
      if (present.get(cell.ts)?.has(key)) {
        resolved.push(cell);
        resolvedHours.add(snapToHour(new Date(cell.ts)).toISOString());
        resolvedDays.add(snapToDay(new Date(cell.ts)).toISOString());
      } else {
        stillMissing.push(cell);
      }
    }

    if (resolved.length > 0) await deleteResolvedGaps(env.DB, resolved);
    if (stillMissing.length > 0) await incrementOrConfirmGaps(env.DB, stillMissing, now.toISOString());

    console.log(`Gap repoll ${range.start}-${range.end}: resolved ${resolved.length}, still missing ${stillMissing.length}, skipped (slice failed) ${skipped}`);
  }

  for (const hour of resolvedHours) {
    const changes = await rollupHour(env.DB, hour);
    console.log(`Gap repoll rollupHour ${hour}: ${changes} rows`);
  }
  // Skip today: the daily table is only ever written as a complete-day
  // aggregate. Rolling it up mid-day would publish a partial row that
  // understates the 90d/180d bars until the ledger rewrites it.
  const today = snapToDay(now).toISOString();
  for (const day of resolvedDays) {
    if (day === today) continue;
    const changes = await rollupDay(env.DB, day);
    console.log(`Gap repoll rollupDay ${day}: ${changes} rows`);
  }
}
