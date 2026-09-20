import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { handleApiRequest } from '../src/api';
import { applyTestSchema } from './helpers/schema';

const DB = (env as { DB: D1Database }).DB;
const BUCKET = (env as { RAW_METRICS: R2Bucket }).RAW_METRICS;
const TEST_ENV = { DB, RAW_METRICS: BUCKET, WAN_API_TOKEN: 'token', ACCOUNT_ID: 'acct', BACKFILL_TOKEN: 'x' };

function backfillRequest(): Request {
  return new Request('https://x.test/api/backfill?start=2026-08-01T00:00:00Z&end=2026-08-01T00:10:00Z', {
    method: 'POST',
    headers: { 'X-Backfill-Token': 'x' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/backfill success', () => {
  it('stores rows and rewrites the hourly and (complete-day) daily rollups it touched', async () => {
    await applyTestSchema(DB);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { variables: { datetimeStart: string } };
      const ts = body.variables.datetimeStart.replace('.000Z', 'Z');
      return Response.json({ data: { viewer: { accounts: [{
        ingress: [{ avg: { bitRateFiveMinutes: 42 }, dimensions: { datetimeFiveMinutes: ts, ingressTunnelName: 'BF_ROLL' } }],
        egress: [],
      }] } } });
    }));

    const res = await handleApiRequest(backfillRequest(), TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { ingress_rows: number; rolled_up_hours: string[]; rolled_up_days: string[] };
    expect(body.ingress_rows).toBe(2);
    expect(body.rolled_up_hours).toEqual(['2026-08-01T00:00:00.000Z']);
    expect(body.rolled_up_days).toEqual(['2026-08-01T00:00:00.000Z']);

    const hourly = await DB.prepare('SELECT avg_bit_rate, sample_count FROM tunnel_metrics_hourly WHERE tunnel_name = ? AND direction = ? AND ts = ?')
      .bind('BF_ROLL', 'ingress', '2026-08-01T00:00:00.000Z').first<{ avg_bit_rate: number; sample_count: number }>();
    expect(hourly).toEqual({ avg_bit_rate: 42, sample_count: 2 });
    const daily = await DB.prepare('SELECT sample_count FROM tunnel_metrics_daily WHERE tunnel_name = ? AND direction = ? AND ts = ?')
      .bind('BF_ROLL', 'ingress', '2026-08-01T00:00:00.000Z').first<{ sample_count: number }>();
    expect(daily?.sample_count).toBe(2);
  });
});

describe('POST /api/backfill replace semantics', () => {
  it('removes D1 and R2 rows the source no longer returns for buckets it answered', async () => {
    await applyTestSchema(DB);
    const { storeTunnelMetrics } = await import('../src/d1');
    await storeTunnelMetrics(DB, [{ tunnelName: 'BF_GONE', ts: '2026-08-01T00:00:00Z', bitRate: 5 }], 'egress', '2026-08-01T00:06:00.000Z');
    await BUCKET.put('raw/2026-08-01/00.csv', 'tunnel_name,direction,ts,bit_rate\nBF_GONE,egress,2026-08-01T00:00:00Z,5\n');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { variables: { datetimeStart: string } };
      const ts = body.variables.datetimeStart.replace('.000Z', 'Z');
      return Response.json({ data: { viewer: { accounts: [{
        ingress: [{ avg: { bitRateFiveMinutes: 1 }, dimensions: { datetimeFiveMinutes: ts, ingressTunnelName: 'BF_NEW' } }],
        egress: [],
      }] } } });
    }));

    // The fixture window (2026-08-01) is older than raw retention, so this exercises R2 replace in archive mode;
    // D1 pruning in raw mode is covered by the repoll test.
    const res = await handleApiRequest(backfillRequest(), TEST_ENV);
    expect(res.status).toBe(200);
    const text = await (await BUCKET.get('raw/2026-08-01/00.csv'))!.text();
    expect(text).not.toContain('BF_GONE,');
    expect(text).toContain('BF_NEW,ingress,2026-08-01T00:00:00Z,1');
  });
});

describe('POST /api/backfill archive mode (older than raw retention)', () => {
  it('writes R2 and rollups from the fetched rows but no raw D1 rows', async () => {
    await applyTestSchema(DB);
    const day = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { variables: { datetimeStart: string } };
      const ts = body.variables.datetimeStart.replace('.000Z', 'Z');
      const rate = ts.endsWith(':00:00Z') ? 10 : 30; // two buckets: 10 then 30 -> avg 20
      return Response.json({ data: { viewer: { accounts: [{
        ingress: [{ avg: { bitRateFiveMinutes: rate }, dimensions: { datetimeFiveMinutes: ts, ingressTunnelName: 'BF_OLD' } }],
        egress: [],
      }] } } });
    }));

    const res = await handleApiRequest(new Request(`https://x.test/api/backfill?start=${day}T05:00:00Z&end=${day}T05:10:00Z`, {
      method: 'POST', headers: { 'X-Backfill-Token': 'x' },
    }), TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { mode: string; ingress_rows: number; rolled_up_hours: string[]; rolled_up_days: string[] };
    expect(body.mode).toBe('archive');
    expect(body.ingress_rows).toBe(2);
    expect(body.rolled_up_hours).toEqual([`${day}T05:00:00.000Z`]);
    expect(body.rolled_up_days).toEqual([`${day}T00:00:00.000Z`]);

    const raw = await DB.prepare("SELECT COUNT(*) AS n FROM tunnel_metrics WHERE tunnel_name = 'BF_OLD'").first<{ n: number }>();
    expect(raw?.n).toBe(0);
    const obj = await BUCKET.get(`raw/${day}/05.csv`);
    expect((await obj!.text())).toContain(`BF_OLD,ingress,${day}T05:05:00Z,30`);
    const hourly = await DB.prepare('SELECT avg_bit_rate, max_bit_rate, min_bit_rate, sample_count FROM tunnel_metrics_hourly WHERE tunnel_name = ? AND direction = ? AND ts = ?')
      .bind('BF_OLD', 'ingress', `${day}T05:00:00.000Z`).first();
    expect(hourly).toEqual({ avg_bit_rate: 20, max_bit_rate: 30, min_bit_rate: 10, sample_count: 2 });
    const daily = await DB.prepare('SELECT avg_bit_rate, sample_count FROM tunnel_metrics_daily WHERE tunnel_name = ? AND direction = ? AND ts = ?')
      .bind('BF_OLD', 'ingress', `${day}T00:00:00.000Z`).first();
    expect(daily).toEqual({ avg_bit_rate: 20, sample_count: 2 });
  });
});

describe('POST /api/backfill total failure', () => {
  it('returns 429 with failed_slices when every slice is rate limited', async () => {
    await applyTestSchema(DB);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } }),
    ));

    const res = await handleApiRequest(backfillRequest(), TEST_ENV);
    expect(res.status).toBe(429);
    const body = await res.json() as { ingress_rows: number; egress_rows: number; failed_slices: string[] };
    expect(body.ingress_rows).toBe(0);
    expect(body.egress_rows).toBe(0);
    expect(body.failed_slices).toHaveLength(2);
  });

  it('returns 502 with failed_slices when every slice fails with a server error', async () => {
    await applyTestSchema(DB);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('server error', { status: 500, headers: { 'Retry-After': '0' } }),
    ));

    const res = await handleApiRequest(backfillRequest(), TEST_ENV);
    expect(res.status).toBe(502);
    const body = await res.json() as { ingress_rows: number; egress_rows: number; failed_slices: string[] };
    expect(body.ingress_rows).toBe(0);
    expect(body.egress_rows).toBe(0);
    expect(body.failed_slices).toHaveLength(2);
  });
});
