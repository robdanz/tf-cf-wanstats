import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { purgeOldData, insertGapBuckets, storeTunnelMetrics } from '../src/d1';
import { applyTestSchema } from './helpers/schema';

const DB = (env as { DB: D1Database }).DB;
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await applyTestSchema(DB);
});

// Raw ts format (no ms), 5-min aligned.
function rawTsAgo(ms: number): string {
  const t = Math.floor((Date.now() - ms) / (5 * 60 * 1000)) * 5 * 60 * 1000;
  return new Date(t).toISOString().replace('.000Z', 'Z');
}

async function rawCount(tunnel: string): Promise<number> {
  const r = await DB.prepare('SELECT COUNT(*) AS n FROM tunnel_metrics WHERE tunnel_name = ?').bind(tunnel).first<{ n: number }>();
  return r?.n ?? 0;
}

describe('purgeOldData raw retention (chunked by direction + hour)', () => {
  it('deletes rows older than 7 days in both directions and keeps newer ones', async () => {
    const old8 = rawTsAgo(8 * DAY);
    const old9 = rawTsAgo(9 * DAY);
    const recent = rawTsAgo(6 * DAY);
    await storeTunnelMetrics(DB, [
      { tunnelName: 'PURGE_IN', ts: old8, bitRate: 1 },
      { tunnelName: 'PURGE_IN', ts: old9, bitRate: 1 },
      { tunnelName: 'PURGE_IN', ts: recent, bitRate: 1 },
    ], 'ingress');
    // Egress-only residue older than the oldest ingress row must not be stranded.
    await storeTunnelMetrics(DB, [
      { tunnelName: 'PURGE_EG', ts: rawTsAgo(10 * DAY), bitRate: 1 },
      { tunnelName: 'PURGE_EG', ts: recent, bitRate: 1 },
    ], 'egress');

    const result = await purgeOldData(DB);

    expect(result.rawDeleted).toBeGreaterThanOrEqual(3);
    expect(await rawCount('PURGE_IN')).toBe(1);
    expect(await rawCount('PURGE_EG')).toBe(1);
  });
});

describe('purgeOldData rollup retention', () => {
  it('deletes hourly rows older than 60 days and keeps newer ones', async () => {
    const oldHour = new Date(Math.floor((Date.now() - 61 * DAY) / 3600000) * 3600000).toISOString();
    const newHour = new Date(Math.floor((Date.now() - 59 * DAY) / 3600000) * 3600000).toISOString();
    for (const h of [oldHour, newHour]) {
      await DB.prepare(`INSERT OR REPLACE INTO tunnel_metrics_hourly (tunnel_name, direction, ts, avg_bit_rate, max_bit_rate, min_bit_rate, sample_count) VALUES ('PURGE_H', 'ingress', ?, 1, 1, 1, 1)`).bind(h).run();
    }

    const result = await purgeOldData(DB);

    expect(result.hourlyDeleted).toBeGreaterThanOrEqual(1);
    const rows = await DB.prepare("SELECT ts FROM tunnel_metrics_hourly WHERE tunnel_name = 'PURGE_H'").all<{ ts: string }>();
    expect(rows.results.map((r) => r.ts)).toEqual([newHour]);
  });
});

describe('purgeOldData gap_buckets retention', () => {
  it('keeps confirmed-empty buckets as a record for 180 days (the daily rollup horizon), then drops them', async () => {
    const ancientTs = rawTsAgo(200 * DAY);
    const monthOldTs = rawTsAgo(30 * DAY);
    const recentTs = rawTsAgo(60 * 60 * 1000);
    await insertGapBuckets(DB, [{ ts: ancientTs }, { ts: monthOldTs }, { ts: recentTs }], new Date().toISOString());
    await DB.prepare('UPDATE gap_buckets SET attempts = 5, confirmed_empty_at = ? WHERE ts IN (?, ?)')
      .bind(new Date().toISOString(), ancientTs, monthOldTs).run();

    const result = await purgeOldData(DB);

    expect(result.gapTrackingDeleted).toBeGreaterThanOrEqual(1);
    const remaining = await DB.prepare('SELECT ts FROM gap_buckets').all<{ ts: string }>();
    const tss = remaining.results.map((r) => r.ts);
    expect(tss).not.toContain(ancientTs);
    expect(tss).toContain(monthOldTs);
    expect(tss).toContain(recentTs);
  });
});
