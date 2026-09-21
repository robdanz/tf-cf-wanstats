import type { Env } from './types';
import { fetchMetricsTimeSliced } from './graphql';
import { storeTunnelMetrics, pruneRawRows, keepKeys, rollupHour, rollupDay, getMetadata, setMetadata, deleteResolvedGapBuckets } from './d1';
import { writeRawToR2, bucketsWithRows } from './r2';
import { snapToHour, snapToDay } from './utils';
import { hourKey } from './reconcile';

// The late re-poll. Cloudflare rewrites magicTransitNetworkAnalyticsAdaptiveGroups
// well after the fact: measured on the lab tenant (2026-09-20), buckets are
// rewritten in a periodic batch — the rewrite boundary sat at 06:00Z from
// 16:20Z through 23:30Z that day, hours before it changed (25-40 rows per
// hour on a 7-tunnel account), hours after it untouched at 14h of age — and
// are stable afterwards (no further change over the following days). A
// rewrite gains rows for low-rate tunnels, loses a few, and shifts about a
// third of the values by more than 0.5%. The collector's last look is 65 minutes
// after a bucket, so none of that ever reached D1 or R2 (the customer's
// 2026-09-13 report: 4 of ~250 missing buckets were at Cloudflare, never in
// our stores). This pass re-fetches every hour once per delay in
// REPOLL_DELAYS_H, exactly like a backfill: conditional upsert into D1 (only
// changed rows get a new written_at, so /api/current?since= consumers see
// the corrections), merge-by-key into the hour's R2 object, and the hourly
// and daily rollups are rewritten; rows the source no longer returns for a
// bucket it did answer for are removed from both stores. Three delays: 14h
// picks up the hours the batch has already covered a day earlier; 38h is
// past the daily batch for every hour; 62h exists because the rewrite
// reaches the API's serving replicas hours apart — on 2026-09-21 the
// customer's 38h pass at 15:01Z still fetched pre-rewrite data for an hour
// that a client elsewhere had seen rewritten at 13:00Z, and the worker only
// saw it by 18:54Z. A pass that finds nothing changed is indistinguishable
// from "not rewritten yet", so a later bounded pass is the safety net.
//
// Each delay keeps its own watermark in cron_metadata
// (`repolled_<delay>h_through`), walked like the hour ledger: an hour is
// eligible once now >= H + 1h + delay, at most MAX_REPOLL_HOURS_PER_PASS per
// run, and the watermark advances only when every slice of the hour was
// fetched. A failed slice stops the pass; the next full run retries the
// same hour. A bucket the source answers with no rows at all is left as is.

export const REPOLL_DELAYS_H = [14, 38, 62];
export const MAX_REPOLL_HOURS_PER_PASS = 3;
// First run of a pass starts this far behind the newest due hour, so the
// hours collected before the re-poll existed (up to a day) are covered
// without a manual backfill. 26 hours = 9 full runs of catch-up at 3/run.
export const INITIAL_CATCHUP_H = 26;
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

  // A bucket that has rows now is no longer a gap, whatever the retry
  // schedule concluded about it.
  if (replace.size > 0) await deleteResolvedGapBuckets(env.DB, Array.from(replace).map((ts) => ({ ts })));

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
    // First run (or garbage): catch up the last INITIAL_CATCHUP_H hours.
    watermark = new Date(newest.getTime() - INITIAL_CATCHUP_H * HOUR_MS);
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
