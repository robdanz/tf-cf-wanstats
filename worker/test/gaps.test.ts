import { describe, it, expect } from 'vitest';
import { groupIntoContiguousRanges } from '../src/gaps';
import type { TrackedGapCell } from '../src/types';

function cell(tunnelName: string, direction: 'ingress' | 'egress', ts: string, firstDetected: string): TrackedGapCell {
  return { tunnelName, direction, ts, attempts: 0, firstDetected };
}

describe('groupIntoContiguousRanges', () => {
  it('merges adjacent 5-minute buckets into one range and keeps a gap as a separate range', () => {
    const cells = [
      cell('TUN_A', 'ingress', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z'),
      cell('TUN_A', 'ingress', '2026-01-01T00:05:00Z', '2026-01-01T01:00:00Z'),
      cell('TUN_A', 'ingress', '2026-01-01T00:20:00Z', '2026-01-01T01:00:00Z'),
    ];

    const ranges = groupIntoContiguousRanges(cells);

    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toMatchObject({ start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:10:00Z' });
    expect(ranges[0].cells).toHaveLength(2);
    expect(ranges[1]).toMatchObject({ start: '2026-01-01T00:20:00Z', end: '2026-01-01T00:25:00Z' });
    expect(ranges[1].cells).toHaveLength(1);
  });

  it('orders ranges by the earliest first_detected among their cells, oldest first', () => {
    const cells = [
      cell('TUN_B', 'egress', '2026-02-01T05:00:00Z', '2026-02-01T06:00:00Z'),
      cell('TUN_C', 'egress', '2026-02-01T09:00:00Z', '2026-02-01T05:00:00Z'),
    ];

    const ranges = groupIntoContiguousRanges(cells);

    expect(ranges.map((r) => r.start)).toEqual(['2026-02-01T09:00:00Z', '2026-02-01T05:00:00Z']);
  });
});

import { vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { retryPendingGaps } from '../src/gaps';
import { insertGapCells, getPendingGaps, deleteResolvedGaps } from '../src/d1';
import { applyTestSchema } from './helpers/schema';

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

describe('runGapCheck retry phase', () => {
  it('deletes a pending gap once the repoll returns its data, and rolls up the affected hour', async () => {
    await applyTestSchema(DB);
    const ts = '2026-08-01T10:05:00Z';
    await insertGapCells(DB, [{ tunnelName: 'TUN_RETRY', direction: 'ingress', ts }], '2026-08-01T09:00:00Z');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(graphqlResponse([{ name: 'TUN_RETRY', ts, rate: 4242 }])));

    await retryPendingGaps(TEST_ENV, new Date('2027-01-01T00:00:00Z'));

    expect((await getPendingGaps(DB, 100)).find((p) => p.tunnelName === 'TUN_RETRY')).toBeUndefined();

    const hourly = await DB.prepare(
      'SELECT sample_count FROM tunnel_metrics_hourly WHERE tunnel_name = ? AND direction = ? AND ts = ?',
    ).bind('TUN_RETRY', 'ingress', '2026-08-01T10:00:00.000Z').first<{ sample_count: number }>();
    expect(hourly?.sample_count).toBe(1);
  });

  it('does not consume a retry attempt when the repoll fetch itself fails', async () => {
    await applyTestSchema(DB);
    const ts = '2026-08-02T10:05:00Z';
    await insertGapCells(DB, [{ tunnelName: 'TUN_FAIL', direction: 'egress', ts }], '2026-08-02T09:00:00Z');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('server error', { status: 500, headers: { 'Retry-After': '0' } })));

    await retryPendingGaps(TEST_ENV, new Date('2027-01-02T00:00:00Z'));

    const row = (await getPendingGaps(DB, 100)).find((p) => p.tunnelName === 'TUN_FAIL');
    expect(row?.attempts).toBe(0);

    await deleteResolvedGaps(DB, [{ tunnelName: 'TUN_FAIL', direction: 'egress', ts }]); // avoid leaking into later tests
  });

  it('leaves a cell untouched when its slice failed but the neighbouring slice succeeded', async () => {
    await applyTestSchema(DB);
    const okTs = '2026-08-05T10:00:00Z';
    const failTs = '2026-08-05T10:05:00Z';
    await insertGapCells(DB, [
      { tunnelName: 'TUN_MIXED', direction: 'ingress', ts: okTs },
      { tunnelName: 'TUN_MIXED', direction: 'ingress', ts: failTs },
    ], '2026-08-05T11:00:00Z');

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { variables: { datetimeStart: string } };
      if (body.variables.datetimeStart === '2026-08-05T10:05:00.000Z') {
        return new Response('boom', { status: 500, headers: { 'Retry-After': '0' } });
      }
      return graphqlResponse([]); // slice fetched fine, tunnel still absent
    }));

    await retryPendingGaps(TEST_ENV, new Date('2027-01-03T00:00:00Z'));

    const pending = await getPendingGaps(DB, 100);
    expect(pending.find((p) => p.tunnelName === 'TUN_MIXED' && p.ts === okTs)?.attempts).toBe(1);
    expect(pending.find((p) => p.tunnelName === 'TUN_MIXED' && p.ts === failTs)?.attempts).toBe(0);

    await deleteResolvedGaps(DB, [
      { tunnelName: 'TUN_MIXED', direction: 'ingress', ts: okTs },
      { tunnelName: 'TUN_MIXED', direction: 'ingress', ts: failTs },
    ]);
  });
});
