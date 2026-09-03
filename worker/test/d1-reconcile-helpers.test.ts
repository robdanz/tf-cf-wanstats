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
});
