import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { purgeOldData, insertGapCells } from '../src/d1';
import { applyTestSchema } from './helpers/schema';

const DB = (env as { DB: D1Database }).DB;

beforeAll(async () => {
  await applyTestSchema(DB);
});

describe('purgeOldData gap_tracking retention', () => {
  it('purges confirmed-empty rows older than 7 days but keeps pending and recent rows', async () => {
    await insertGapCells(DB, [
      { tunnelName: 'TUN_OLD', direction: 'ingress', ts: '2020-01-01T00:00:00Z' },
      { tunnelName: 'TUN_RECENT', direction: 'ingress', ts: '2020-01-01T00:05:00Z' },
      { tunnelName: 'TUN_PENDING', direction: 'ingress', ts: '2020-01-01T00:10:00Z' },
    ], '2020-01-01T00:00:00Z');

    await DB.prepare('UPDATE gap_tracking SET attempts = 3, confirmed_empty_at = ? WHERE tunnel_name = ?')
      .bind(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), 'TUN_OLD').run();
    await DB.prepare('UPDATE gap_tracking SET attempts = 3, confirmed_empty_at = ? WHERE tunnel_name = ?')
      .bind(new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(), 'TUN_RECENT').run();

    const result = await purgeOldData(DB);
    expect(result.gapTrackingDeleted).toBe(1);

    const remaining = await DB.prepare('SELECT tunnel_name FROM gap_tracking').all<{ tunnel_name: string }>();
    const names = remaining.results.map((r) => r.tunnel_name);
    expect(names).not.toContain('TUN_OLD');
    expect(names).toContain('TUN_RECENT');
    expect(names).toContain('TUN_PENDING');
  });
});
