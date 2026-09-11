import { describe, it, expect } from 'vitest';
import { rangeToTable, customRangeTable } from '../src/utils';

const NOW = new Date('2026-09-11T15:00:00Z');

describe('customRangeTable', () => {
  it('uses hourly for any span up to 60 days that starts within hourly retention (a calendar month qualifies)', () => {
    expect(customRangeTable('2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', NOW)).toBe('hourly');
    expect(customRangeTable('2026-07-15T00:00:00Z', '2026-09-11T00:00:00Z', NOW)).toBe('hourly');
  });

  it('uses raw for a span of a day or less that starts within raw retention', () => {
    expect(customRangeTable('2026-09-10T00:00:00Z', '2026-09-11T00:00:00Z', NOW)).toBe('raw');
  });

  it('falls back to a coarser table when the start predates that table\'s retention, regardless of span', () => {
    // 1-day span but 10 days old: raw is purged at 7 days -> hourly.
    expect(customRangeTable('2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', NOW)).toBe('hourly');
    // 5-day span 90 days old: hourly is purged at 60 days -> daily.
    expect(customRangeTable('2026-06-10T00:00:00Z', '2026-06-15T00:00:00Z', NOW)).toBe('daily');
  });

  it('uses daily for spans over 60 days', () => {
    expect(customRangeTable('2026-06-01T00:00:00Z', '2026-09-01T00:00:00Z', NOW)).toBe('daily');
  });
});

describe('rangeToTable presets', () => {
  it('is unchanged for the preset ranges', () => {
    expect(rangeToTable('24h')).toBe('raw');
    expect(rangeToTable('7d')).toBe('hourly');
    expect(rangeToTable('30d')).toBe('hourly');
    expect(rangeToTable('90d')).toBe('daily');
    expect(rangeToTable('180d')).toBe('daily');
  });
});
