import { describe, it, expect } from 'vitest';
import { generateTimeSlices } from '../src/graphql';

describe('generateTimeSlices', () => {
  it('drops the trailing partial slice so in-progress buckets are never queried', () => {
    // Full cron run firing at 10:00:42 with a 65-min lookback: the 10:00
    // bucket is only 42 seconds old and must not be fetched.
    const start = new Date('2026-07-15T08:55:42Z');
    const end = new Date('2026-07-15T10:00:42Z');

    const slices = generateTimeSlices(start, end);

    expect(slices[0]).toEqual({
      start: '2026-07-15T08:55:00.000Z',
      end: '2026-07-15T09:00:00.000Z',
    });
    expect(slices[slices.length - 1]).toEqual({
      start: '2026-07-15T09:55:00.000Z',
      end: '2026-07-15T10:00:00.000Z',
    });
    expect(slices).toHaveLength(13);
  });

  it('keeps all slices when the end is exactly on a 5-minute boundary', () => {
    const slices = generateTimeSlices(
      new Date('2026-07-15T09:00:00Z'),
      new Date('2026-07-15T10:00:00Z'),
    );

    expect(slices).toHaveLength(12);
    expect(slices[11]).toEqual({
      start: '2026-07-15T09:55:00.000Z',
      end: '2026-07-15T10:00:00.000Z',
    });
  });

  it('returns no slices when the window is smaller than one complete bucket', () => {
    const slices = generateTimeSlices(
      new Date('2026-07-15T10:00:00Z'),
      new Date('2026-07-15T10:03:00Z'),
    );

    expect(slices).toHaveLength(0);
  });
});
