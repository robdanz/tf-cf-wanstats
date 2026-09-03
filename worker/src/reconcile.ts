import type { Env } from './types';
import {
  findMissingGapCells, insertGapCells, rollupHour, rollupDay,
  getRawRowsForHour, getOldestRawTs, getMetadata, setMetadata,
} from './d1';
import { writeRawToR2 } from './r2';
import { snapToHour, snapToDay } from './utils';

// The hour ledger. Every full run walks hours from the persisted
// `reconciled_through` watermark and, per hour, (1) tracks missing cells in
// gap_tracking, (2) rewrites the hourly rollup, (3) rebuilds the hour's R2
// CSV from D1, (4) on the 23:00 hour rewrites the daily rollup. The
// watermark advances only after all steps succeed, so an hour whose full
// run died is repaired by the next good run instead of being lost.
// See docs/superpowers/specs/2026-09-03-self-healing-reconciliation-design.md.

export const MAX_HOURS_PER_RUN = 6;
const HOUR_MS = 60 * 60 * 1000;
// An hour [H, H+1h) is reconciled once now >= H + 2h — the same settling
// delay the standalone hourly rollup used before the ledger existed.
const SETTLE_MS = 2 * HOUR_MS;
const RAW_RETENTION_MS = 7 * 24 * HOUR_MS;
const ROSTER_MS = 24 * HOUR_MS;

export function hourKey(d: Date): string {
  // Raw ts format: no milliseconds. Inputs are always hour-aligned.
  return d.toISOString().replace('.000Z', 'Z');
}

export function computeInitialWatermark(oldestRawTs: string | null, now: Date): Date {
  if (oldestRawTs) {
    // One hour before the hour containing the oldest row, so the first hour
    // processed is that hour: the whole retention window gets reconciled.
    return new Date(snapToHour(new Date(oldestRawTs)).getTime() - HOUR_MS);
  }
  // Empty table: first eligible hour is now - 2h.
  return new Date(snapToHour(now).getTime() - 3 * HOUR_MS);
}

async function reconcileHour(env: Env, hour: Date, now: Date): Promise<void> {
  const start = hourKey(hour);
  const endDate = new Date(hour.getTime() + HOUR_MS);
  const end = hourKey(endDate);
  const rosterSince = hourKey(new Date(endDate.getTime() - ROSTER_MS));

  const missing = await findMissingGapCells(env.DB, start, end, rosterSince);
  if (missing.length > 0) await insertGapCells(env.DB, missing, now.toISOString());

  const rollupChanges = await rollupHour(env.DB, hour.toISOString());

  const { ingress, egress } = await getRawRowsForHour(env.DB, start, end);
  let r2Rows = 0;
  if (ingress.length + egress.length > 0) {
    // Merge-by-key writer: identical content is a harmless rewrite, a
    // missing or short hour is filled from D1. No GraphQL calls.
    r2Rows = (await writeRawToR2(env.RAW_METRICS, ingress, egress)).totalRows;
  }

  if (hour.getUTCHours() === 23) {
    const day = snapToDay(hour).toISOString();
    const dayChanges = await rollupDay(env.DB, day);
    console.log(`Ledger rollupDay ${day}: ${dayChanges} rows`);
  }

  console.log(`Ledger ${start}: ${missing.length} new gap cell(s), rollup ${rollupChanges} rows, R2 ${r2Rows} rows`);
}

export async function reconcileHours(
  env: Env,
  now: Date,
): Promise<{ processed: number; hoursBehind: number; reconciledThrough: string | null }> {
  const stored = await getMetadata(env.DB, 'reconciled_through');
  let watermark = stored
    ? new Date(stored)
    : computeInitialWatermark(await getOldestRawTs(env.DB), now);

  // Nothing older than raw retention can be reconciled; the purge is about
  // to delete it anyway.
  const floor = snapToHour(new Date(now.getTime() - RAW_RETENTION_MS));
  if (watermark < floor) watermark = floor;

  let hour = new Date(watermark.getTime() + HOUR_MS);
  let processed = 0;
  while (hour.getTime() + SETTLE_MS <= now.getTime() && processed < MAX_HOURS_PER_RUN) {
    await reconcileHour(env, hour, now);
    await setMetadata(env.DB, 'reconciled_through', hourKey(hour));
    watermark = hour;
    hour = new Date(hour.getTime() + HOUR_MS);
    processed++;
  }

  const hoursBehind = Math.max(0, Math.floor((now.getTime() - SETTLE_MS - watermark.getTime()) / HOUR_MS));
  const reconciledThrough = processed > 0 || stored ? hourKey(watermark) : null;
  console.log(`Ledger: processed ${processed} hour(s), ${hoursBehind} eligible hour(s) still behind`);
  return { processed, hoursBehind, reconciledThrough };
}
