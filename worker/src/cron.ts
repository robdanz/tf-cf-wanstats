import type { Env } from './types';
import { fetchMetricsTimeSliced } from './graphql';
import { storeTunnelMetrics, purgeOldData, setMetadata, storeBillingP95, recordCronError, insertGapBuckets } from './d1';
import { writeRawToR2, computeAggregateBillingP95, purgeOldR2Data } from './r2';
import { toPeriod } from './utils';
import { retryPendingGaps } from './gaps';
import { reconcileHours } from './reconcile';

// Cron fires every 5 minutes. The minute-0 slot is the full run (65-min
// lookback, R2 write, hour ledger, midnight tasks); every run — light or
// full — also retries pending gap cells, since a gap can be repaired as soon
// as its raw data settles rather than waiting for the next full run.
//
// Every full-run step runs under its own try/catch and records its failure
// in cron_metadata (last_error_*). A failure in one step never skips the
// steps after it, and the ledger repairs whatever a dead step left behind.
export async function handleCron(env: Env, now: Date = new Date()): Promise<void> {
  const fullRun = now.getUTCMinutes() < 5;
  const lookbackMinutes = fullRun ? 65 : 20;
  const windowStart = new Date(now.getTime() - lookbackMinutes * 60 * 1000);

  console.log(`Cron run: ${fullRun ? 'full' : 'light'} (lookback ${lookbackMinutes}m)`);
  if (fullRun) {
    try {
      await setMetadata(env.DB, 'last_full_run_at', now.toISOString());
    } catch (err) {
      console.error(`Failed to write last_full_run_at: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let ok = true;

  try {
    await collect(env, now, windowStart, fullRun);
  } catch (err) {
    ok = false;
    await recordCronError(env.DB, 'collect', err);
  }

  try {
    await retryPendingGaps(env, now);
  } catch (err) {
    ok = false;
    await recordCronError(env.DB, 'retry', err);
  }

  if (!fullRun) return;

  try {
    await reconcileHours(env, now);
  } catch (err) {
    ok = false;
    await recordCronError(env.DB, 'reconcile', err);
  }

  if (now.getUTCHours() === 0) {
    try {
      await handleDailyTasks(env, now);
    } catch (err) {
      ok = false;
      await recordCronError(env.DB, 'daily', err);
    }
  }

  try {
    await setMetadata(env.DB, 'last_full_run_ok', ok ? 'true' : 'false');
  } catch (err) {
    console.error(`Failed to write last_full_run_ok: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function collect(env: Env, now: Date, windowStart: Date, fullRun: boolean): Promise<void> {
  const { ingress, egress, warnings, failedSlices, sliceCount } = await fetchMetricsTimeSliced(
    env.ACCOUNT_ID,
    env.WAN_API_TOKEN,
    windowStart,
    now,
  );

  if (warnings.length > 0) {
    console.warn(`Data collection warnings: ${warnings.join('; ')}`);
  }

  // Track tunnel count for capacity monitoring
  const tunnelNames = new Set<string>();
  for (const row of ingress) tunnelNames.add(row.tunnelName);
  for (const row of egress) tunnelNames.add(row.tunnelName);
  await setMetadata(env.DB, 'last_tunnel_count', tunnelNames.size.toString());
  await setMetadata(env.DB, 'last_cron_run', now.toISOString());

  if (tunnelNames.size >= 2500) {
    console.warn(`CAPACITY WARNING: ${tunnelNames.size} tunnels detected. GraphQL limit may need increasing.`);
  }

  if (sliceCount > 0 && failedSlices.length === sliceCount) {
    throw new Error(`all ${sliceCount} slice(s) failed: ${warnings[warnings.length - 1] ?? 'no detail'}`);
  }

  // A failed slice is a known gap right now — track it in this run rather
  // than waiting for the ledger to reach the hour two hours later. Best
  // effort: the rows we did get must still be stored below.
  if (failedSlices.length > 0) {
    try {
      await insertGapBuckets(env.DB, failedSlices.map((s) => ({ ts: s.replace('.000Z', 'Z') })), now.toISOString());
    } catch (err) {
      console.error(`Failed to record ${failedSlices.length} failed slice(s) as gap buckets: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!fullRun) {
    await Promise.all([
      storeTunnelMetrics(env.DB, ingress, 'ingress'),
      storeTunnelMetrics(env.DB, egress, 'egress'),
    ]);
    console.log(`D1 (light): stored ${ingress.length} ingress + ${egress.length} egress rows`);
    return;
  }

  const [, r2Result] = await Promise.all([
    Promise.all([
      storeTunnelMetrics(env.DB, ingress, 'ingress'),
      storeTunnelMetrics(env.DB, egress, 'egress'),
    ]),
    writeRawToR2(env.RAW_METRICS, ingress, egress),
  ]);

  console.log(`D1: stored ${ingress.length} ingress + ${egress.length} egress rows`);
  console.log(`R2: wrote ${r2Result.filesWritten} files, ${r2Result.totalRows} total rows`);
}

// Retention and billing only. Hourly and daily rollups live in the ledger
// (reconcile.ts) so the midnight run is no longer a single point of failure.
async function handleDailyTasks(env: Env, now: Date): Promise<void> {
  console.log('Running daily tasks...');

  const purgeResult = await purgeOldData(env.DB);
  console.log(`D1 retention: deleted raw=${purgeResult.rawDeleted} hourly=${purgeResult.hourlyDeleted} daily=${purgeResult.dailyDeleted} gaps=${purgeResult.gapTrackingDeleted}`);

  const r2Deleted = await purgeOldR2Data(env.RAW_METRICS);
  console.log(`R2 retention: deleted ${r2Deleted} files`);

  await computeAndStoreBillingP95(env, now);
}

async function computeAndStoreBillingP95(env: Env, now: Date): Promise<void> {
  const currentMonth = toPeriod(now);
  const prevMonthDate = new Date(now);
  prevMonthDate.setUTCMonth(prevMonthDate.getUTCMonth() - 1);
  const prevMonth = toPeriod(prevMonthDate);

  for (const period of [currentMonth, prevMonth]) {
    const [year, month] = period.split('-').map(Number);
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = period === currentMonth
      ? now
      : new Date(Date.UTC(year, month, 1));

    console.log(`Computing billing p95 for ${period}: ${startDate.toISOString()} to ${endDate.toISOString()}`);

    const result = await computeAggregateBillingP95(
      env.RAW_METRICS,
      startDate,
      endDate,
      new Set<string>(),
    );

    if (result.ingress !== null) {
      await storeBillingP95(env.DB, period, '*', 'ingress', result.ingress, result.sampleCount);
    }
    if (result.egress !== null) {
      await storeBillingP95(env.DB, period, '*', 'egress', result.egress, result.sampleCount);
    }

    console.log(`Billing p95 for ${period}: ingress=${result.ingress} egress=${result.egress} samples=${result.sampleCount}`);
  }
}
