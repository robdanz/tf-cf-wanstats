import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { handleCron } from '../src/cron';
import { getMetadata, setMetadata, storeTunnelMetrics, insertGapBuckets, getPendingGapBuckets } from '../src/d1';
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
    // The previous test's ledger recorded its empty 08:00 hour as gap
    // buckets; clear them so the retry step doesn't repoll them with this
    // test's stub and inflate the CRON_OK row count.
    await DB.exec('DELETE FROM gap_buckets');
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
    // Retry runs on every cron; clear gap buckets left behind by an earlier
    // test in this file so they don't get repolled here with this test's own
    // fetch stub and inflate the CRON_LIGHT row count below.
    await DB.exec('DELETE FROM gap_buckets');
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

  it('light run also retries pending gap buckets', async () => {
    await applyTestSchema(DB);
    const ts = '2026-08-13T09:00:00Z';
    await insertGapBuckets(DB, [{ ts }], '2026-08-13T09:06:00Z');

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { variables: { datetimeStart: string } };
      return graphqlRows([{ name: 'CRON_RETRY_LIGHT', ts: body.variables.datetimeStart.replace('.000Z', 'Z'), rate: 7 }]);
    }));

    await handleCron(TEST_ENV, new Date('2026-08-13T10:16:00Z')); // minute 16 -> light run

    expect((await getPendingGapBuckets(DB, 100, new Date('2030-01-01T00:00:00Z'))).find((p) => p.ts === ts)).toBeUndefined();
  });

  it('collect records a failed slice as a pending gap bucket in the same run', async () => {
    await applyTestSchema(DB);
    await DB.exec('DELETE FROM gap_buckets');
    await DB.exec("DELETE FROM cron_metadata WHERE key LIKE 'last_error%'");
    const failStart = '2026-08-14T10:05:00.000Z';
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { variables: { datetimeStart: string } };
      if (body.variables.datetimeStart === failStart) {
        return new Response('boom', { status: 500, headers: { 'Retry-After': '0' } });
      }
      return graphqlRows([{ name: 'CRON_PARTIAL', ts: body.variables.datetimeStart.replace('.000Z', 'Z'), rate: 7 }]);
    }));

    await handleCron(TEST_ENV, new Date('2026-08-14T10:26:00Z')); // light run, 20-min window: 10:05..10:20

    const pending = await getPendingGapBuckets(DB, 100, new Date('2030-01-01T00:00:00Z'));
    expect(pending.map((p) => p.ts)).toContain('2026-08-14T10:05:00Z');
    // A partial failure is not a collect error: the rows that did arrive were stored.
    expect(await getMetadata(DB, 'last_error_step')).toBeNull();
  });

  it('midnight run computes billing before the D1 purge and records each daily step failure separately', async () => {
    await applyTestSchema(DB);
    await DB.exec('DELETE FROM gap_buckets');
    await DB.exec('DELETE FROM billing_p95');
    await DB.exec("DELETE FROM cron_metadata WHERE key LIKE 'last_error%'");
    await setMetadata(DB, 'reconciled_through', '2026-08-15T21:00:00Z');
    // One raw CSV in R2 for the previous month so billing has something to compute.
    await BUCKET.put('raw/2026-07-15/10.csv', 'tunnel_name,direction,ts,bit_rate\nBILL_T,ingress,2026-07-15T10:00:00Z,1000\nBILL_T,egress,2026-07-15T10:00:00Z,500\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(graphqlRows([])));
    // Make the D1 purge fail by hiding the hourly table it walks.
    await DB.exec('ALTER TABLE tunnel_metrics_hourly RENAME TO tunnel_metrics_hourly_bak');
    try {
      await handleCron(TEST_ENV, new Date('2026-08-16T00:01:00Z')); // midnight full run
    } finally {
      await DB.exec('ALTER TABLE tunnel_metrics_hourly_bak RENAME TO tunnel_metrics_hourly');
    }

    const billing = await DB.prepare("SELECT direction, p95_bps FROM billing_p95 WHERE period = '2026-07' AND tunnel_name = '*' ORDER BY direction").all<{ direction: string; p95_bps: number }>();
    expect(billing.results).toEqual([{ direction: 'egress', p95_bps: 500 }, { direction: 'ingress', p95_bps: 1000 }]);
    expect(await getMetadata(DB, 'last_error_purge_d1_message')).toMatch(/tunnel_metrics_hourly/);
    expect(await getMetadata(DB, 'last_error_billing_at')).toBeNull();
    expect(await getMetadata(DB, 'last_full_run_ok')).toBe('false');
  });
});
