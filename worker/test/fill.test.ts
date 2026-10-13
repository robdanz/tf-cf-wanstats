import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { absentRowFills, FILL_BIT_RATE } from '../src/fill';
import { repollHours, repollKey, REPOLL_DELAYS_H } from '../src/repoll';
import { setMetadata } from '../src/d1';
import { applyTestSchema } from './helpers/schema';

const DB = (env as { DB: D1Database }).DB;
const BUCKET = (env as { RAW_METRICS: R2Bucket }).RAW_METRICS;
const TEST_ENV = { DB, RAW_METRICS: BUCKET, WAN_API_TOKEN: 'token', ACCOUNT_ID: 'acct', BACKFILL_TOKEN: 'x' };

const row = (tunnelName: string, ts: string, bitRate = 5000) => ({ tunnelName, ts, bitRate });
const keys = (rows: Array<{ tunnelName: string; ts: string; bitRate: number }>) =>
  rows.map((r) => `${r.tunnelName}@${r.ts.slice(11, 16)}=${r.bitRate}`).sort();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('absentRowFills', () => {
  it('fills answered buckets for tunnels live in the same hour, per direction', () => {
    const ingress = [
      row('A', '2026-10-13T12:15:00Z'), row('A', '2026-10-13T12:45:00Z'),
      row('B', '2026-10-13T12:15:00Z'), row('B', '2026-10-13T12:40:00Z'), row('B', '2026-10-13T12:45:00Z'),
    ];
    const egress = [row('A', '2026-10-13T12:40:00Z')];
    const fills = absentRowFills(ingress, egress);
    // Answered buckets: 12:15, 12:40, 12:45 (12:20..12:35 had no rows at all — not ours to fill).
    expect(keys(fills.ingress)).toEqual([`A@12:40=${FILL_BIT_RATE}`]);
    expect(keys(fills.egress)).toEqual([`A@12:15=${FILL_BIT_RATE}`, `A@12:45=${FILL_BIT_RATE}`]);
  });

  it('does not fill a tunnel in an hour where it has no row in that direction', () => {
    const ingress = [
      row('A', '2026-10-13T12:00:00Z'), row('B', '2026-10-13T12:00:00Z'),
      row('A', '2026-10-13T13:00:00Z'), row('A', '2026-10-13T13:05:00Z'),
    ];
    const fills = absentRowFills(ingress, []);
    expect(keys(fills.ingress)).toEqual([]);
    expect(fills.egress).toEqual([]);
  });

  it('fills a gap that crosses the hour boundary from both sides', () => {
    const ingress = [row('A', '2026-10-13T12:50:00Z'), row('A', '2026-10-13T13:10:00Z')];
    // Another tunnel answers every bucket in between.
    for (const t of ['12:50', '12:55', '13:00', '13:05', '13:10']) ingress.push(row('Z', `2026-10-13T${t}:00Z`));
    expect(keys(absentRowFills(ingress, []).ingress))
      .toEqual([`A@12:55=${FILL_BIT_RATE}`, `A@13:00=${FILL_BIT_RATE}`, `A@13:05=${FILL_BIT_RATE}`]);
  });
});

describe('repoll with fills', () => {
  it('stores fills in D1 and R2, and a later real value replaces the fill', async () => {
    await applyTestSchema(DB);
    for (const d of REPOLL_DELAYS_H) await DB.prepare('DELETE FROM cron_metadata WHERE key = ?').bind(repollKey(d)).run();
    const now = new Date('2026-10-13T16:30:00Z'); // 14h newest = 01:00
    await setMetadata(DB, repollKey(14), '2026-10-13T00:00:00Z');
    await setMetadata(DB, repollKey(38), '2099-01-01T00:00:00Z');
    await setMetadata(DB, repollKey(62), '2099-01-01T00:00:00Z');

    // FILL_ON answers every bucket; FILL_GAP only at 01:00 and 01:55.
    let gapRows = ['2026-10-13T01:00:00Z', '2026-10-13T01:55:00Z'];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { variables: { datetimeStart: string } };
      const ts = body.variables.datetimeStart.replace('.000Z', 'Z');
      const names = ['FILL_ON', ...(gapRows.includes(ts) ? ['FILL_GAP'] : [])];
      return Response.json({ data: { viewer: { accounts: [{
        ingress: [],
        egress: names.map((n) => ({ avg: { bitRateFiveMinutes: 9000 }, dimensions: { datetimeFiveMinutes: ts, egressTunnelName: n } })),
      }] } } });
    }));

    await repollHours(TEST_ENV, now);

    const stored = await DB.prepare("SELECT ts, bit_rate FROM tunnel_metrics WHERE tunnel_name = 'FILL_GAP' AND direction = 'egress' ORDER BY ts")
      .all<{ ts: string; bit_rate: number }>();
    expect(stored.results).toHaveLength(12);
    expect(stored.results.filter((r) => r.bit_rate === FILL_BIT_RATE)).toHaveLength(10);
    const lines = (await (await BUCKET.get('raw/2026-10-13/01.csv'))!.text()).trim().split('\n');
    expect(lines).toContain(`FILL_GAP,egress,2026-10-13T01:30:00Z,${FILL_BIT_RATE}`);
    expect(lines.filter((l) => l.startsWith('FILL_GAP,'))).toHaveLength(12);

    // The source later reports 01:30: the next pass replaces that fill.
    gapRows = [...gapRows, '2026-10-13T01:30:00Z'];
    await setMetadata(DB, repollKey(14), '2026-10-13T00:00:00Z');
    await repollHours(TEST_ENV, now);
    const at0130 = await DB.prepare("SELECT bit_rate FROM tunnel_metrics WHERE tunnel_name = 'FILL_GAP' AND direction = 'egress' AND ts = '2026-10-13T01:30:00Z'")
      .first<{ bit_rate: number }>();
    expect(at0130?.bit_rate).toBe(9000);
    const lines2 = (await (await BUCKET.get('raw/2026-10-13/01.csv'))!.text()).trim().split('\n');
    expect(lines2).toContain('FILL_GAP,egress,2026-10-13T01:30:00Z,9000');
    expect(lines2.filter((l) => l.startsWith('FILL_GAP,'))).toHaveLength(12);
  });
});
