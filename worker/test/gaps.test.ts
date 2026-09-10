import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { groupIntoContiguousRanges, retryPendingGaps } from '../src/gaps';
import { insertGapBuckets, getPendingGapBuckets, deleteResolvedGapBuckets } from '../src/d1';
import { applyTestSchema } from './helpers/schema';
import type { TrackedGapBucket } from '../src/types';

function bucket(ts: string, firstDetected: string): TrackedGapBucket {
  return { ts, attempts: 0, firstDetected };
}

describe('groupIntoContiguousRanges', () => {
  it('merges adjacent 5-minute buckets into one range and keeps a gap as a separate range', () => {
    const ranges = groupIntoContiguousRanges([
      bucket('2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z'),
      bucket('2026-01-01T00:05:00Z', '2026-01-01T01:00:00Z'),
      bucket('2026-01-01T00:20:00Z', '2026-01-01T01:00:00Z'),
    ]);

    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toMatchObject({ start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:10:00Z' });
    expect(ranges[0].buckets).toHaveLength(2);
    expect(ranges[1]).toMatchObject({ start: '2026-01-01T00:20:00Z', end: '2026-01-01T00:25:00Z' });
    expect(ranges[1].buckets).toHaveLength(1);
  });

  it('orders ranges by the earliest first_detected among their buckets, oldest first', () => {
    const ranges = groupIntoContiguousRanges([
      bucket('2026-02-01T05:00:00Z', '2026-02-01T06:00:00Z'),
      bucket('2026-02-01T09:00:00Z', '2026-02-01T05:00:00Z'),
    ]);
    expect(ranges.map((r) => r.start)).toEqual(['2026-02-01T09:00:00Z', '2026-02-01T05:00:00Z']);
  });
});

const DB = (env as { DB: D1Database }).DB;
const BUCKET = (env as { RAW_METRICS: R2Bucket }).RAW_METRICS;
const TEST_ENV = { DB, RAW_METRICS: BUCKET, WAN_API_TOKEN: 'token', ACCOUNT_ID: 'acct', BACKFILL_TOKEN: 'x' };

function graphqlResponse(ingressTunnels: Array<{ name: string; ts: string; rate: number }>): Response {
  return Response.json({
    data: {
      viewer: {
        accounts: [{
          ingress: ingressTunnels.map((t) => ({
            avg: { bitRateFiveMinutes: t.rate },
            dimensions: { datetimeFiveMinutes: t.ts, ingressTunnelName: t.name },
          })),
          egress: [],
        }],
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function pendingFor(ts: string): Promise<TrackedGapBucket | undefined> {
  return (await getPendingGapBuckets(DB, 100)).find((p) => p.ts === ts);
}

describe('retryPendingGaps', () => {
  it('deletes a pending bucket once the repoll returns any row for it, and rolls up the affected hour', async () => {
    await applyTestSchema(DB);
    const ts = '2026-08-01T10:05:00Z';
    await insertGapBuckets(DB, [{ ts }], '2026-08-01T09:00:00Z');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(graphqlResponse([{ name: 'TUN_RETRY', ts, rate: 4242 }])));

    await retryPendingGaps(TEST_ENV, new Date('2027-01-01T00:00:00Z'));

    expect(await pendingFor(ts)).toBeUndefined();
    const hourly = await DB.prepare(
      'SELECT sample_count FROM tunnel_metrics_hourly WHERE tunnel_name = ? AND direction = ? AND ts = ?',
    ).bind('TUN_RETRY', 'ingress', '2026-08-01T10:00:00.000Z').first<{ sample_count: number }>();
    expect(hourly?.sample_count).toBe(1);
  });

  it('increments attempts when the repoll succeeds but returns no rows', async () => {
    await applyTestSchema(DB);
    const ts = '2026-08-03T10:05:00Z';
    await insertGapBuckets(DB, [{ ts }], '2026-08-03T09:00:00Z');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(graphqlResponse([])));

    await retryPendingGaps(TEST_ENV, new Date('2027-01-01T00:00:00Z'));

    expect((await pendingFor(ts))?.attempts).toBe(1);
    await deleteResolvedGapBuckets(DB, [{ ts }]);
  });

  it('does not consume a retry attempt when the repoll fetch itself fails', async () => {
    await applyTestSchema(DB);
    const ts = '2026-08-02T10:05:00Z';
    await insertGapBuckets(DB, [{ ts }], '2026-08-02T09:00:00Z');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('server error', { status: 500, headers: { 'Retry-After': '0' } })));

    await retryPendingGaps(TEST_ENV, new Date('2027-01-02T00:00:00Z'));

    expect((await pendingFor(ts))?.attempts).toBe(0);
    await deleteResolvedGapBuckets(DB, [{ ts }]);
  });

  it('leaves a bucket untouched when its slice failed but the neighbouring slice succeeded', async () => {
    await applyTestSchema(DB);
    const okTs = '2026-08-05T10:00:00Z';
    const failTs = '2026-08-05T10:05:00Z';
    await insertGapBuckets(DB, [{ ts: okTs }, { ts: failTs }], '2026-08-05T11:00:00Z');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { variables: { datetimeStart: string } };
      if (body.variables.datetimeStart === '2026-08-05T10:05:00.000Z') {
        return new Response('boom', { status: 500, headers: { 'Retry-After': '0' } });
      }
      return graphqlResponse([]);
    }));

    await retryPendingGaps(TEST_ENV, new Date('2027-01-03T00:00:00Z'));

    expect((await pendingFor(okTs))?.attempts).toBe(1);
    expect((await pendingFor(failTs))?.attempts).toBe(0);
    await deleteResolvedGapBuckets(DB, [{ ts: okTs }, { ts: failTs }]);
  });
});
