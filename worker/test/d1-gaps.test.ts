import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { findMissingGapCells, insertGapCells, getPendingGaps, deleteResolvedGaps, incrementOrConfirmGaps, storeTunnelMetrics } from '../src/d1';
import { applyTestSchema } from './helpers/schema';
import type { GapCell } from '../src/types';

const DB = (env as { DB: D1Database }).DB;

beforeAll(async () => {
  await applyTestSchema(DB);
});

describe('findMissingGapCells', () => {
  it('finds a cell missing for an active tunnel and ignores tunnels outside the 24h roster window', async () => {
    await storeTunnelMetrics(DB, [
      { tunnelName: 'TUN_ROSTER', ts: '2026-02-01T23:00:00Z', bitRate: 100 },
      { tunnelName: 'TUN_ROSTER', ts: '2026-02-02T00:05:00Z', bitRate: 200 },
    ], 'ingress');
    await storeTunnelMetrics(DB, [
      { tunnelName: 'TUN_STALE', ts: '2026-01-01T00:00:00Z', bitRate: 50 },
    ], 'ingress');

    const missing = await findMissingGapCells(
      DB,
      '2026-02-02T00:00:00Z',
      '2026-02-02T00:10:00Z',
      '2026-02-01T00:00:00Z',
    );

    expect(missing).toEqual(expect.arrayContaining([
      { tunnelName: 'TUN_ROSTER', direction: 'ingress', ts: '2026-02-02T00:00:00Z' },
      { tunnelName: 'TUN_ROSTER', direction: 'egress', ts: '2026-02-02T00:00:00Z' },
      { tunnelName: 'TUN_ROSTER', direction: 'egress', ts: '2026-02-02T00:05:00Z' },
    ]));
    expect(missing.some((c) => c.tunnelName === 'TUN_STALE')).toBe(false);
    expect(missing.some((c) => c.tunnelName === 'TUN_ROSTER' && c.direction === 'ingress' && c.ts === '2026-02-02T00:05:00Z')).toBe(false);
  });

  it('excludes cells already tracked in gap_tracking', async () => {
    await storeTunnelMetrics(DB, [
      { tunnelName: 'TUN_TRACKED', ts: '2026-03-01T11:55:00Z', bitRate: 10 },
    ], 'ingress');
    await insertGapCells(DB, [
      { tunnelName: 'TUN_TRACKED', direction: 'ingress', ts: '2026-03-01T12:00:00Z' },
    ], '2026-03-01T12:00:00Z');

    const missing = await findMissingGapCells(
      DB,
      '2026-03-01T12:00:00Z',
      '2026-03-01T12:05:00Z',
      '2026-03-01T00:00:00Z',
    );

    expect(missing.some((c) => c.tunnelName === 'TUN_TRACKED' && c.direction === 'ingress' && c.ts === '2026-03-01T12:00:00Z')).toBe(false);
  });
});

describe('insertGapCells + getPendingGaps', () => {
  it('inserts new cells at attempts=0, ordered by first_detected', async () => {
    await insertGapCells(DB, [{ tunnelName: 'TUN_E', direction: 'egress', ts: '2026-04-01T00:05:00Z' }], '2026-04-01T01:00:00Z');
    await insertGapCells(DB, [{ tunnelName: 'TUN_D', direction: 'ingress', ts: '2026-04-01T00:00:00Z' }], '2026-04-01T00:30:00Z');

    const pending = await getPendingGaps(DB, 100);
    const ours = pending.filter((p) => p.tunnelName === 'TUN_D' || p.tunnelName === 'TUN_E');
    expect(ours.map((p) => p.tunnelName)).toEqual(['TUN_D', 'TUN_E']);
    expect(ours.every((p) => p.attempts === 0)).toBe(true);
  });

  it('does not reset attempts if the same cell is discovered again (INSERT OR IGNORE)', async () => {
    const cell: GapCell = { tunnelName: 'TUN_F', direction: 'ingress', ts: '2026-04-02T00:00:00Z' };
    await insertGapCells(DB, [cell], '2026-04-02T00:00:00Z');
    await incrementOrConfirmGaps(DB, [cell], '2026-04-02T01:00:00Z');
    await insertGapCells(DB, [cell], '2026-04-02T02:00:00Z');

    const row = (await getPendingGaps(DB, 100)).find((p) => p.tunnelName === 'TUN_F');
    expect(row?.attempts).toBe(1);
  });
});

describe('incrementOrConfirmGaps', () => {
  it('increments attempts and confirms empty at the third failed retry', async () => {
    const cell: GapCell = { tunnelName: 'TUN_G', direction: 'egress', ts: '2026-05-01T00:00:00Z' };
    await insertGapCells(DB, [cell], '2026-05-01T00:00:00Z');

    await incrementOrConfirmGaps(DB, [cell], '2026-05-01T01:00:00Z');
    expect((await getPendingGaps(DB, 100)).find((p) => p.tunnelName === 'TUN_G')?.attempts).toBe(1);

    await incrementOrConfirmGaps(DB, [cell], '2026-05-01T02:00:00Z');
    expect((await getPendingGaps(DB, 100)).find((p) => p.tunnelName === 'TUN_G')?.attempts).toBe(2);

    await incrementOrConfirmGaps(DB, [cell], '2026-05-01T03:00:00Z');
    expect((await getPendingGaps(DB, 100)).find((p) => p.tunnelName === 'TUN_G')).toBeUndefined();
  });
});

describe('deleteResolvedGaps', () => {
  it('removes a cell once its data arrives', async () => {
    const cell: GapCell = { tunnelName: 'TUN_H', direction: 'ingress', ts: '2026-06-01T00:00:00Z' };
    await insertGapCells(DB, [cell], '2026-06-01T00:00:00Z');
    await deleteResolvedGaps(DB, [cell]);

    expect((await getPendingGaps(DB, 100)).find((p) => p.tunnelName === 'TUN_H')).toBeUndefined();
  });
});
