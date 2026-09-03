import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { storeTunnelMetrics } from '../src/d1';
import { applyTestSchema } from './helpers/schema';

const DB = (env as { DB: D1Database }).DB;

beforeAll(async () => {
  await applyTestSchema(DB);
});

async function writtenAt(tunnel: string, ts: string): Promise<{ bit_rate: number; written_at: string | null } | null> {
  return DB.prepare('SELECT bit_rate, written_at FROM tunnel_metrics WHERE tunnel_name = ? AND direction = ? AND ts = ?')
    .bind(tunnel, 'ingress', ts).first<{ bit_rate: number; written_at: string | null }>();
}

describe('storeTunnelMetrics written_at', () => {
  it('stamps written_at on insert', async () => {
    await storeTunnelMetrics(DB, [{ tunnelName: 'WA_INSERT', ts: '2026-09-01T00:00:00Z', bitRate: 10 }], 'ingress', '2026-09-01T00:06:00.000Z');
    expect(await writtenAt('WA_INSERT', '2026-09-01T00:00:00Z')).toEqual({ bit_rate: 10, written_at: '2026-09-01T00:06:00.000Z' });
  });

  it('leaves written_at unchanged when the same value is written again', async () => {
    await storeTunnelMetrics(DB, [{ tunnelName: 'WA_SAME', ts: '2026-09-01T00:00:00Z', bitRate: 10 }], 'ingress', '2026-09-01T00:06:00.000Z');
    await storeTunnelMetrics(DB, [{ tunnelName: 'WA_SAME', ts: '2026-09-01T00:00:00Z', bitRate: 10 }], 'ingress', '2026-09-01T00:11:00.000Z');
    expect(await writtenAt('WA_SAME', '2026-09-01T00:00:00Z')).toEqual({ bit_rate: 10, written_at: '2026-09-01T00:06:00.000Z' });
  });

  it('updates bit_rate and written_at when the value changes', async () => {
    await storeTunnelMetrics(DB, [{ tunnelName: 'WA_CHANGE', ts: '2026-09-01T00:00:00Z', bitRate: 10 }], 'ingress', '2026-09-01T00:06:00.000Z');
    await storeTunnelMetrics(DB, [{ tunnelName: 'WA_CHANGE', ts: '2026-09-01T00:00:00Z', bitRate: 12 }], 'ingress', '2026-09-01T00:11:00.000Z');
    expect(await writtenAt('WA_CHANGE', '2026-09-01T00:00:00Z')).toEqual({ bit_rate: 12, written_at: '2026-09-01T00:11:00.000Z' });
  });

  it('defaults written_at to now when the caller omits it', async () => {
    const before = new Date().toISOString();
    await storeTunnelMetrics(DB, [{ tunnelName: 'WA_DEFAULT', ts: '2026-09-01T00:00:00Z', bitRate: 1 }], 'ingress');
    const row = await writtenAt('WA_DEFAULT', '2026-09-01T00:00:00Z');
    expect(row?.written_at).not.toBeNull();
    expect(row!.written_at! >= before).toBe(true);
  });

  it('stamps written_at per D1 batch (BATCH_SIZE = 100), not once for the whole call', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      tunnelName: `WA_CHUNK_${i}`,
      ts: '2026-09-01T00:00:00Z',
      bitRate: 1,
    }));
    await storeTunnelMetrics(DB, rows, 'ingress');

    const result = await DB.prepare(
      "SELECT COUNT(DISTINCT written_at) AS n FROM tunnel_metrics WHERE tunnel_name LIKE 'WA_CHUNK_%'",
    ).first<{ n: number }>();
    expect(result!.n).toBeGreaterThanOrEqual(1);
    expect(result!.n).toBeLessThanOrEqual(3);

    const nullCount = await DB.prepare(
      "SELECT COUNT(*) AS n FROM tunnel_metrics WHERE tunnel_name LIKE 'WA_CHUNK_%' AND written_at IS NULL",
    ).first<{ n: number }>();
    expect(nullCount!.n).toBe(0);
  });
});
