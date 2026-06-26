import type { Env } from './types';
import { fetchMetricsTimeSliced } from './graphql';
import { storeTunnelMetrics, rollupHour, rollupDay, purgeOldData, setMetadata, storeBillingP95 } from './d1';
import { writeRawToR2, computeAggregateBillingP95, purgeOldR2Data } from './r2';
import { snapToHour, snapToDay, toPeriod } from './utils';

export async function handleCron(env: Env): Promise<void> {
  const now = new Date();
  const sixtyFiveMinutesAgo = new Date(now.getTime() - 65 * 60 * 1000);

  // Step 1: Fetch via time-sliced GraphQL
  const { ingress, egress, warnings } = await fetchMetricsTimeSliced(
    env.ACCOUNT_ID,
    env.WAN_API_TOKEN,
    sixtyFiveMinutesAgo,
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

  // Step 2: Dual-write D1 + R2
  const [, r2Result] = await Promise.all([
    Promise.all([
      storeTunnelMetrics(env.DB, ingress, 'ingress'),
      storeTunnelMetrics(env.DB, egress, 'egress'),
    ]),
    writeRawToR2(env.RAW_METRICS, ingress, egress),
  ]);

  console.log(`D1: stored ${ingress.length} ingress + ${egress.length} egress rows`);
  console.log(`R2: wrote ${r2Result.filesWritten} files, ${r2Result.totalRows} total rows`);

  // Step 3: Hourly rollup (2 hours ago is safe — data is settled)
  const completedHour = snapToHour(new Date(now.getTime() - 2 * 60 * 60 * 1000));
  const rollupChanges = await rollupHour(env.DB, completedHour.toISOString());
  console.log(`Hourly rollup for ${completedHour.toISOString()}: ${rollupChanges} rows`);

  // Step 4: Daily tasks at hour 0 UTC
  if (now.getUTCHours() === 0) {
    await handleDailyTasks(env, now);
  }
}

async function handleDailyTasks(env: Env, now: Date): Promise<void> {
  console.log('Running daily tasks...');

  // Roll up previous day
  const yesterday = snapToDay(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const dayRollupChanges = await rollupDay(env.DB, yesterday.toISOString());
  console.log(`Daily rollup for ${yesterday.toISOString()}: ${dayRollupChanges} rows`);

  // Purge old D1 data
  const purgeResult = await purgeOldData(env.DB);
  console.log(`D1 retention: deleted raw=${purgeResult.rawDeleted} hourly=${purgeResult.hourlyDeleted} daily=${purgeResult.dailyDeleted}`);

  // Purge old R2 data (>6 months)
  const r2Deleted = await purgeOldR2Data(env.RAW_METRICS);
  console.log(`R2 retention: deleted ${r2Deleted} files`);

  // Compute billing p95 for current and previous calendar month
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
