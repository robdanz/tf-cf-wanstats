import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { handleApiRequest } from '../src/api';
import type { Env } from '../src/types';

const TEST_TOKEN = 'test-backfill-token';

function makeEnv(): Env {
  return {
    ...(env as object),
    BACKFILL_TOKEN: TEST_TOKEN,
  } as Env;
}

function cleanupRequest(date: string | null, token: string | null): Request {
  const url = date
    ? `https://example.com/api/cleanup?date=${date}`
    : 'https://example.com/api/cleanup';
  return new Request(url, {
    method: 'POST',
    headers: token ? { 'X-Backfill-Token': token } : {},
  });
}

const BUCKET = (env as { RAW_METRICS: R2Bucket }).RAW_METRICS;

describe('POST /api/cleanup', () => {
  it('rejects requests without a valid backfill token', async () => {
    const res = await handleApiRequest(cleanupRequest('2026-02-01', 'wrong'), makeEnv());
    expect(res.status).toBe(401);
  });

  it('rejects a missing or malformed date', async () => {
    const missing = await handleApiRequest(cleanupRequest(null, TEST_TOKEN), makeEnv());
    expect(missing.status).toBe(400);

    const malformed = await handleApiRequest(cleanupRequest('07-15-2026', TEST_TOKEN), makeEnv());
    expect(malformed.status).toBe(400);
  });

  it('collapses duplicate keys to the max value across every hour file of the day', async () => {
    await BUCKET.put(
      'raw/2026-02-01/09.csv',
      'tunnel_name,direction,ts,bit_rate\n' +
        'TUN_D,egress,2026-02-01T09:55:00Z,23002560\n' +
        'TUN_D,egress,2026-02-01T09:55:00Z,24036213\n' +
        'TUN_D,ingress,2026-02-01T09:55:00Z,16655733\n',
    );
    await BUCKET.put(
      'raw/2026-02-01/10.csv',
      'tunnel_name,direction,ts,bit_rate\n' +
        'TUN_D,egress,2026-02-01T10:00:00Z,17155226\n' +
        'TUN_D,egress,2026-02-01T10:00:00Z,559973\n',
    );

    const res = await handleApiRequest(cleanupRequest('2026-02-01', TEST_TOKEN), makeEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { date: string; filesProcessed: number; duplicatesRemoved: number };
    expect(body).toEqual({ date: '2026-02-01', filesProcessed: 2, duplicatesRemoved: 2 });

    const h9 = await (await BUCKET.get('raw/2026-02-01/09.csv'))!.text();
    expect(h9).toBe(
      'tunnel_name,direction,ts,bit_rate\n' +
        'TUN_D,egress,2026-02-01T09:55:00Z,24036213\n' +
        'TUN_D,ingress,2026-02-01T09:55:00Z,16655733\n',
    );

    const h10 = await (await BUCKET.get('raw/2026-02-01/10.csv'))!.text();
    expect(h10).toBe(
      'tunnel_name,direction,ts,bit_rate\n' +
        'TUN_D,egress,2026-02-01T10:00:00Z,17155226\n',
    );
  });

  it('reports zero work for a day with no files', async () => {
    const res = await handleApiRequest(cleanupRequest('2026-02-02', TEST_TOKEN), makeEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { filesProcessed: number; duplicatesRemoved: number };
    expect(body.filesProcessed).toBe(0);
    expect(body.duplicatesRemoved).toBe(0);
  });
});
