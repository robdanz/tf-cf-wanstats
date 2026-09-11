export async function verifyToken(provided: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(provided)));
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(expected)));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function rangeToSince(range: string, customStart?: string, _customEnd?: string): string {
  const dayRanges: Record<string, number> = {
    '7d': 7, '30d': 30, '90d': 90, '180d': 180,
  };

  if (dayRanges[range]) {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - dayRanges[range]);
    return d.toISOString();
  }

  if (range === 'custom' && customStart) {
    return customStart;
  }

  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

export function rangeToTable(range: string, customDays?: number): 'raw' | 'hourly' | 'daily' {
  if (range === '24h') return 'raw';
  if (range === '7d' || range === '30d') return 'hourly';
  if (range === '90d' || range === '180d') return 'daily';
  if (range === 'custom' && customDays !== undefined) {
    if (customDays <= 1) return 'raw';
    if (customDays <= 30) return 'hourly';
    return 'daily';
  }
  return 'raw';
}

// Retention-aware table choice for a custom range: the finest table whose
// retention still covers the range's start, capped by span so a 60-day
// hourly query stays bounded. A calendar month (31 days) is hourly, not
// daily — daily averages flatten p95 badly. Retention: raw 7d, hourly 60d.
const RAW_RETENTION_DAYS = 7;
const HOURLY_RETENTION_DAYS = 60;

export function customRangeTable(start: string, end: string, now: Date = new Date()): 'raw' | 'hourly' | 'daily' {
  const startMs = new Date(start).getTime();
  const spanDays = Math.ceil((new Date(end).getTime() - startMs) / 86400000);
  const ageDays = (now.getTime() - startMs) / 86400000;
  if (spanDays <= 1 && ageDays <= RAW_RETENTION_DAYS) return 'raw';
  if (spanDays <= HOURLY_RETENTION_DAYS && ageDays <= HOURLY_RETENTION_DAYS) return 'hourly';
  return 'daily';
}

export function rangeToUntil(range: string, _customStart?: string, customEnd?: string): string {
  if (range === 'custom' && customEnd) return customEnd;
  return new Date().toISOString();
}

export function tableToStepSeconds(table: 'raw' | 'hourly' | 'daily'): number {
  if (table === 'raw') return 300;
  if (table === 'hourly') return 3600;
  return 86400;
}

export function snapToStep(iso: string, stepSeconds: number): string {
  const ms = new Date(iso).getTime();
  const stepMs = stepSeconds * 1000;
  const snapped = Math.floor(ms / stepMs) * stepMs;
  return new Date(snapped).toISOString();
}

export function snapToFiveMin(d: Date): Date {
  const snapped = new Date(d);
  snapped.setUTCMinutes(Math.floor(snapped.getUTCMinutes() / 5) * 5, 0, 0);
  return snapped;
}

export function snapToHour(d: Date): Date {
  const snapped = new Date(d);
  snapped.setUTCMinutes(0, 0, 0);
  return snapped;
}

export function snapToDay(d: Date): Date {
  const snapped = new Date(d);
  snapped.setUTCHours(0, 0, 0, 0);
  return snapped;
}

export function toPeriod(d: Date): string {
  return d.toISOString().slice(0, 7);
}
