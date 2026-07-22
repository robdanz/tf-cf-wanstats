import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { writeRawToR2 } from '../src/r2';
import type { NormalizedRow } from '../src/types';

const BUCKET = (env as { RAW_METRICS: R2Bucket }).RAW_METRICS;

async function readCsv(key: string): Promise<string[]> {
  const obj = await BUCKET.get(key);
  if (!obj) throw new Error(`missing object ${key}`);
  const text = await obj.text();
  return text.split('\n').filter((l) => l && l !== 'tunnel_name,direction,ts,bit_rate');
}

function row(tunnelName: string, ts: string, bitRate: number): NormalizedRow {
  return { tunnelName, ts, bitRate };
}

describe('writeRawToR2 replace-by-key merge', () => {
  it('replaces an existing row for the same tunnel/direction/ts instead of keeping both', async () => {
    // First fetch sees a partial 10:00 bucket, next full run sees the real one.
    await writeRawToR2(BUCKET, [], [row('TUN_A', '2026-01-01T10:00:00Z', 559973)]);
    await writeRawToR2(BUCKET, [], [row('TUN_A', '2026-01-01T10:00:00Z', 17155226)]);

    const lines = await readCsv('raw/2026-01-01/10.csv');
    expect(lines).toEqual(['TUN_A,egress,2026-01-01T10:00:00Z,17155226']);
  });

  it('collapses pre-existing duplicate keys in a file even when the incoming batch does not cover them', async () => {
    // Simulate a historical dirty file: same key twice with different values.
    await BUCKET.put(
      'raw/2026-01-02/09.csv',
      'tunnel_name,direction,ts,bit_rate\n' +
        'TUN_B,egress,2026-01-02T09:55:00Z,23002560\n' +
        'TUN_B,egress,2026-01-02T09:55:00Z,24036213\n',
    );

    // Incoming write touches the same hour file but a different key.
    await writeRawToR2(BUCKET, [row('TUN_B', '2026-01-02T09:50:00Z', 31190960)], []);

    const lines = await readCsv('raw/2026-01-02/09.csv');
    expect(lines).toEqual([
      'TUN_B,egress,2026-01-02T09:55:00Z,24036213',
      'TUN_B,ingress,2026-01-02T09:50:00Z,31190960',
    ]);
  });

  it('keeps ingress and egress rows for the same tunnel/ts as distinct keys', async () => {
    await writeRawToR2(
      BUCKET,
      [row('TUN_C', '2026-01-03T11:05:00Z', 100)],
      [row('TUN_C', '2026-01-03T11:05:00Z', 200)],
    );

    const lines = await readCsv('raw/2026-01-03/11.csv');
    expect(lines).toEqual([
      'TUN_C,egress,2026-01-03T11:05:00Z,200',
      'TUN_C,ingress,2026-01-03T11:05:00Z,100',
    ]);
  });
});
