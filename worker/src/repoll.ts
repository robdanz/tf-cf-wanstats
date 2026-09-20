import type { Env } from './types';
import { fetchMetricsTimeSliced } from './graphql';
import { storeTunnelMetrics, pruneRawRows, keepKeys, rollupHour, rollupDay, getMetadata, setMetadata } from './d1';
import { writeRawToR2, bucketsWithRows } from './r2';
import { snapToHour, snapToDay } from './utils';
import { hourKey } from './reconcile';

// The late re-poll. Cloudflare rewrites magicTransitNetworkAnalyticsAdaptiveGroups
// well after the fact: measured on the lab tenant (2026-09-20), a 5-minute
// bucket is served unchanged for its first ~8-10 hours and then, once,
// gains rows for low-rate tunnels, loses a few, and has about a third of its
// values shift by more than 0.5%. The collector's last look is 65 minutes
// after a bucket, so none of that ever reached D1 or R2 (the customer's
// 2026-09-13 report: 4 of ~250 missing buckets were at Cloudflare, never in
// our stores). This pass re-fetches every hour once per delay in
// REPOLL_DELAYS_H, exactly like a backfill: conditional upsert into D1 (only
// changed rows get a new written_at, so /api/current?since= consumers see
// the corrections), merge-by-key into the hour's R2 object, and the hourly
// and daily rollups are rewritten; rows the source no longer returns for a
// bucket it did answer for are removed from both stores. Two delays: 14h catches the age-based
// rewrite, 38h is insurance in case it is a fixed-time daily job.
//
// Each delay keeps its own watermark in cron_metadata
// (`repolled_<delay>h_through`), walked like the hour ledger: an hour is
// eligible once now >= H + 1h + delay, at most MAX_REPOLL_HOURS_PER_PASS per
// run, and the watermark advances only when every slice of the hour was
// fetched. A failed slice stops the pass; the next full run retries the
// same hour. A bucket the source answers with no rows at all is left as is.

export const REPOLL_DELAYS_H = [14, 38];
export const MAX_REPOLL_HOURS_PER_PASS = 3;
const HOUR_MS = 60 * 60 * 1000;
const RAW_RETENTION_MS = 7 * 24 * HOUR_MS;

export function repollKey(delayH: number): string {
  return `repolled_${delayH}h_through`;
}

// Newest hour whose re-poll is due: the hour is complete and `delayH` hours
// have passed since it ended.
export function newestEligibleHour(now: Date, delayH: number): Date {
  return new Date(snapToHour(new Date(now.getTime() - delayH * HOUR_MS)).getTime() - HOUR_MS);
}

export interface RepollPassResult {
  delayH: number;
  processed: number;
  hoursBehind: number;
  through: string | null;
  stalledOn: string | null;
}

async function repollHour(env: Env, hour: Date): Promise<{ ok: boolean; ingress: number; egress: number }> {
  const end = new Date(hour.getTime() + HOUR_MS);
  const { ingress, egress, failedSlices, sliceCount } = await fetchMetricsTimeSliced(
    env.ACCOUNT_ID, env.WAN_API_TOKEN, hour, end,
  );
  if (failedSlices.length > 0) {
    console.warn(`Repoll ${hourKey(hour)}: ${failedSlices.length}/${sliceCount} slice(s) failed; will retry next run`);
    return { ok: false, ingress: 0, egress: 0 };
  }

  // Replace, not merge: after this the hour's D1 rows and R2 object are
  // exactly what the source returned for every bucket it answered for.
  const replace = bucketsWithRows(ingress, egress);
  await Promise.all([
    Promise.all([
      storeTunnelMetrics(env.DB, ingress, 'ingress'),
      storeTunnelMetrics(env.DB, egress, 'egress'),
    ]).then(() => pruneRawRows(env.DB, replace, keepKeys(ingress, egress))),
    writeRawToR2(env.RAW_METRICS, ingress, egress, replace),
  ]);

  await rollupHour(env.DB, hour.toISOString());
  if (hour.getUTCHours() === 23) {
    await rollupDay(env.DB, snapToDay(hour).toISOString());
  }
  return { ok: true, ingress: ingress.length, egress: egress.length };
}

async function repollPass(env: Env, now: Date, delayH: number, deadlineAt: number): Promise<RepollPassResult> {
  const key = repollKey(delayH);
  const newest = newestEligibleHour(now, delayH);

  const stored = await getMetadata(env.DB, key);
  let watermark: Date;
  const parsed = stored === null ? NaN : new Date(stored).getTime();
  if (isNaN(parsed)) {
    // First run (or garbage): start with exactly one hour, no catch-up. The
    // hours before it were already served as-is to consumers; re-fetching a
    // week of history is 2000 GraphQL calls for a ~0.03% change in bits.
    watermark = new Date(newest.getTime() - HOUR_MS);
  } else {
    watermark = snapToHour(new Date(parsed));
  }
  const floor = snapToHour(new Date(now.getTime() - RAW_RETENTION_MS));
  if (watermark < floor) watermark = floor;

  let hour = new Date(watermark.getTime() + HOUR_MS);
  let processed = 0;
  let stalledOn: string | null = null;
  while (hour <= newest && processed < MAX_REPOLL_HOURS_PER_PASS) {
    if (processed > 0 && Date.now() >= deadlineAt) {
      console.log(`Repoll ${delayH}h: deadline reached after ${processed} hour(s)`);
      break;
    }
    const r = await repollHour(env, hour);
    if (!r.ok) { stalledOn = hourKey(hour); break; }
    await setMetadata(env.DB, key, hourKey(hour));
    console.log(`Repoll ${delayH}h ${hourKey(hour)}: ${r.ingress} ingress + ${r.egress} egress rows`);
    watermark = hour;
    hour = new Date(hour.getTime() + HOUR_MS);
    processed++;
  }

  const hoursBehind = Math.max(0, Math.round((newest.getTime() - watermark.getTime()) / HOUR_MS));
  return { delayH, processed, hoursBehind, through: processed > 0 || stored !== null ? hourKey(watermark) : null, stalledOn };
}

export async function repollHours(
  env: Env,
  now: Date,
  deadlineMs = 3 * 60 * 1000,
): Promise<RepollPassResult[]> {
  const deadlineAt = Date.now() + deadlineMs;
  const results: RepollPassResult[] = [];
  for (const delayH of REPOLL_DELAYS_H) {
    results.push(await repollPass(env, now, delayH, deadlineAt));
  }
  const stalled = results.filter((r) => r.stalledOn !== null);
  if (stalled.length > 0) {
    // Surface it in cron_metadata like any other step failure, but only
    // after every pass has had its turn.
    throw new Error(`repoll stalled on ${stalled.map((r) => `${r.delayH}h@${r.stalledOn}`).join(', ')} (GraphQL slice failed)`);
  }
  return results;
}
