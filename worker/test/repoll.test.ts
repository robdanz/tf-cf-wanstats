import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { repollHours, repollKey, newestEligibleHour, REPOLL_DELAYS_H, MAX_REPOLL_HOURS_PER_PASS, INITIAL_CATCHUP_H } from '../src/repoll';
import { storeTunnelMetrics, setMetadata, getMetadata, insertGapBuckets, getPendingGapBuckets } from '../src/d1';
import { applyTestSchema } from './helpers/schema';

const DB = (env as { DB: D1Database }).DB;
const BUCKET = (env as { RAW_METRICS: R2Bucket }).RAW_METRICS;
const TEST_ENV = { DB, RAW_METRICS: BUCKET, WAN_API_TOKEN: 'token', ACCOUNT_ID: 'acct', BACKFILL_TOKEN: 'x' };

// GraphQL stub: one ingress row per slice for `name` at `rate`, plus any
// extra rows whose ts matches the slice.
function stubGraphql(name: string, rate: number, extra: Array<{ name: string; ts: string; rate: number }> = [], failStart?: string) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { variables: { datetimeStart: string } };
    const start = body.variables.datetimeStart;
    if (failStart !== undefined && start === failStart) {
      return new Response('boom', { status: 500, headers: { 'Retry-After': '0' } });
    }
    const ts = start.replace('.000Z', 'Z');
    const rows = [{ name, ts, rate }, ...extra.filter((e) => e.ts === ts)];
    return Response.json({
      data: { viewer: { accounts: [{
        ingress: rows.map((r) => ({ avg: { bitRateFiveMinutes: r.rate }, dimensions: { datetimeFiveMinutes: r.ts, ingressTunnelName: r.name } })),
        egress: [],
      }] } },
    });
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function clearRepollState(): Promise<void> {
  for (const d of REPOLL_DELAYS_H) await DB.prepare('DELETE FROM cron_metadata WHERE key = ?').bind(repollKey(d)).run();
}

describe('newestEligibleHour', () => {
  it('is the last complete hour that ended at least delay hours ago', () => {
    // 14h delay at 2026-09-20T16:30 -> 02:30 snapped to 02:00, minus 1h = 01:00 (ended 02:00, 14.5h ago).
    expect(newestEligibleHour(new Date('2026-09-20T16:30:00Z'), 14)).toEqual(new Date('2026-09-20T01:00:00Z'));
    expect(newestEligibleHour(new Date('2026-09-20T16:00:00Z'), 14)).toEqual(new Date('2026-09-20T01:00:00Z'));
    expect(newestEligibleHour(new Date('2026-09-20T15:59:00Z'), 14)).toEqual(new Date('2026-09-20T00:00:00Z'));
  });
});

describe('repollHours', () => {
  it('first run starts INITIAL_CATCHUP_H back and stores what the source has now', async () => {
    await applyTestSchema(DB);
    await clearRepollState();
    const now = new Date('2026-09-20T16:30:00Z');
    // 14h newest = 09-20 01:00; first run starts 26h earlier and walks 3 hours: 09-18 23:00 .. 09-19 01:00.
    // Pin the 14h pass so this test's assertions on hour 01:00 hold; let the 38h pass do its first-run catch-up.
    await setMetadata(DB, repollKey(14), '2026-09-20T00:00:00Z');
    const h14 = '2026-09-20T01:00:00Z';
    const h38 = '2026-09-18T01:00:00Z'; // 38h newest = 09-19 01:00, minus 26h = 09-17 23:00, +3 hours -> 09-18 02:00? see below
    // What the collector stored at the time: 12 buckets at rate 5 for REPOLL_A, no row for REPOLL_LATE.
    const rows = [];
    for (let i = 0; i < 12; i++) rows.push({ tunnelName: 'REPOLL_A', ts: `2026-09-20T01:${String(i * 5).padStart(2, '0')}:00Z`, bitRate: 5 });
    await storeTunnelMetrics(DB, rows, 'ingress', '2026-09-20T02:05:00.000Z');
    // What the source says now: REPOLL_A revised to 7, and a new row for REPOLL_LATE at 01:20.
    stubGraphql('REPOLL_A', 7, [{ name: 'REPOLL_LATE', ts: '2026-09-20T01:20:00Z', rate: 1066 }]);

    const results = await repollHours(TEST_ENV, now);

    // 38h pass: watermark 09-19 01:00 - 26h = 09-17 23:00; processes 00:00, 01:00, 02:00 on 09-18; 23 hours still behind.
    expect(results.map((r) => [r.delayH, r.processed, r.hoursBehind, r.through]))
      .toEqual([[14, 1, 0, h14], [38, MAX_REPOLL_HOURS_PER_PASS, INITIAL_CATCHUP_H - MAX_REPOLL_HOURS_PER_PASS, '2026-09-18T02:00:00Z']]);
    expect(await getMetadata(DB, repollKey(14))).toBe(h14);
    expect(await getMetadata(DB, repollKey(38))).toBe('2026-09-18T02:00:00Z');
    void h38;

    const late = await DB.prepare('SELECT bit_rate FROM tunnel_metrics WHERE tunnel_name = ? AND direction = ? AND ts = ?')
      .bind('REPOLL_LATE', 'ingress', '2026-09-20T01:20:00Z').first<{ bit_rate: number }>();
    expect(late?.bit_rate).toBe(1066);
    const revised = await DB.prepare('SELECT bit_rate, written_at FROM tunnel_metrics WHERE tunnel_name = ? AND direction = ? AND ts = ?')
      .bind('REPOLL_A', 'ingress', '2026-09-20T01:00:00Z').first<{ bit_rate: number; written_at: string }>();
    expect(revised?.bit_rate).toBe(7);
    expect(revised?.written_at).not.toBe('2026-09-20T02:05:00.000Z'); // corrected rows get a new written_at

    const obj = await BUCKET.get('raw/2026-09-20/01.csv');
    const lines = (await obj!.text()).trim().split('\n');
    expect(lines).toContain('REPOLL_LATE,ingress,2026-09-20T01:20:00Z,1066');
    expect(lines.filter((l) => l.startsWith('REPOLL_A,ingress,'))).toHaveLength(12);

    const hourly = await DB.prepare('SELECT avg_bit_rate, sample_count FROM tunnel_metrics_hourly WHERE tunnel_name = ? AND direction = ? AND ts = ?')
      .bind('REPOLL_A', 'ingress', '2026-09-20T01:00:00.000Z').first<{ avg_bit_rate: number; sample_count: number }>();
    expect(hourly).toEqual({ avg_bit_rate: 7, sample_count: 12 });
  });

  it('walks forward from the stored watermark, capped per pass, and reports the backlog', async () => {
    await applyTestSchema(DB);
    await clearRepollState();
    const now = new Date('2026-09-20T16:30:00Z'); // 14h newest = 01:00 on 09-20
    await setMetadata(DB, repollKey(14), '2026-09-19T18:00:00Z'); // 7 hours behind: 19:00 .. 01:00
    await setMetadata(DB, repollKey(38), '2026-09-19T00:00:00Z'); // 38h newest = 09-19 01:00 -> 1 hour
    stubGraphql('REPOLL_B', 3);

    const results = await repollHours(TEST_ENV, now);

    const p14 = results.find((r) => r.delayH === 14)!;
    expect(p14.processed).toBe(MAX_REPOLL_HOURS_PER_PASS);
    expect(p14.through).toBe('2026-09-19T21:00:00Z');
    expect(p14.hoursBehind).toBe(7 - MAX_REPOLL_HOURS_PER_PASS);
    const p38 = results.find((r) => r.delayH === 38)!;
    expect(p38).toMatchObject({ processed: 1, through: '2026-09-19T01:00:00Z', hoursBehind: 0 });
  });

  it('does not advance past an hour with a failed slice, finishes the other pass, then throws', async () => {
    await applyTestSchema(DB);
    await clearRepollState();
    const now = new Date('2026-09-20T16:30:00Z');
    await setMetadata(DB, repollKey(14), '2026-09-19T23:00:00Z'); // due: 00:00 and 01:00
    await setMetadata(DB, repollKey(38), '2026-09-19T00:00:00Z'); // due: 09-19 01:00
    stubGraphql('REPOLL_C', 3, [], '2026-09-20T00:25:00.000Z');

    await expect(repollHours(TEST_ENV, now)).rejects.toThrow(/14h@2026-09-20T00:00:00Z/);

    expect(await getMetadata(DB, repollKey(14))).toBe('2026-09-19T23:00:00Z');
    expect(await getMetadata(DB, repollKey(38))).toBe('2026-09-19T01:00:00Z');
    // Nothing from the failed hour was stored: a partial hour would leave the
    // consumer with a mix of old and new values until the retry.
    const n = await DB.prepare("SELECT COUNT(*) AS n FROM tunnel_metrics WHERE tunnel_name = 'REPOLL_C' AND ts >= '2026-09-20T00:00:00Z' AND ts < '2026-09-20T01:00:00Z'").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('rewrites the daily rollup when it re-polls the 23:00 hour', async () => {
    await applyTestSchema(DB);
    await clearRepollState();
    const now = new Date('2026-09-20T16:30:00Z');
    await setMetadata(DB, repollKey(14), '2026-09-19T22:00:00Z'); // due: 23:00 (09-19), 00:00, 01:00 (09-20)
    await setMetadata(DB, repollKey(38), '2026-09-19T01:00:00Z'); // nothing due
    stubGraphql('REPOLL_D', 9);

    await repollHours(TEST_ENV, now);

    const daily = await DB.prepare('SELECT sample_count, avg_bit_rate FROM tunnel_metrics_daily WHERE tunnel_name = ? AND direction = ? AND ts = ?')
      .bind('REPOLL_D', 'ingress', '2026-09-19T00:00:00.000Z').first<{ sample_count: number; avg_bit_rate: number }>();
    expect(daily).toEqual({ sample_count: 12, avg_bit_rate: 9 });
  });

  it('removes rows the source no longer returns, but keeps rows of a bucket the source answers empty', async () => {
    await applyTestSchema(DB);
    await clearRepollState();
    const now = new Date('2026-09-20T16:30:00Z'); // 14h -> hour 01:00 on 09-20
    await setMetadata(DB, repollKey(14), '2026-09-20T00:00:00Z'); // due: 01:00 only
    await setMetadata(DB, repollKey(38), '2026-09-19T01:00:00Z'); // nothing due
    // Stored earlier: DROPPED at 01:00 (source will not return it), STAYS at 01:30 (source returns nothing for that bucket).
    await storeTunnelMetrics(DB, [
      { tunnelName: 'DROPPED', ts: '2026-09-20T01:00:00Z', bitRate: 5 },
      { tunnelName: 'STAYS', ts: '2026-09-20T01:30:00Z', bitRate: 5 },
    ], 'egress', '2026-09-20T02:05:00.000Z');
    await BUCKET.put('raw/2026-09-20/01.csv', 'tunnel_name,direction,ts,bit_rate\nDROPPED,egress,2026-09-20T01:00:00Z,5\nSTAYS,egress,2026-09-20T01:30:00Z,5\n');
    // Source now: REPOLL_F ingress in every bucket except 01:30, which is empty.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { variables: { datetimeStart: string } };
      const ts = body.variables.datetimeStart.replace('.000Z', 'Z');
      const rows = ts === '2026-09-20T01:30:00Z' ? [] : [{ avg: { bitRateFiveMinutes: 1 }, dimensions: { datetimeFiveMinutes: ts, ingressTunnelName: 'REPOLL_F' } }];
      return Response.json({ data: { viewer: { accounts: [{ ingress: rows, egress: [] }] } } });
    }));

    await repollHours(TEST_ENV, now);

    const names = await DB.prepare("SELECT tunnel_name || '@' || ts AS k FROM tunnel_metrics WHERE direction = 'egress' AND ts >= '2026-09-20T01:00:00Z' AND ts < '2026-09-20T02:00:00Z' ORDER BY k").all<{ k: string }>();
    expect(names.results.map((r) => r.k)).toEqual(['STAYS@2026-09-20T01:30:00Z']);
    const text = await (await BUCKET.get('raw/2026-09-20/01.csv'))!.text();
    expect(text).not.toContain('DROPPED,');
    expect(text).toContain('STAYS,egress,2026-09-20T01:30:00Z,5');
    expect(text).toContain('REPOLL_F,ingress,2026-09-20T01:00:00Z,1');
  });

  it('clears gap_buckets for buckets the source now answers with rows', async () => {
    await applyTestSchema(DB);
    await clearRepollState();
    await DB.exec('DELETE FROM gap_buckets');
    const now = new Date('2026-09-20T16:30:00Z');
    await setMetadata(DB, repollKey(14), '2026-09-20T00:00:00Z'); // due: 01:00
    await setMetadata(DB, repollKey(38), '2026-09-19T01:00:00Z'); // nothing due
    await insertGapBuckets(DB, [{ ts: '2026-09-20T01:10:00Z' }, { ts: '2026-09-20T01:15:00Z' }], '2026-09-20T03:00:00Z');
    // Source answers every bucket except 01:15 (still empty -> still a gap).
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { variables: { datetimeStart: string } };
      const ts = body.variables.datetimeStart.replace('.000Z', 'Z');
      const rows = ts === '2026-09-20T01:15:00Z' ? [] : [{ avg: { bitRateFiveMinutes: 1 }, dimensions: { datetimeFiveMinutes: ts, ingressTunnelName: 'REPOLL_G' } }];
      return Response.json({ data: { viewer: { accounts: [{ ingress: rows, egress: [] }] } } });
    }));

    await repollHours(TEST_ENV, now);

    const pending = (await getPendingGapBuckets(DB, 100, new Date('2030-01-01T00:00:00Z'))).map((p) => p.ts);
    expect(pending).not.toContain('2026-09-20T01:10:00Z');
    expect(pending).toContain('2026-09-20T01:15:00Z');
  });

  it('clamps a watermark older than raw retention', async () => {
    await applyTestSchema(DB);
    await clearRepollState();
    const now = new Date('2026-09-20T16:30:00Z');
    await setMetadata(DB, repollKey(14), '2020-01-01T00:00:00Z');
    await setMetadata(DB, repollKey(38), '2026-09-19T01:00:00Z');
    stubGraphql('REPOLL_E', 1);

    const results = await repollHours(TEST_ENV, now);

    // Floor 2026-09-13T16:00; first hour 17:00, three hours -> 19:00.
    expect(results.find((r) => r.delayH === 14)!.through).toBe('2026-09-13T19:00:00Z');
  });
});
