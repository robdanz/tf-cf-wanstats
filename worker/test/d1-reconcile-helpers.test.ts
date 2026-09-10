import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { storeTunnelMetrics, getRawRowsForHour, getOldestRawTs, recordCronError, getMetadata } from '../src/d1';
import { applyTestSchema } from './helpers/schema';

const DB = (env as { DB: D1Database }).DB;

beforeAll(async () => {
  await applyTestSchema(DB);
});

describe('getRawRowsForHour', () => {
  it('returns both directions inside the hour and nothing outside it', async () => {
    await storeTunnelMetrics(DB, [
      { tunnelName: 'HR_A', ts: '2026-09-01T09:55:00Z', bitRate: 1 },
      { tunnelName: 'HR_A', ts: '2026-09-01T10:00:00Z', bitRate: 2 },
      { tunnelName: 'HR_A', ts: '2026-09-01T10:55:00Z', bitRate: 3 },
      { tunnelName: 'HR_A', ts: '2026-09-01T11:00:00Z', bitRate: 4 },
    ], 'ingress');
    await storeTunnelMetrics(DB, [
      { tunnelName: 'HR_A', ts: '2026-09-01T10:30:00Z', bitRate: 5 },
    ], 'egress');

    const { ingress, egress } = await getRawRowsForHour(DB, '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z');

    expect(ingress.filter((r) => r.tunnelName === 'HR_A').map((r) => r.bitRate).sort()).toEqual([2, 3]);
    expect(egress.filter((r) => r.tunnelName === 'HR_A')).toEqual([{ tunnelName: 'HR_A', ts: '2026-09-01T10:30:00Z', bitRate: 5 }]);
  });
});

describe('getOldestRawTs', () => {
  it('returns the oldest ingress ts present', async () => {
    await storeTunnelMetrics(DB, [{ tunnelName: 'OLD_A', ts: '2020-01-01T05:10:00Z', bitRate: 1 }], 'ingress');
    expect(await getOldestRawTs(DB)).toBe('2020-01-01T05:10:00Z');
  });
});

describe('recordCronError', () => {
  it('stores step, truncated message, and a timestamp', async () => {
    const before = new Date().toISOString();
    await recordCronError(DB, 'reconcile', new Error('x'.repeat(600)));

    expect(await getMetadata(DB, 'last_error_step')).toBe('reconcile');
    expect((await getMetadata(DB, 'last_error_message'))?.length).toBe(500);
    expect((await getMetadata(DB, 'last_error_at'))! >= before).toBe(true);
  });

  it('stringifies non-Error values', async () => {
    await recordCronError(DB, 'daily', 'plain string');
    expect(await getMetadata(DB, 'last_error_message')).toBe('plain string');
  });

  it('never throws, even when the write itself fails', async () => {
    await DB.exec('DROP TABLE cron_metadata');

    await expect(recordCronError(DB, 'collect', new Error('boom'))).resolves.toBeUndefined();

    await applyTestSchema(DB);
  });
});

import { rollupHour, rollupDay, ROLLUP_HOUR_SQL, ROLLUP_DAY_SQL } from '../src/d1';

// A bare `ts` predicate can't use idx_*_direction_ts and scans the whole
// table — millions of rows at 1000+ tunnels, against D1's 30 s query limit.
// Guard the plan, not just the result.
async function planFor(sql: string, binds: string[]): Promise<string> {
  const { results } = await DB.prepare('EXPLAIN QUERY PLAN ' + sql).bind(...binds).all<{ detail: string }>();
  return results.map((r) => r.detail).join('\n');
}

describe('rollup queries are index-bounded', () => {
  it('rollupHour searches idx_tm_direction_ts per direction and never scans tunnel_metrics', async () => {
    const plan = await planFor(ROLLUP_HOUR_SQL, ['2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z']);
    expect(plan).toMatch(/SEARCH tunnel_metrics USING INDEX idx_tm_direction_ts \(direction=\? AND ts>\? AND ts<\?\)/);
    expect(plan).not.toMatch(/SCAN tunnel_metrics/);
  });

  it('rollupDay searches idx_tmh_direction_ts per direction and never scans tunnel_metrics_hourly', async () => {
    const plan = await planFor(ROLLUP_DAY_SQL, ['2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z']);
    expect(plan).toMatch(/SEARCH tunnel_metrics_hourly USING INDEX idx_tmh_direction_ts \(direction=\? AND ts>\? AND ts<\?\)/);
    expect(plan).not.toMatch(/SCAN tunnel_metrics_hourly/);
  });

  it('rollupHour aggregates both directions of the hour and nothing outside it', async () => {
    await storeTunnelMetrics(DB, [
      { tunnelName: 'RU_A', ts: '2026-09-05T09:55:00Z', bitRate: 100 },
      { tunnelName: 'RU_A', ts: '2026-09-05T10:00:00Z', bitRate: 10 },
      { tunnelName: 'RU_A', ts: '2026-09-05T10:05:00Z', bitRate: 30 },
      { tunnelName: 'RU_A', ts: '2026-09-05T11:00:00Z', bitRate: 100 },
    ], 'ingress');
    await storeTunnelMetrics(DB, [
      { tunnelName: 'RU_A', ts: '2026-09-05T10:30:00Z', bitRate: 7 },
    ], 'egress');

    const changes = await rollupHour(DB, '2026-09-05T10:00:00.000Z');
    expect(changes).toBe(2);

    const rows = await DB.prepare('SELECT direction, avg_bit_rate, max_bit_rate, min_bit_rate, sample_count FROM tunnel_metrics_hourly WHERE tunnel_name = ? AND ts = ? ORDER BY direction')
      .bind('RU_A', '2026-09-05T10:00:00.000Z').all<{ direction: string; avg_bit_rate: number; max_bit_rate: number; min_bit_rate: number; sample_count: number }>();
    expect(rows.results).toEqual([
      { direction: 'egress', avg_bit_rate: 7, max_bit_rate: 7, min_bit_rate: 7, sample_count: 1 },
      { direction: 'ingress', avg_bit_rate: 20, max_bit_rate: 30, min_bit_rate: 10, sample_count: 2 },
    ]);

    const day = await rollupDay(DB, '2026-09-05T00:00:00.000Z');
    expect(day).toBeGreaterThanOrEqual(2);
  });
});
