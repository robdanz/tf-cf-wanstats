import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { handleApiRequest } from '../src/api';
import { storeTunnelMetrics } from '../src/d1';
import { applyTestSchema } from './helpers/schema';

const DB = (env as { DB: D1Database }).DB;
const BUCKET = (env as { RAW_METRICS: R2Bucket }).RAW_METRICS;
const TEST_ENV = { DB, RAW_METRICS: BUCKET, WAN_API_TOKEN: 'token', ACCOUNT_ID: 'acct', BACKFILL_TOKEN: 'x' };

type Row = { tunnel_name: string; direction: string; ts: string; bit_rate_bps: number; written_at: string };
type SinceBody = { mode: string; since: string; next_since: string; truncated: boolean; row_count: number; rows: Row[] };

async function call(query: string): Promise<Response> {
  return handleApiRequest(new Request(`https://x.test/api/current${query}`), TEST_ENV);
}

beforeAll(async () => {
  await applyTestSchema(DB);
  // Three writes at distinct times; the last one is "in the future" relative
  // to the 60s lag so it must be excluded by every test below.
  await storeTunnelMetrics(DB, [{ tunnelName: 'SINCE_A', ts: '2026-09-01T00:00:00Z', bitRate: 1 }], 'ingress', '2026-09-01T00:06:00.000Z');
  await storeTunnelMetrics(DB, [{ tunnelName: 'SINCE_A', ts: '2026-09-01T00:05:00Z', bitRate: 2 }], 'ingress', '2026-09-01T00:11:00.000Z');
  await storeTunnelMetrics(DB, [{ tunnelName: 'SINCE_A', ts: '2026-09-01T00:10:00Z', bitRate: 3 }], 'ingress', new Date(Date.now() + 60 * 60 * 1000).toISOString());
});

describe('/api/current?since=', () => {
  it('returns rows written after since, excludes the last 60 seconds, and hands back next_since', async () => {
    const res = await call('?since=2026-09-01T00:06:00.000Z');
    expect(res.status).toBe(200);
    const body = await res.json() as SinceBody;

    expect(body.mode).toBe('since');
    expect(body.since).toBe('2026-09-01T00:06:00.000Z');
    const ours = body.rows.filter((r) => r.tunnel_name === 'SINCE_A');
    expect(ours.map((r) => r.ts)).toEqual(['2026-09-01T00:05:00Z']);
    expect(ours[0].written_at).toBe('2026-09-01T00:11:00.000Z');
    expect(body.truncated).toBe(false);
    // next_since is now - 60s, so it must be at most now.
    expect(new Date(body.next_since).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('returns nothing when since is at or after the newest eligible write', async () => {
    const res = await call('?since=2026-09-01T00:11:00.000Z');
    const body = await res.json() as SinceBody;
    expect(body.rows.filter((r) => r.tunnel_name === 'SINCE_A')).toEqual([]);
  });

  it('rejects an unparseable since', async () => {
    const res = await call('?since=yesterday');
    expect(res.status).toBe(400);
  });

  it('keeps window mode unchanged apart from the mode field', async () => {
    const res = await call('?window=20');
    const body = await res.json() as { mode: string; window_minutes: number; rows: unknown[] };
    expect(body.mode).toBe('window');
    expect(body.window_minutes).toBe(20);
  });
});

describe('/api/current?since= truncation', () => {
  it('never splits a written_at group across pages', async () => {
    await applyTestSchema(DB);
    // Group 1: 3 rows at T1. Group 2: 3 rows at T2. Cap forced to 4 via test hook.
    const t1 = '2026-09-02T00:06:00.000Z';
    const t2 = '2026-09-02T00:11:00.000Z';
    await storeTunnelMetrics(DB, ['TR_1', 'TR_2', 'TR_3'].map((n) => ({ tunnelName: n, ts: '2026-09-02T00:00:00Z', bitRate: 1 })), 'ingress', t1);
    await storeTunnelMetrics(DB, ['TR_1', 'TR_2', 'TR_3'].map((n) => ({ tunnelName: n, ts: '2026-09-02T00:05:00Z', bitRate: 1 })), 'ingress', t2);

    const res = await call('?since=2026-09-02T00:00:00.000Z&_max_rows=4');
    const body = await res.json() as SinceBody;

    expect(body.truncated).toBe(true);
    expect(body.rows.map((r) => r.written_at)).toEqual([t1, t1, t1]);
    expect(body.next_since).toBe(t1);
  });

  it('returns an oversized written_at group intact instead of splitting it', async () => {
    await applyTestSchema(DB);
    const t1 = '2026-09-03T00:06:00.000Z';
    await storeTunnelMetrics(DB, ['BIG_1', 'BIG_2', 'BIG_3', 'BIG_4', 'BIG_5'].map((n) => ({ tunnelName: n, ts: '2026-09-03T00:00:00Z', bitRate: 1 })), 'ingress', t1);

    const res = await call('?since=2026-09-03T00:00:00.000Z&_max_rows=2');
    const body = await res.json() as SinceBody;

    expect(body.truncated).toBe(true);
    expect(body.rows.filter((r) => r.tunnel_name.startsWith('BIG_'))).toHaveLength(5);
    expect(body.rows.every((r) => r.written_at === t1)).toBe(true);
    expect(body.next_since).toBe(t1);
  });
});
