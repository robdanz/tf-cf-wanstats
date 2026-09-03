import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { reconcileHours, computeInitialWatermark, hourKey, MAX_HOURS_PER_RUN } from '../src/reconcile';
import { storeTunnelMetrics, setMetadata, getMetadata, getPendingGaps, deleteResolvedGaps } from '../src/d1';
import { applyTestSchema } from './helpers/schema';

const DB = (env as { DB: D1Database }).DB;
const BUCKET = (env as { RAW_METRICS: R2Bucket }).RAW_METRICS;
const TEST_ENV = { DB, RAW_METRICS: BUCKET, WAN_API_TOKEN: 'token', ACCOUNT_ID: 'acct', BACKFILL_TOKEN: 'x' };

// Seed one tunnel with every 5-min bucket in [from, to) for one direction,
// except the listed holes. Raw ts format, no milliseconds.
async function seedHour(tunnel: string, direction: 'ingress' | 'egress', from: string, to: string, holes: string[] = []): Promise<void> {
  const rows = [];
  for (let t = new Date(from).getTime(); t < new Date(to).getTime(); t += 5 * 60 * 1000) {
    const ts = new Date(t).toISOString().replace('.000Z', 'Z');
    if (!holes.includes(ts)) rows.push({ tunnelName: tunnel, ts, bitRate: 1 });
  }
  await storeTunnelMetrics(DB, rows, direction, '2026-09-01T00:00:00.000Z');
}

describe('hourKey / computeInitialWatermark', () => {
  it('formats an hour in raw ts format', () => {
    expect(hourKey(new Date('2026-09-01T10:00:00.000Z'))).toBe('2026-09-01T10:00:00Z');
  });

  it('starts one hour before the hour containing the oldest raw row', () => {
    expect(computeInitialWatermark('2026-08-27T00:05:00Z', new Date('2026-09-03T14:01:00Z')))
      .toEqual(new Date('2026-08-26T23:00:00Z'));
  });

  it('starts at now - 3h on an empty table so the first eligible hour is now - 2h', () => {
    expect(computeInitialWatermark(null, new Date('2026-09-03T14:01:00Z')))
      .toEqual(new Date('2026-09-03T11:00:00Z'));
  });
});

describe('reconcileHours', () => {
  it('discovers holes, rolls up, rebuilds R2, and advances the watermark for every eligible hour', async () => {
    await applyTestSchema(DB);
    const holeA = '2026-09-01T10:20:00Z';
    await seedHour('LEDGER_A', 'ingress', '2026-09-01T09:00:00Z', '2026-09-01T12:00:00Z', [holeA]);
    await seedHour('LEDGER_A', 'egress', '2026-09-01T09:00:00Z', '2026-09-01T12:00:00Z');
    await setMetadata(DB, 'reconciled_through', '2026-09-01T09:00:00Z');

    // 12:30: hours 10:00 (10+2h <= 12:30) is eligible; 11:00 is not (13:00 > 12:30).
    const result = await reconcileHours(TEST_ENV, new Date('2026-09-01T12:30:00Z'));

    expect(result).toEqual({ processed: 1, hoursBehind: 0, reconciledThrough: '2026-09-01T10:00:00Z' });
    expect(await getMetadata(DB, 'reconciled_through')).toBe('2026-09-01T10:00:00Z');

    const pending = await getPendingGaps(DB, 100);
    expect(pending.filter((p) => p.tunnelName === 'LEDGER_A').map((p) => `${p.direction}|${p.ts}`)).toEqual([`ingress|${holeA}`]);

    const hourly = await DB.prepare('SELECT sample_count FROM tunnel_metrics_hourly WHERE tunnel_name = ? AND direction = ? AND ts = ?')
      .bind('LEDGER_A', 'ingress', '2026-09-01T10:00:00.000Z').first<{ sample_count: number }>();
    expect(hourly?.sample_count).toBe(11);

    const obj = await BUCKET.get('raw/2026-09-01/10.csv');
    const lines = (await obj!.text()).trim().split('\n');
    expect(lines[0]).toBe('tunnel_name,direction,ts,bit_rate');
    expect(lines.filter((l) => l.startsWith('LEDGER_A,ingress,'))).toHaveLength(11);
    expect(lines.filter((l) => l.startsWith('LEDGER_A,egress,'))).toHaveLength(12);

    await deleteResolvedGaps(DB, [{ tunnelName: 'LEDGER_A', direction: 'ingress', ts: holeA }]);
  });

  it('is idempotent: a second run at the same time changes nothing', async () => {
    await applyTestSchema(DB);
    await seedHour('LEDGER_B', 'ingress', '2026-09-02T09:00:00Z', '2026-09-02T11:00:00Z');
    await setMetadata(DB, 'reconciled_through', '2026-09-02T09:00:00Z');

    await reconcileHours(TEST_ENV, new Date('2026-09-02T12:05:00Z'));
    const second = await reconcileHours(TEST_ENV, new Date('2026-09-02T12:05:00Z'));

    expect(second).toEqual({ processed: 0, hoursBehind: 0, reconciledThrough: '2026-09-02T10:00:00Z' });
  });

  it('caps at MAX_HOURS_PER_RUN and reports the remaining backlog', async () => {
    await applyTestSchema(DB);
    await setMetadata(DB, 'reconciled_through', '2026-09-03T00:00:00Z');

    // 10 eligible hours (01:00 .. 10:00) at 12:00.
    const result = await reconcileHours(TEST_ENV, new Date('2026-09-03T12:00:00Z'));

    expect(result.processed).toBe(MAX_HOURS_PER_RUN);
    expect(result.reconciledThrough).toBe('2026-09-03T06:00:00Z');
    expect(result.hoursBehind).toBe(4);
  });

  it('stops without advancing when a step throws', async () => {
    await applyTestSchema(DB);
    await setMetadata(DB, 'reconciled_through', '2026-09-04T00:00:00Z');
    // Make the rollup step fail for real: drop the hourly table. Discovery
    // (the step before it) still runs, so this also proves a partial hour
    // does not advance the watermark.
    await DB.exec('DROP TABLE tunnel_metrics_hourly');

    await expect(reconcileHours(TEST_ENV, new Date('2026-09-04T06:00:00Z'))).rejects.toThrow(/tunnel_metrics_hourly/);
    expect(await getMetadata(DB, 'reconciled_through')).toBe('2026-09-04T00:00:00Z');

    await applyTestSchema(DB); // restore the table for later tests
  });

  it('runs the daily rollup when it reconciles the 23:00 hour', async () => {
    await applyTestSchema(DB);
    await seedHour('LEDGER_D', 'egress', '2026-09-05T23:00:00Z', '2026-09-06T00:00:00Z');
    await setMetadata(DB, 'reconciled_through', '2026-09-05T22:00:00Z');

    await reconcileHours(TEST_ENV, new Date('2026-09-06T01:00:00Z'));

    const daily = await DB.prepare('SELECT sample_count FROM tunnel_metrics_daily WHERE tunnel_name = ? AND direction = ? AND ts = ?')
      .bind('LEDGER_D', 'egress', '2026-09-05T00:00:00.000Z').first<{ sample_count: number }>();
    expect(daily?.sample_count).toBe(12);
  });

  it('clamps a watermark older than raw retention to now - 7d', async () => {
    await applyTestSchema(DB);
    await setMetadata(DB, 'reconciled_through', '2020-01-01T00:00:00Z');

    const result = await reconcileHours(TEST_ENV, new Date('2026-09-10T00:00:00Z'));

    // Floor is 2026-09-03T00:00; first hour processed is 01:00, six hours -> 06:00.
    expect(result.reconciledThrough).toBe('2026-09-03T06:00:00Z');
  });
});
