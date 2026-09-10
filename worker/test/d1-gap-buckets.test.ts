import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import {
  findMissingBuckets, insertGapBuckets, getPendingGapBuckets, deleteResolvedGapBuckets,
  incrementOrConfirmGapBuckets, getGapBuckets, getGapBucketCounts, getGapBucketRangeCounts,
  storeTunnelMetrics,
} from '../src/d1';
import { applyTestSchema } from './helpers/schema';

const DB = (env as { DB: D1Database }).DB;

beforeAll(async () => {
  await applyTestSchema(DB);
});

describe('findMissingBuckets', () => {
  it('reports only slots with no row in either direction, across every tunnel', async () => {
    // 10:00 ingress only, 10:05 egress only, 10:10 nothing, 10:15 both.
    await storeTunnelMetrics(DB, [
      { tunnelName: 'FMB_A', ts: '2026-02-02T10:00:00Z', bitRate: 1 },
      { tunnelName: 'FMB_A', ts: '2026-02-02T10:15:00Z', bitRate: 1 },
    ], 'ingress');
    await storeTunnelMetrics(DB, [
      { tunnelName: 'FMB_B', ts: '2026-02-02T10:05:00Z', bitRate: 1 },
      { tunnelName: 'FMB_B', ts: '2026-02-02T10:15:00Z', bitRate: 1 },
    ], 'egress');

    const missing = await findMissingBuckets(DB, '2026-02-02T10:00:00Z', '2026-02-02T10:20:00Z');

    expect(missing).toEqual([{ ts: '2026-02-02T10:10:00Z' }]);
  });

  it('emits 12 slots for a full hour with no data, minus any already tracked', async () => {
    await insertGapBuckets(DB, [{ ts: '2026-02-03T05:30:00Z' }], '2026-02-03T07:00:00Z');

    const missing = await findMissingBuckets(DB, '2026-02-03T05:00:00Z', '2026-02-03T06:00:00Z');

    expect(missing).toHaveLength(11);
    expect(missing.map((b) => b.ts)).not.toContain('2026-02-03T05:30:00Z');
    expect(missing[0]).toEqual({ ts: '2026-02-03T05:00:00Z' });
    expect(missing[10]).toEqual({ ts: '2026-02-03T05:55:00Z' });
  });
});

describe('insertGapBuckets + getPendingGapBuckets', () => {
  it('inserts at attempts=0, oldest first_detected first, and INSERT OR IGNORE keeps attempts', async () => {
    await insertGapBuckets(DB, [{ ts: '2026-04-01T00:05:00Z' }], '2026-04-01T01:00:00Z');
    await insertGapBuckets(DB, [{ ts: '2026-04-01T00:00:00Z' }], '2026-04-01T00:30:00Z');
    await incrementOrConfirmGapBuckets(DB, [{ ts: '2026-04-01T00:00:00Z' }], '2026-04-01T00:45:00Z');
    await insertGapBuckets(DB, [{ ts: '2026-04-01T00:00:00Z' }], '2026-04-01T02:00:00Z');

    const pending = (await getPendingGapBuckets(DB, 100)).filter((p) => p.ts.startsWith('2026-04-01'));
    expect(pending.map((p) => p.ts)).toEqual(['2026-04-01T00:00:00Z', '2026-04-01T00:05:00Z']);
    expect(pending[0]).toMatchObject({ attempts: 1, firstDetected: '2026-04-01T00:30:00Z' });
    expect(pending[1]).toMatchObject({ attempts: 0 });
  });

  it('respects the limit', async () => {
    await insertGapBuckets(DB, [
      { ts: '2026-04-05T00:00:00Z' }, { ts: '2026-04-05T00:05:00Z' }, { ts: '2026-04-05T00:10:00Z' },
    ], '2026-04-05T01:00:00Z');
    expect(await getPendingGapBuckets(DB, 2)).toHaveLength(2);
  });
});

describe('incrementOrConfirmGapBuckets', () => {
  it('confirms empty at the third failed retry and drops it from pending', async () => {
    const b = { ts: '2026-05-01T00:00:00Z' };
    await insertGapBuckets(DB, [b], '2026-05-01T00:00:00Z');
    const find = async () => (await getPendingGapBuckets(DB, 100)).find((p) => p.ts === b.ts);

    await incrementOrConfirmGapBuckets(DB, [b], '2026-05-01T01:00:00Z');
    expect((await find())?.attempts).toBe(1);
    await incrementOrConfirmGapBuckets(DB, [b], '2026-05-01T02:00:00Z');
    expect((await find())?.attempts).toBe(2);
    await incrementOrConfirmGapBuckets(DB, [b], '2026-05-01T03:00:00Z');
    expect(await find()).toBeUndefined();

    const rows = await getGapBuckets(DB, '2026-05-01T00:00:00Z', '2026-05-01T00:05:00Z', 'confirmed_empty', 10);
    expect(rows).toEqual([{ ts: b.ts, attempts: 3, first_detected: '2026-05-01T00:00:00Z', confirmed_empty_at: '2026-05-01T03:00:00Z' }]);
  });
});

describe('deleteResolvedGapBuckets', () => {
  it('removes a bucket once data arrives', async () => {
    const b = { ts: '2026-06-01T00:00:00Z' };
    await insertGapBuckets(DB, [b], '2026-06-01T00:00:00Z');
    await deleteResolvedGapBuckets(DB, [b]);
    expect((await getPendingGapBuckets(DB, 100)).find((p) => p.ts === b.ts)).toBeUndefined();
  });
});

describe('getGapBuckets / counts', () => {
  it('filters by status, orders by ts, and counts range totals independently of the page', async () => {
    await insertGapBuckets(DB, [{ ts: '2026-07-01T10:05:00Z' }, { ts: '2026-07-01T10:00:00Z' }], '2026-07-01T12:00:00Z');
    for (const at of ['2026-07-01T13:00:00Z', '2026-07-01T14:00:00Z', '2026-07-01T15:00:00Z']) {
      await incrementOrConfirmGapBuckets(DB, [{ ts: '2026-07-01T10:05:00Z' }], at);
    }

    const all = await getGapBuckets(DB, '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z', null, 10);
    expect(all.map((r) => r.ts)).toEqual(['2026-07-01T10:00:00Z', '2026-07-01T10:05:00Z']);
    const pendingOnly = await getGapBuckets(DB, '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z', 'pending', 10);
    expect(pendingOnly.map((r) => r.ts)).toEqual(['2026-07-01T10:00:00Z']);

    expect(await getGapBucketRangeCounts(DB, '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z')).toEqual({ pending: 1, confirmedEmpty: 1 });
    const counts = await getGapBucketCounts(DB, '2026-07-01T00:00:00Z');
    expect(counts.pending).toBeGreaterThanOrEqual(1);
    expect(counts.confirmedEmpty).toBeGreaterThanOrEqual(1);
  });
});
