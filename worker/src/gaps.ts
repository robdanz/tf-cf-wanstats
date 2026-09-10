import type { Env, GapBucket, TrackedGapBucket, NormalizedRow } from './types';
import { fetchMetricsTimeSliced } from './graphql';
import {
  getPendingGapBuckets, deleteResolvedGapBuckets, incrementOrConfirmGapBuckets, storeTunnelMetrics,
  rollupHour, rollupDay,
} from './d1';
import { writeRawToR2 } from './r2';
import { snapToHour, snapToDay } from './utils';

// Budget per cron run, counted in 5-minute buckets: fetchMetricsTimeSliced
// issues one sequential GraphQL request per bucket, so ranges (which can span
// arbitrarily many buckets) are the wrong unit to cap on.
const MAX_BUCKETS_PER_RUN = 20;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
// Max pending buckets pulled from gap_buckets per run (oldest first).
const MAX_PENDING_BUCKETS = 500;

export interface ContiguousRange {
  start: string;
  end: string;
  buckets: TrackedGapBucket[];
}

export function groupIntoContiguousRanges(buckets: TrackedGapBucket[]): ContiguousRange[] {
  const sorted = [...buckets].sort((a, b) => a.ts.localeCompare(b.ts));
  const ranges: ContiguousRange[] = [];
  let current: TrackedGapBucket[] = [];

  for (const bucket of sorted) {
    const last = current[current.length - 1];
    if (last !== undefined && new Date(bucket.ts).getTime() - new Date(last.ts).getTime() === FIVE_MINUTES_MS) {
      current.push(bucket);
    } else {
      if (current.length > 0) ranges.push(finalizeRange(current));
      current = [bucket];
    }
  }
  if (current.length > 0) ranges.push(finalizeRange(current));

  // reduce(), not Math.min(...spread) — a very large array would blow the
  // argument limit and throw RangeError.
  const earliest = (bs: TrackedGapBucket[]) =>
    bs.reduce((min, b) => Math.min(min, new Date(b.firstDetected).getTime()), Infinity);
  ranges.sort((a, b) => earliest(a.buckets) - earliest(b.buckets));

  return ranges;
}

function finalizeRange(buckets: TrackedGapBucket[]): ContiguousRange {
  const start = buckets[0].ts;
  const endMs = new Date(buckets[buckets.length - 1].ts).getTime() + FIVE_MINUTES_MS;
  // Raw ts format has no milliseconds ('...Z', not '...000Z'); inputs are
  // always 5-min-aligned so the millisecond component is always exactly
  // zero here — safe to strip rather than reformat by hand.
  const end = new Date(endMs).toISOString().replace('.000Z', 'Z');
  return { start, end, buckets };
}

export async function retryPendingGaps(env: Env, now: Date): Promise<void> {
  const pending = await getPendingGapBuckets(env.DB, MAX_PENDING_BUCKETS);
  if (pending.length === 0) return;

  const ranges = groupIntoContiguousRanges(pending);
  // Take whole ranges (never split one) until the next would blow the bucket
  // budget. The toProcess.length > 0 guard lets a single oversized range run
  // alone rather than starving behind the cap forever.
  const toProcess: ContiguousRange[] = [];
  let bucketCount = 0;
  for (const range of ranges) {
    if (toProcess.length > 0 && bucketCount + range.buckets.length > MAX_BUCKETS_PER_RUN) break;
    toProcess.push(range);
    bucketCount += range.buckets.length;
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
    // milliseconds. Normalise once so the per-bucket check is a plain lookup.
    const failedTs = new Set(failedSlices.map((s) => s.replace('.000Z', 'Z')));

    await Promise.all([
      storeTunnelMetrics(env.DB, ingress, 'ingress'),
      storeTunnelMetrics(env.DB, egress, 'egress'),
    ]);
    await writeRawToR2(env.RAW_METRICS, ingress, egress);

    // Any row in either direction resolves the bucket: the slice returned
    // data, so its absence was a fetch problem, not a Cloudflare-side hole.
    const presentTs = new Set<string>();
    for (const row of ingress) presentTs.add(row.ts);
    for (const row of egress) presentTs.add(row.ts);

    const resolved: GapBucket[] = [];
    const stillMissing: GapBucket[] = [];
    let skipped = 0;
    for (const bucket of range.buckets) {
      // A failed slice says nothing about the bucket: no resolve, no attempt burned.
      if (failedTs.has(bucket.ts)) { skipped++; continue; }
      if (presentTs.has(bucket.ts)) {
        resolved.push(bucket);
        resolvedHours.add(snapToHour(new Date(bucket.ts)).toISOString());
        resolvedDays.add(snapToDay(new Date(bucket.ts)).toISOString());
      } else {
        stillMissing.push(bucket);
      }
    }

    if (resolved.length > 0) await deleteResolvedGapBuckets(env.DB, resolved);
    if (stillMissing.length > 0) await incrementOrConfirmGapBuckets(env.DB, stillMissing, now.toISOString());

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
