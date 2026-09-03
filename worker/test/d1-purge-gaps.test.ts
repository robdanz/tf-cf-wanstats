import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { purgeOldData, insertGapCells } from '../src/d1';
import { applyTestSchema } from './helpers/schema';

const DB = (env as { DB: D1Database }).DB;

beforeAll(async () => {
  await applyTestSchema(DB);
});

// Raw ts format, no milliseconds.
function tsAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

describe('purgeOldData gap_tracking retention', () => {
  it('deletes a gap cell whose ts predates raw retention, regardless of status', async () => {
    const oldTs = tsAgo(8 * 24 * 60 * 60 * 1000);
    await insertGapCells(DB, [{ tunnelName: 'TUN_OLD_CONFIRMED', direction: 'ingress', ts: oldTs }], oldTs);
    await DB.prepare('UPDATE gap_tracking SET attempts = 3, confirmed_empty_at = ? WHERE tunnel_name = ?')
      .bind(new Date().toISOString(), 'TUN_OLD_CONFIRMED').run();

    const result = await purgeOldData(DB);
    expect(result.gapTrackingDeleted).toBeGreaterThanOrEqual(1);

    const remaining = await DB.prepare('SELECT tunnel_name FROM gap_tracking WHERE tunnel_name = ?')
      .bind('TUN_OLD_CONFIRMED').all<{ tunnel_name: string }>();
    expect(remaining.results).toEqual([]);
  });

  it('a pending cell 8 days old is deleted; a pending cell 1 hour old survives', async () => {
    const oldTs = tsAgo(8 * 24 * 60 * 60 * 1000);
    const recentTs = tsAgo(60 * 60 * 1000);
    await insertGapCells(DB, [
      { tunnelName: 'TUN_PENDING_OLD', direction: 'ingress', ts: oldTs },
      { tunnelName: 'TUN_PENDING_RECENT', direction: 'ingress', ts: recentTs },
    ], new Date().toISOString());

    await purgeOldData(DB);

    const remaining = await DB.prepare('SELECT tunnel_name FROM gap_tracking').all<{ tunnel_name: string }>();
    const names = remaining.results.map((r) => r.tunnel_name);
    expect(names).not.toContain('TUN_PENDING_OLD');
    expect(names).toContain('TUN_PENDING_RECENT');
  });
});
