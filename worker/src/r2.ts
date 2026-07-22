import type { NormalizedRow } from './types';

const CSV_HEADER = 'tunnel_name,direction,ts,bit_rate';

// Collapse CSV lines to one per tunnel,direction,ts key, keeping the max
// bit rate. Legacy files hold duplicate keys (partial-bucket and settling
// re-fetch writes); the partial value is always lower than the settled one.
function collapseMaxPerKey(text: string): { lines: Map<string, string>; removed: number } {
  const lines = new Map<string, string>();
  let removed = 0;
  for (const line of text.split('\n')) {
    if (!line || line === CSV_HEADER) continue;
    const lastComma = line.lastIndexOf(',');
    const lineKey = line.slice(0, lastComma);
    const prev = lines.get(lineKey);
    if (prev !== undefined) {
      removed++;
      const prevRate = parseFloat(prev.slice(prev.lastIndexOf(',') + 1));
      const rate = parseFloat(line.slice(lastComma + 1));
      if (rate <= prevRate) continue;
    }
    lines.set(lineKey, line);
  }
  return { lines, removed };
}

export function buildCsvLines(rows: NormalizedRow[], direction: 'ingress' | 'egress'): string[] {
  return rows.map((r) => `${r.tunnelName},${direction},${r.ts},${r.bitRate}`);
}

export async function writeRawToR2(
  bucket: R2Bucket,
  ingress: NormalizedRow[],
  egress: NormalizedRow[],
): Promise<{ filesWritten: number; totalRows: number }> {
  // Per hour file: rows keyed by tunnel,direction,ts. A bucket re-fetched
  // with a different (settled) value must replace the old line, not coexist
  // with it — the R2 equivalent of D1's INSERT OR REPLACE.
  const hourBuckets = new Map<string, Map<string, string>>();

  function addRows(rows: NormalizedRow[], direction: 'ingress' | 'egress') {
    for (const row of rows) {
      const dateStr = row.ts.slice(0, 10);
      const hourStr = row.ts.slice(11, 13);
      const key = `${dateStr}/${hourStr}`;
      if (!hourBuckets.has(key)) hourBuckets.set(key, new Map());
      hourBuckets.get(key)!.set(
        `${row.tunnelName},${direction},${row.ts}`,
        `${row.tunnelName},${direction},${row.ts},${row.bitRate}`,
      );
    }
  }

  addRows(ingress, 'ingress');
  addRows(egress, 'egress');

  let totalRows = 0;
  const writes: Promise<void>[] = [];

  for (const [key, incoming] of hourBuckets) {
    const existingObj = await bucket.get(`raw/${key}.csv`);
    const merged = existingObj
      ? collapseMaxPerKey(await existingObj.text()).lines
      : new Map<string, string>();

    for (const [lineKey, line] of incoming) merged.set(lineKey, line);

    const allLines = Array.from(merged.values()).sort();
    totalRows += allLines.length;
    const csv = CSV_HEADER + '\n' + allLines.join('\n') + '\n';

    writes.push(bucket.put(`raw/${key}.csv`, csv).then(() => {}));
  }

  await Promise.all(writes);

  return { filesWritten: hourBuckets.size, totalRows };
}

export async function listRawKeys(
  bucket: R2Bucket,
  startDate: Date,
  endDate: Date,
): Promise<string[]> {
  const keys: string[] = [];
  const current = new Date(startDate);
  current.setUTCHours(0, 0, 0, 0);

  const endDay = new Date(endDate);
  endDay.setUTCHours(0, 0, 0, 0);
  endDay.setUTCDate(endDay.getUTCDate() + 1);

  while (current < endDay) {
    const dateStr = current.toISOString().slice(0, 10);
    const listed = await bucket.list({ prefix: `raw/${dateStr}/` });
    for (const obj of listed.objects) {
      keys.push(obj.key);
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return keys.sort();
}

function parseCsvLine(line: string): {
  tunnelName: string;
  direction: string;
  ts: string;
  bitRate: number;
} | null {
  if (!line || line === CSV_HEADER) return null;
  const parts = line.split(',');
  if (parts.length < 4) return null;
  return {
    tunnelName: parts[0],
    direction: parts[1],
    ts: parts[2],
    bitRate: parseFloat(parts[3]),
  };
}

export function computeP95FromValues(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[idx];
}

export async function computeAggregateBillingP95(
  bucket: R2Bucket,
  startDate: Date,
  endDate: Date,
  excludeSet: Set<string>,
): Promise<{
  ingress: number | null;
  egress: number | null;
  sampleCount: number;
}> {
  const keys = await listRawKeys(bucket, startDate, endDate);

  const ingressSums = new Map<string, number>();
  const egressSums = new Map<string, number>();

  for (const key of keys) {
    const obj = await bucket.get(key);
    if (!obj) continue;
    const text = await obj.text();

    for (const line of text.split('\n')) {
      const parsed = parseCsvLine(line);
      if (!parsed) continue;
      if (excludeSet.has(parsed.tunnelName)) continue;
      if (parsed.ts < startDate.toISOString() || parsed.ts >= endDate.toISOString()) continue;

      const sums = parsed.direction === 'ingress' ? ingressSums : egressSums;
      sums.set(parsed.ts, (sums.get(parsed.ts) ?? 0) + parsed.bitRate);
    }
  }

  const ingressP95 = computeP95FromValues(Array.from(ingressSums.values()));
  const egressP95 = computeP95FromValues(Array.from(egressSums.values()));

  return {
    ingress: ingressP95,
    egress: egressP95,
    sampleCount: Math.max(ingressSums.size, egressSums.size),
  };
}

export async function computePerTunnelBillingP95(
  bucket: R2Bucket,
  startDate: Date,
  endDate: Date,
  tunnelNames: string[],
): Promise<Map<string, { ingress: number | null; egress: number | null; sampleCount: number }>> {
  const keys = await listRawKeys(bucket, startDate, endDate);
  const tunnelSet = new Set(tunnelNames);

  const tunnelData = new Map<string, { ingress: number[]; egress: number[] }>();
  for (const name of tunnelNames) {
    tunnelData.set(name, { ingress: [], egress: [] });
  }

  for (const key of keys) {
    const obj = await bucket.get(key);
    if (!obj) continue;
    const text = await obj.text();

    for (const line of text.split('\n')) {
      const parsed = parseCsvLine(line);
      if (!parsed) continue;
      if (!tunnelSet.has(parsed.tunnelName)) continue;
      if (parsed.ts < startDate.toISOString() || parsed.ts >= endDate.toISOString()) continue;

      const data = tunnelData.get(parsed.tunnelName)!;
      if (parsed.direction === 'ingress') data.ingress.push(parsed.bitRate);
      else data.egress.push(parsed.bitRate);
    }
  }

  const result = new Map<string, { ingress: number | null; egress: number | null; sampleCount: number }>();
  for (const [name, data] of tunnelData) {
    result.set(name, {
      ingress: computeP95FromValues(data.ingress),
      egress: computeP95FromValues(data.egress),
      sampleCount: Math.max(data.ingress.length, data.egress.length),
    });
  }

  return result;
}

export async function streamCsvExport(
  bucket: R2Bucket,
  startDate: Date,
  endDate: Date,
  tunnelFilter: string | null,
): Promise<ReadableStream> {
  const keys = await listRawKeys(bucket, startDate, endDate);
  const encoder = new TextEncoder();

  let keyIndex = 0;
  let headerSent = false;

  return new ReadableStream({
    async pull(controller) {
      while (keyIndex < keys.length) {
        const obj = await bucket.get(keys[keyIndex]);
        keyIndex++;
        if (!obj) continue;

        const text = await obj.text();
        const lines = text.split('\n');
        let output = '';

        for (const line of lines) {
          if (!line) continue;
          if (line === CSV_HEADER) {
            if (!headerSent) {
              output += CSV_HEADER + '\n';
              headerSent = true;
            }
            continue;
          }

          if (tunnelFilter) {
            const commaIdx = line.indexOf(',');
            if (commaIdx === -1) continue;
            const name = line.slice(0, commaIdx);
            if (name !== tunnelFilter) continue;
          }

          const parsed = parseCsvLine(line);
          if (!parsed) continue;
          if (parsed.ts < startDate.toISOString() || parsed.ts >= endDate.toISOString()) continue;

          output += line + '\n';
        }

        if (output) {
          controller.enqueue(encoder.encode(output));
        }
      }

      controller.close();
    },
  });
}

export async function cleanupRawDay(
  bucket: R2Bucket,
  dateStr: string,
): Promise<{ filesProcessed: number; duplicatesRemoved: number }> {
  const listed = await bucket.list({ prefix: `raw/${dateStr}/` });

  let filesProcessed = 0;
  let duplicatesRemoved = 0;

  for (const obj of listed.objects) {
    const body = await bucket.get(obj.key);
    if (!body) continue;
    filesProcessed++;

    const { lines, removed } = collapseMaxPerKey(await body.text());
    if (removed === 0) continue;
    duplicatesRemoved += removed;

    const csv = CSV_HEADER + '\n' + Array.from(lines.values()).sort().join('\n') + '\n';
    await bucket.put(obj.key, csv);
  }

  return { filesProcessed, duplicatesRemoved };
}

export async function purgeOldR2Data(bucket: R2Bucket): Promise<number> {
  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  let deleted = 0;
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ prefix: 'raw/', cursor, limit: 1000 });
    const keysToDelete: string[] = [];

    for (const obj of listed.objects) {
      const dateStr = obj.key.slice(4, 14);
      if (dateStr < cutoffDate) {
        keysToDelete.push(obj.key);
      }
    }

    if (keysToDelete.length > 0) {
      await bucket.delete(keysToDelete);
      deleted += keysToDelete.length;
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return deleted;
}
