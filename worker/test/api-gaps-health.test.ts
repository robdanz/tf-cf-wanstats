import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { handleApiRequest } from '../src/api';
import { insertGapBuckets, incrementOrConfirmGapBuckets, setMetadata, recordCronError } from '../src/d1';
import { applyTestSchema } from './helpers/schema';

const DB = (env as { DB: D1Database }).DB;
const BUCKET = (env as { RAW_METRICS: R2Bucket }).RAW_METRICS;
const TEST_ENV = { DB, RAW_METRICS: BUCKET, WAN_API_TOKEN: 'token', ACCOUNT_ID: 'acct', BACKFILL_TOKEN: 'x' };

type Cell = { tunnel_name: string; direction: string; ts: string; status: string; attempts: number; first_detected: string; confirmed_empty_at: string | null };
type GapsBody = { start: string; end: string; pending: number; confirmed_empty: number; truncated: boolean; cells: Cell[] };
type StepError = { at: string; message: string } | null;
type HealthBody = {
  last_cron_run: string | null; last_tunnel_count: number | null; last_full_run_at: string | null;
  last_full_run_ok: boolean | null; reconciled_through: string | null; hours_behind: number | null;
  pending_gaps: number; confirmed_empty_7d: number; last_error: { at: string; step: string; message: string } | null;
  step_errors: Record<'collect' | 'retry' | 'reconcile' | 'billing' | 'purge_d1' | 'purge_r2', StepError>;
};

async function get(path: string): Promise<Response> {
  return handleApiRequest(new Request(`https://x.test${path}`), TEST_ENV);
}

beforeAll(async () => {
  await applyTestSchema(DB);
  await insertGapBuckets(DB, [{ ts: '2026-09-01T10:05:00Z' }, { ts: '2026-09-01T10:10:00Z' }], '2026-09-01T12:01:00Z');
  for (const at of ['2026-09-01T13:01:00Z', '2026-09-01T14:01:00Z', '2026-09-01T15:01:00Z']) {
    await incrementOrConfirmGapBuckets(DB, [{ ts: '2026-09-01T10:10:00Z' }], at);
  }
});

describe('/api/gaps', () => {
  it('lists buckets in range with the legacy cell shape and "*" sentinels', async () => {
    const res = await get('/api/gaps?start=2026-09-01T10:00:00Z&end=2026-09-01T11:00:00Z');
    expect(res.status).toBe(200);
    const body = await res.json() as GapsBody;

    expect(body.cells).toEqual([
      { tunnel_name: '*', direction: '*', ts: '2026-09-01T10:05:00Z', status: 'pending', attempts: 0, first_detected: '2026-09-01T12:01:00Z', confirmed_empty_at: null },
      { tunnel_name: '*', direction: '*', ts: '2026-09-01T10:10:00Z', status: 'confirmed_empty', attempts: 3, first_detected: '2026-09-01T12:01:00Z', confirmed_empty_at: '2026-09-01T15:01:00Z' },
    ]);
    expect(body.pending).toBe(1);
    expect(body.confirmed_empty).toBe(1);
    expect(body.truncated).toBe(false);
  });

  it('filters by status and ignores the legacy tunnel filter', async () => {
    const byTunnel = await (await get('/api/gaps?start=2026-09-01T10:00:00Z&end=2026-09-01T11:00:00Z&tunnel=ANY')).json() as GapsBody;
    expect(byTunnel.cells).toHaveLength(2);

    const byStatus = await (await get('/api/gaps?start=2026-09-01T10:00:00Z&end=2026-09-01T11:00:00Z&status=pending')).json() as GapsBody;
    expect(byStatus.cells.map((c) => c.ts)).toEqual(['2026-09-01T10:05:00Z']);
    expect(byStatus.confirmed_empty).toBe(1);
  });

  it('rejects a missing range, a bad status, a span over 7 days, and end <= start', async () => {
    expect((await get('/api/gaps')).status).toBe(400);
    expect((await get('/api/gaps?start=2026-09-01T00:00:00Z&end=2026-09-02T00:00:00Z&status=nope')).status).toBe(400);
    expect((await get('/api/gaps?start=2026-09-01T00:00:00Z&end=2026-09-09T00:00:01Z')).status).toBe(400);
    expect((await get('/api/gaps?start=2026-09-01T00:00:00Z&end=2026-09-01T00:00:00Z')).status).toBe(400);
    expect((await get('/api/gaps?start=2026-09-01T00:00:00Z&end=2026-08-31T00:00:00Z')).status).toBe(400);
  });
});

describe('/api/health', () => {
  it('reports null fields when nothing has run yet', async () => {
    await applyTestSchema(DB);
    await DB.exec('DELETE FROM cron_metadata');
    const body = await (await get('/api/health')).json() as HealthBody;
    expect(body.last_full_run_at).toBeNull();
    expect(body.last_full_run_ok).toBeNull();
    expect(body.reconciled_through).toBeNull();
    expect(body.hours_behind).toBeNull();
    expect(body.last_error).toBeNull();
    expect(body.step_errors).toEqual({ collect: null, retry: null, reconcile: null, billing: null, purge_d1: null, purge_r2: null });
  });

  it('reflects metadata keys, computes hours_behind, counts buckets, and exposes per-step errors', async () => {
    await applyTestSchema(DB);
    await setMetadata(DB, 'last_cron_run', '2026-09-03T13:35:00.000Z');
    await setMetadata(DB, 'last_tunnel_count', '8');
    await setMetadata(DB, 'last_full_run_at', '2026-09-03T13:01:00.000Z');
    await setMetadata(DB, 'last_full_run_ok', 'false');
    await recordCronError(DB, 'billing', new Error('r2 exploded'));
    await recordCronError(DB, 'collect', new Error('all 13 slice(s) failed'));
    // Watermark exactly 7 hours before the current hour boundary, so
    // now - 2h - watermark is in [5h, 6h) and floors to 5 at any wall-clock.
    const HOUR = 60 * 60 * 1000;
    const watermark = new Date(Math.floor(Date.now() / HOUR) * HOUR - 7 * HOUR).toISOString().replace('.000Z', 'Z');
    await setMetadata(DB, 'reconciled_through', watermark);

    const body = await (await get('/api/health')).json() as HealthBody;

    expect(body.last_cron_run).toBe('2026-09-03T13:35:00.000Z');
    expect(body.last_tunnel_count).toBe(8);
    expect(body.last_full_run_ok).toBe(false);
    expect(body.hours_behind).toBe(5);
    expect(body.pending_gaps).toBeGreaterThanOrEqual(1);
    expect(body.last_error).toMatchObject({ step: 'collect', message: 'all 13 slice(s) failed' });
    expect(body.step_errors.collect).toMatchObject({ message: 'all 13 slice(s) failed' });
    expect(body.step_errors.billing).toMatchObject({ message: 'r2 exploded' });
    expect(body.step_errors.reconcile).toBeNull();
  });
});
