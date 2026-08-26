import type { Env, GapCell, TrackedGapCell, NormalizedRow } from './types';
import { fetchMetricsTimeSliced } from './graphql';
import {
  findMissingGapCells, insertGapCells, getPendingGaps,
  deleteResolvedGaps, incrementOrConfirmGaps, storeTunnelMetrics,
  rollupHour, rollupDay,
} from './d1';
import { writeRawToR2 } from './r2';
import { snapToHour, snapToDay } from './utils';

const MAX_RANGES_PER_RUN = 20;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const MAX_PENDING_FETCH = 5000;

export interface ContiguousRange {
  start: string;
  end: string;
  cells: TrackedGapCell[];
}

export function groupIntoContiguousRanges(cells: TrackedGapCell[]): ContiguousRange[] {
  const byTs = new Map<string, TrackedGapCell[]>();
  for (const cell of cells) {
    if (!byTs.has(cell.ts)) byTs.set(cell.ts, []);
    byTs.get(cell.ts)!.push(cell);
  }

  const sortedTs = Array.from(byTs.keys()).sort();
  const ranges: ContiguousRange[] = [];
  let currentTsList: string[] = [];

  for (const ts of sortedTs) {
    const last = currentTsList[currentTsList.length - 1];
    if (last !== undefined && new Date(ts).getTime() - new Date(last).getTime() === FIVE_MINUTES_MS) {
      currentTsList.push(ts);
    } else {
      if (currentTsList.length > 0) ranges.push(finalizeRange(currentTsList, byTs));
      currentTsList = [ts];
    }
  }
  if (currentTsList.length > 0) ranges.push(finalizeRange(currentTsList, byTs));

  ranges.sort((a, b) => {
    const aMin = Math.min(...a.cells.map((c) => new Date(c.firstDetected).getTime()));
    const bMin = Math.min(...b.cells.map((c) => new Date(c.firstDetected).getTime()));
    return aMin - bMin;
  });

  return ranges;
}

function finalizeRange(tsList: string[], byTs: Map<string, TrackedGapCell[]>): ContiguousRange {
  const cells = tsList.flatMap((ts) => byTs.get(ts)!);
  const start = tsList[0];
  const endMs = new Date(tsList[tsList.length - 1]).getTime() + FIVE_MINUTES_MS;
  // Raw ts format has no milliseconds ('...Z', not '...000Z'); inputs are
  // always 5-min-aligned so the millisecond component is always exactly
  // zero here — safe to strip rather than reformat by hand.
  const end = new Date(endMs).toISOString().replace('.000Z', 'Z');
  return { start, end, cells };
}

export async function runGapCheck(env: Env, windowStart: Date, windowEnd: Date): Promise<void> {
  const now = new Date();
  await retryPendingGaps(env, now);
  await discoverNewGaps(env, windowStart, windowEnd, now);
}

async function retryPendingGaps(env: Env, now: Date): Promise<void> {
  const pending = await getPendingGaps(env.DB, MAX_PENDING_FETCH);
  if (pending.length === 0) return;

  const ranges = groupIntoContiguousRanges(pending);
  const toProcess = ranges.slice(0, MAX_RANGES_PER_RUN);
  if (ranges.length > toProcess.length) {
    console.warn(`Gap repoll: deferring ${ranges.length - toProcess.length} window(s) to next run (budget cap)`);
  }

  const resolvedHours = new Set<string>();
  const resolvedDays = new Set<string>();

  for (const range of toProcess) {
    let ingress: NormalizedRow[];
    let egress: NormalizedRow[];
    try {
      ({ ingress, egress } = await fetchMetricsTimeSliced(
        env.ACCOUNT_ID, env.WAN_API_TOKEN, new Date(range.start), new Date(range.end),
      ));
    } catch (err) {
      console.warn(`Gap repoll fetch failed for ${range.start}-${range.end}: ${(err as Error).message}`);
      continue;
    }

    await Promise.all([
      storeTunnelMetrics(env.DB, ingress, 'ingress'),
      storeTunnelMetrics(env.DB, egress, 'egress'),
    ]);
    await writeRawToR2(env.RAW_METRICS, ingress, egress);

    const present = new Map<string, Set<string>>();
    for (const row of ingress) {
      if (!present.has(row.ts)) present.set(row.ts, new Set());
      present.get(row.ts)!.add(`${row.tunnelName}|ingress`);
    }
    for (const row of egress) {
      if (!present.has(row.ts)) present.set(row.ts, new Set());
      present.get(row.ts)!.add(`${row.tunnelName}|egress`);
    }

    const resolved: GapCell[] = [];
    const stillMissing: GapCell[] = [];
    for (const cell of range.cells) {
      const key = `${cell.tunnelName}|${cell.direction}`;
      if (present.get(cell.ts)?.has(key)) {
        resolved.push(cell);
        resolvedHours.add(snapToHour(new Date(cell.ts)).toISOString());
        resolvedDays.add(snapToDay(new Date(cell.ts)).toISOString());
      } else {
        stillMissing.push(cell);
      }
    }

    if (resolved.length > 0) await deleteResolvedGaps(env.DB, resolved);
    if (stillMissing.length > 0) await incrementOrConfirmGaps(env.DB, stillMissing, now.toISOString());

    console.log(`Gap repoll ${range.start}-${range.end}: resolved ${resolved.length}, still missing ${stillMissing.length}`);
  }

  for (const hour of resolvedHours) {
    const changes = await rollupHour(env.DB, hour);
    console.log(`Gap repoll rollupHour ${hour}: ${changes} rows`);
  }
  for (const day of resolvedDays) {
    const changes = await rollupDay(env.DB, day);
    console.log(`Gap repoll rollupDay ${day}: ${changes} rows`);
  }
}

async function discoverNewGaps(env: Env, windowStart: Date, windowEnd: Date, now: Date): Promise<void> {
  const rosterSince = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
  const missing = await findMissingGapCells(
    env.DB, windowStart.toISOString(), windowEnd.toISOString(), rosterSince.toISOString(),
  );
  if (missing.length === 0) return;
  await insertGapCells(env.DB, missing, now.toISOString());
  console.log(`Gap detection: found ${missing.length} new missing cell(s) in window ${windowStart.toISOString()}-${windowEnd.toISOString()}`);
}
