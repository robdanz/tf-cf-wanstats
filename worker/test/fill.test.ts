import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { rosterFills, recordSeenRows, FILL_BIT_RATE, ROSTER_DAYS } from '../src/fill';
import { repollHours, repollKey } from '../src/repoll';
import { reconcileHours } from '../src/reconcile';
import { handleApiRequest } from '../src/api';
import { setMetadata, storeTunnelMetrics, getRoster } from '../src/d1';
import { applyTestSchema } from './helpers/schema';

const DB = (env as { DB: D1Database }).DB;
const BUCKET = (env as { RAW_METRICS: R2Bucket }).RAW_METRICS;
const TEST_ENV = { DB, RAW_METRICS: BUCKET, WAN_API_TOKEN: 'token', ACCOUNT_ID: 'acct', BACKFILL_TOKEN: 'x' };

type Src = { name: string; dir: 'ingress' | 'egress'; ts: string; rate: number };

// GraphQL stub answering each 5-min slice with the rows in `rows()` for it.
function stubSource(rows: () => Src[]) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { variables: { datetimeStart: string } };
    const ts = body.variables.datetimeStart.replace('.000Z', 'Z');
    const at = rows().filter((r) => r.ts === ts);
    return Response.json({ data: { viewer: { accounts: [{
      ingress: at.filter((r) => r.dir === 'ingress').map((r) => ({ avg: { bitRateFiveMinutes: r.rate }, dimensions: { datetimeFiveMinutes: ts, ingressTunnelName: r.name } })),
      egress: at.filter((r) => r.dir === 'egress').map((r) => ({ avg: { bitRateFiveMinutes: r.rate }, dimensions: { datetimeFiveMinutes: ts, egressTunnelName: r.name } })),
    }] } } });
  }));
}

const bucketsOf = (hour: string) => Array.from({ length: 12 }, (_, i) => `${hour}:${String(i * 5).padStart(2, '0')}:00Z`);

async function freshDb(): Promise<void> {
  await applyTestSchema(DB);
  await DB.exec('DELETE FROM tunnel_seen_days');
  await DB.exec('DELETE FROM tunnel_metrics');
  await DB.exec('DELETE FROM cron_metadata');
  await BUCKET.delete(['raw/2026-10-13/01.csv', 'raw/2026-10-13/10.csv', 'raw/2026-08-02/03.csv']);
}

async function r2Lines(key: string): Promise<string[]> {
  const obj = await BUCKET.get(key);
  return obj === null ? [] : (await obj.text()).trim().split('\n').slice(1);
}

async function d1Value(name: string, dir: string, ts: string) {
  return DB.prepare('SELECT bit_rate, written_at FROM tunnel_metrics WHERE tunnel_name = ? AND direction = ? AND ts = ?')
    .bind(name, dir, ts).first<{ bit_rate: number; written_at: string }>();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rosterFills', () => {
  it('fills every roster tunnel, both directions, in every bucket without a present key', () => {
    const present = new Set(['A|ingress|2026-10-13T12:00:00Z', 'B|egress|2026-10-13T12:05:00Z']);
    const fills = rosterFills(['A', 'B'], ['2026-10-13T12:00:00Z', '2026-10-13T12:05:00Z'], present);
    const keys = (rows: Array<{ tunnelName: string; ts: string; bitRate: number }>) =>
      rows.map((r) => `${r.tunnelName}@${r.ts.slice(11, 16)}=${r.bitRate}`).sort();
    expect(keys(fills.ingress)).toEqual([`A@12:05=${FILL_BIT_RATE}`, `B@12:00=${FILL_BIT_RATE}`, `B@12:05=${FILL_BIT_RATE}`]);
    expect(keys(fills.egress)).toEqual([`A@12:00=${FILL_BIT_RATE}`, `A@12:05=${FILL_BIT_RATE}`, `B@12:00=${FILL_BIT_RATE}`]);
  });
});

describe('roster', () => {
  it(`is tunnels seen in the ${ROSTER_DAYS} days up to the hour; fills and later first sightings do not count`, async () => {
    await freshDb();
    await recordSeenRows(DB, [
      { tunnelName: 'OLD', ts: '2026-10-05T23:55:00Z', bitRate: 5 },      // 8 days before 10-13: out
      { tunnelName: 'WEEK', ts: '2026-10-06T00:00:00Z', bitRate: 5 },     // 7 days before: in
      { tunnelName: 'EARLY', ts: '2026-10-13T09:10:00Z', bitRate: 5 },    // same day, before 10:00 hour ends: in
      { tunnelName: 'LATE', ts: '2026-10-13T11:00:00Z', bitRate: 5 },     // same day, after the hour: out
      { tunnelName: 'FILLONLY', ts: '2026-10-12T09:00:00Z', bitRate: FILL_BIT_RATE },
    ], [
      { tunnelName: 'EGRESSONLY', ts: '2026-10-12T09:00:00Z', bitRate: 5 },
    ]);
    // An earlier sighting the same day lowers first_ts.
    await recordSeenRows(DB, [{ tunnelName: 'LATE', ts: '2026-10-13T10:55:00Z', bitRate: 5 }], []);
    expect((await getRoster(DB, new Date('2026-10-13T10:00:00Z'), ROSTER_DAYS)).sort())
      .toEqual(['EARLY', 'EGRESSONLY', 'LATE', 'WEEK']);
    expect((await getRoster(DB, new Date('2026-10-13T09:00:00Z'), ROSTER_DAYS)).sort())
      .toEqual(['EARLY', 'EGRESSONLY', 'WEEK']);
  });
});

describe('ledger fills (+2h)', () => {
  it('gives every roster tunnel a value in every bucket of the hour in D1 and R2, keeping real values', async () => {
    await freshDb();
    await recordSeenRows(DB, [{ tunnelName: 'IDLE', ts: '2026-10-12T05:00:00Z', bitRate: 5 }], []);
    await storeTunnelMetrics(DB, [{ tunnelName: 'LIVE', ts: '2026-10-13T10:15:00Z', bitRate: 9000 }], 'ingress');
    await setMetadata(DB, 'reconciled_through', '2026-10-13T09:00:00Z');

    await reconcileHours(TEST_ENV, new Date('2026-10-13T12:01:00Z'));

    const lines = await r2Lines('raw/2026-10-13/10.csv');
    expect(lines).toHaveLength(2 * 2 * 12); // IDLE + LIVE, both directions, 12 buckets
    expect(lines).toContain('LIVE,ingress,2026-10-13T10:15:00Z,9000');
    expect(lines.filter((l) => l.endsWith(`,${FILL_BIT_RATE}`))).toHaveLength(47);
    const n = await DB.prepare("SELECT COUNT(*) AS n FROM tunnel_metrics WHERE ts >= '2026-10-13T10:00:00Z' AND ts < '2026-10-13T11:00:00Z' AND direction IN ('ingress','egress')").first<{ n: number }>();
    expect(n?.n).toBe(48);
  });
});

describe('re-poll fills', () => {
  it('fills answered and empty buckets, keeps held values in empty ones, and later real values replace fills', async () => {
    await freshDb();
    const now = new Date('2026-10-13T16:30:00Z'); // 14h pass: hour 01:00
    await setMetadata(DB, repollKey(14), '2026-10-13T00:00:00Z');
    await setMetadata(DB, repollKey(38), '2099-01-01T00:00:00Z');
    await setMetadata(DB, repollKey(62), '2099-01-01T00:00:00Z');
    await recordSeenRows(DB, [{ tunnelName: 'QUIET', ts: '2026-10-10T00:00:00Z', bitRate: 5 }], []);
    // Held before the re-poll: STALE at 01:00 (source no longer returns it), HELD at 01:30 (source answers 01:30 empty).
    await storeTunnelMetrics(DB, [
      { tunnelName: 'QUIET', ts: '2026-10-13T01:00:00Z', bitRate: 4000 },
      { tunnelName: 'QUIET', ts: '2026-10-13T01:30:00Z', bitRate: 3000 },
    ], 'egress', '2026-10-13T02:05:00.000Z');

    let src: Src[] = bucketsOf('2026-10-13T01').filter((ts) => ts !== '2026-10-13T01:30:00Z')
      .map((ts) => ({ name: 'BUSY', dir: 'ingress' as const, ts, rate: 9000 }));
    stubSource(() => src);
    await repollHours(TEST_ENV, now);

    // Answered bucket: the stale held value becomes a fill.
    expect((await d1Value('QUIET', 'egress', '2026-10-13T01:00:00Z'))?.bit_rate).toBe(FILL_BIT_RATE);
    // Empty bucket: the held value stays; missing keys there are filled.
    expect((await d1Value('QUIET', 'egress', '2026-10-13T01:30:00Z'))?.bit_rate).toBe(3000);
    expect((await d1Value('BUSY', 'ingress', '2026-10-13T01:30:00Z'))?.bit_rate).toBe(FILL_BIT_RATE);
    const lines = await r2Lines('raw/2026-10-13/01.csv');
    expect(lines).toHaveLength(2 * 2 * 12);
    expect(lines).toContain('QUIET,egress,2026-10-13T01:30:00Z,3000');
    expect(lines).toContain(`QUIET,ingress,2026-10-13T01:45:00Z,${FILL_BIT_RATE}`);
    expect(lines).toContain(`BUSY,egress,2026-10-13T01:00:00Z,${FILL_BIT_RATE}`);
    const fillStamp = (await d1Value('BUSY', 'egress', '2026-10-13T01:05:00Z'))!.written_at;

    // Next pass: QUIET now has a real egress value at 01:45; everything else unchanged.
    src = [...src, { name: 'QUIET', dir: 'egress', ts: '2026-10-13T01:45:00Z', rate: 2000 }];
    await setMetadata(DB, repollKey(14), '2026-10-13T00:00:00Z');
    await repollHours(TEST_ENV, now);
    expect((await d1Value('QUIET', 'egress', '2026-10-13T01:45:00Z'))?.bit_rate).toBe(2000);
    expect((await d1Value('BUSY', 'egress', '2026-10-13T01:05:00Z'))?.written_at).toBe(fillStamp); // unchanged fill not re-stamped
    const lines2 = await r2Lines('raw/2026-10-13/01.csv');
    expect(lines2).toHaveLength(2 * 2 * 12);
    expect(lines2).toContain('QUIET,egress,2026-10-13T01:45:00Z,2000');
  });
});

describe('archive backfill fills', () => {
  it('fills R2 for roster tunnels and keeps R2 values in buckets the source answers empty', async () => {
    await freshDb();
    await recordSeenRows(DB, [{ tunnelName: 'ARCH', ts: '2026-08-01T00:00:00Z', bitRate: 5 }], []);
    await BUCKET.put('raw/2026-08-02/03.csv', 'tunnel_name,direction,ts,bit_rate\nARCH,ingress,2026-08-02T03:05:00Z,777\n');
    // Source answers only 03:00 (ARCH ingress); 03:05 is empty.
    stubSource(() => [{ name: 'ARCH', dir: 'ingress', ts: '2026-08-02T03:00:00Z', rate: 8000 }]);

    const res = await handleApiRequest(new Request('https://x.test/api/backfill?start=2026-08-02T03:00:00Z&end=2026-08-02T03:10:00Z', {
      method: 'POST', headers: { 'X-Backfill-Token': 'x' },
    }), TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { mode: string; filled_rows: number };
    expect(body.mode).toBe('archive');
    expect(body.filled_rows).toBe(2); // egress at 03:00 and 03:05

    expect((await r2Lines('raw/2026-08-02/03.csv')).sort()).toEqual([
      `ARCH,egress,2026-08-02T03:00:00Z,${FILL_BIT_RATE}`,
      `ARCH,egress,2026-08-02T03:05:00Z,${FILL_BIT_RATE}`,
      'ARCH,ingress,2026-08-02T03:00:00Z,8000',
      'ARCH,ingress,2026-08-02T03:05:00Z,777',
    ]);
    const hourly = await DB.prepare("SELECT sample_count FROM tunnel_metrics_hourly WHERE tunnel_name = 'ARCH' AND direction = 'ingress' AND ts = '2026-08-02T03:00:00.000Z'").first<{ sample_count: number }>();
    expect(hourly?.sample_count).toBe(2);
  });
});
