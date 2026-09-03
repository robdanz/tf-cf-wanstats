import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { handleCron } from '../src/cron';
import { getMetadata, setMetadata, storeTunnelMetrics, insertGapCells, getPendingGaps } from '../src/d1';
import { applyTestSchema } from './helpers/schema';

const DB = (env as { DB: D1Database }).DB;
const BUCKET = (env as { RAW_METRICS: R2Bucket }).RAW_METRICS;
const TEST_ENV = { DB, RAW_METRICS: BUCKET, WAN_API_TOKEN: 'token', ACCOUNT_ID: 'acct', BACKFILL_TOKEN: 'x' };

function graphqlRows(rows: Array<{ name: string; ts: string; rate: number }>): Response {
  return Response.json({
    data: {
      viewer: {
        accounts: [{
          ingress: rows.map((r) => ({ avg: { bitRateFiveMinutes: r.rate }, dimensions: { datetimeFiveMinutes: r.ts, ingressTunnelName: r.name } })),
          egress: [],
        }],
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleCron full run', () => {
  it('records a collect error but still runs the ledger and marks the run not ok', async () => {
    await applyTestSchema(DB);
    await setMetadata(DB, 'reconciled_through', '2026-08-10T07:00:00Z');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('down', { status: 503, headers: { 'Retry-After': '0' } })));

    await handleCron(TEST_ENV, new Date('2026-08-10T10:01:00Z')); // minute 1 -> full run

    expect(await getMetadata(DB, 'last_error_step')).toBe('collect');
    expect(await getMetadata(DB, 'last_full_run_ok')).toBe('false');
    expect(await getMetadata(DB, 'last_full_run_at')).toBe('2026-08-10T10:01:00.000Z');
    // 08:00 is eligible at 10:01 (08:00 + 2h <= 10:01); 09:00 is not.
    expect(await getMetadata(DB, 'reconciled_through')).toBe('2026-08-10T08:00:00Z');
  });

  it('stores rows, marks the run ok, and leaves no error when everything succeeds', async () => {
    await applyTestSchema(DB);
    await setMetadata(DB, 'reconciled_through', '2026-08-11T07:00:00Z');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { variables: { datetimeStart: string } };
      return graphqlRows([{ name: 'CRON_OK', ts: body.variables.datetimeStart.replace('.000Z', 'Z'), rate: 7 }]);
    }));

    await handleCron(TEST_ENV, new Date('2026-08-11T10:01:00Z'));

    expect(await getMetadata(DB, 'last_full_run_ok')).toBe('true');
    expect(await getMetadata(DB, 'last_tunnel_count')).toBe('1');
    const count = await DB.prepare("SELECT COUNT(*) AS n FROM tunnel_metrics WHERE tunnel_name = 'CRON_OK'").first<{ n: number }>();
    expect(count?.n).toBe(13); // 65-minute window -> 13 complete buckets
    expect(await getMetadata(DB, 'reconciled_through')).toBe('2026-08-11T08:00:00Z');
  });

  it('light run stores rows and does not touch the ledger', async () => {
    await applyTestSchema(DB);
    // Retry now runs on every cron (F5b); clear gap cells left behind by an
    // earlier test in this file so they don't get repolled here too, using
    // this test's own fetch stub, and inflate the CRON_LIGHT row count below.
    await DB.exec('DELETE FROM gap_tracking');
    await setMetadata(DB, 'reconciled_through', '2026-08-12T07:00:00Z');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { variables: { datetimeStart: string } };
      return graphqlRows([{ name: 'CRON_LIGHT', ts: body.variables.datetimeStart.replace('.000Z', 'Z'), rate: 7 }]);
    }));

    await handleCron(TEST_ENV, new Date('2026-08-12T10:16:00Z')); // minute 16 -> light run

    const count = await DB.prepare("SELECT COUNT(*) AS n FROM tunnel_metrics WHERE tunnel_name = 'CRON_LIGHT'").first<{ n: number }>();
    expect(count?.n).toBe(4); // 20-minute window -> 4 complete buckets
    expect(await getMetadata(DB, 'reconciled_through')).toBe('2026-08-12T07:00:00Z');
  });

  it('light run also retries pending gap cells', async () => {
    await applyTestSchema(DB);
    const ts = '2026-08-13T09:00:00Z';
    await insertGapCells(DB, [{ tunnelName: 'CRON_RETRY_LIGHT', direction: 'ingress', ts }], '2026-08-13T09:06:00Z');

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { variables: { datetimeStart: string } };
      return graphqlRows([{ name: 'CRON_RETRY_LIGHT', ts: body.variables.datetimeStart.replace('.000Z', 'Z'), rate: 7 }]);
    }));

    await handleCron(TEST_ENV, new Date('2026-08-13T10:16:00Z')); // minute 16 -> light run

    const pending = await getPendingGaps(DB, 100);
    expect(pending.find((p) => p.tunnelName === 'CRON_RETRY_LIGHT')).toBeUndefined();
  });
});
