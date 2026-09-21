import { describe, it, expect } from 'vitest';
import { withD1Retry, isTransientD1Error } from '../src/d1';

describe('withD1Retry', () => {
  it('retries a transient D1 storage error and returns the eventual result', async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await withD1Retry(async () => {
      calls++;
      if (calls < 3) throw new Error('D1_ERROR: Internal error in D1 DB storage caused object to be reset; reference = abc');
      return 'ok';
    }, 'test', async (ms) => { waits.push(ms); });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(waits).toEqual([500, 1500]);
  });

  it('gives up after the schedule is exhausted', async () => {
    let calls = 0;
    await expect(withD1Retry(async () => {
      calls++;
      throw new Error('D1_ERROR: Internal error in D1 DB storage caused object to be reset');
    }, 'test', async () => {})).rejects.toThrow(/object to be reset/);
    expect(calls).toBe(4);
  });

  it('does not retry a non-transient error', async () => {
    let calls = 0;
    await expect(withD1Retry(async () => {
      calls++;
      throw new Error('D1_ERROR: no such table: tunnel_metrics_hourly');
    }, 'test', async () => {})).rejects.toThrow(/no such table/);
    expect(calls).toBe(1);
  });

  it('classifies messages', () => {
    expect(isTransientD1Error(new Error('D1_ERROR: Internal error in D1 DB storage caused object to be reset; reference = x'))).toBe(true);
    expect(isTransientD1Error(new Error('D1_ERROR: UNIQUE constraint failed: tunnel_metrics.tunnel_name'))).toBe(false);
    expect(isTransientD1Error(new Error('D1_ERROR: near "SELEC": syntax error'))).toBe(false);
    expect(isTransientD1Error(new Error('D1_ERROR: NOT NULL constraint failed'))).toBe(false);
  });
});
