import type { Env, NormalizedRow } from './types';
import { generateTimeSlices } from './graphql';
import { recordSeen, getRoster, getRawRowsForHour, storeTunnelMetrics, pruneRawRows, keepKeys } from './d1';
import { writeRawToR2, readRawHour, bucketsWithRows } from './r2';
import { snapToHour } from './utils';

// Placeholder for a tunnel/direction/bucket the source has no value for.
// Near the low end of what the dataset reports (1066 bps is the most common
// value in the customer's 2026-10-13 export; a few rows go down to 746), so
// a fill reads as "idle" — and 1025 appears nowhere in that export, so a
// consumer can tell a fill from a real reading.
export const FILL_BIT_RATE = 1025;

// Requirement (customer, 2026-10-13): R2 has a value for every 5-min bucket
// of every tunnel, in both directions. "Every tunnel" for hour H is the
// roster: tunnels with a real row in either direction in the ROSTER_DAYS
// days up to H (tunnel_seen_days, migration 0006). A new tunnel starts at its
// first real row; a removed one stops being filled ROSTER_DAYS after its last.
//
// Where fills are made:
//   - the hour ledger at H+2h (reconcile.ts) fills every roster key D1 has no
//     row for, so R2 is complete from H+2h;
//   - every re-fetch (re-poll at +14h/+38h/+62h, /api/backfill) via
//     storeRefetch: in a bucket the source answered, the bucket becomes the
//     fetched rows plus a fill for every other roster key (a value we hold
//     that the source no longer returns is replaced by the fill); in a bucket
//     the source answered empty or failed, existing values are kept and only
//     missing roster keys are filled.
// A later real value always replaces a fill. Re-writing an unchanged fill
// is skipped (D1) or a no-op (R2), so /api/current?since= sees fills once.
export const ROSTER_DAYS = 7;

const HOUR_MS = 60 * 60 * 1000;
const rawTs = (d: Date): string => d.toISOString().replace('.000Z', 'Z');
const isFill = (r: NormalizedRow) => r.bitRate === FILL_BIT_RATE;

// Raw ts of the complete 5-min buckets in [start, end).
export function bucketsIn(start: Date, end: Date): string[] {
  return generateTimeSlices(start, end).map((s) => s.start.replace('.000Z', 'Z'));
}

// A FILL_BIT_RATE row for every roster tunnel, direction and bucket whose
// key (tunnel|direction|ts, as keepKeys) is not in `present`.
export function rosterFills(
  roster: Iterable<string>,
  buckets: string[],
  present: Set<string>,
): { ingress: NormalizedRow[]; egress: NormalizedRow[] } {
  const out = { ingress: [] as NormalizedRow[], egress: [] as NormalizedRow[] };
  for (const tunnelName of roster) {
    for (const ts of buckets) {
      for (const dir of ['ingress', 'egress'] as const) {
        if (!present.has(`${tunnelName}|${dir}|${ts}`)) out[dir].push({ tunnelName, ts, bitRate: FILL_BIT_RATE });
      }
    }
  }
  return out;
}

export async function recordSeenRows(db: D1Database, ingress: NormalizedRow[], egress: NormalizedRow[]): Promise<void> {
  await recordSeen(db, ingress.filter((r) => !isFill(r)).concat(egress.filter((r) => !isFill(r))));
}

// Ledger step: fill the hour's missing roster keys from what D1 holds. D1 is
// complete for the hour afterwards; returns the fills (already stored) so the
// caller can include them in the R2 rebuild.
export async function fillHourFromD1(
  db: D1Database,
  hour: Date,
  ingress: NormalizedRow[],
  egress: NormalizedRow[],
): Promise<{ ingress: NormalizedRow[]; egress: NormalizedRow[] }> {
  await recordSeenRows(db, ingress, egress);
  const roster = await getRoster(db, hour, ROSTER_DAYS);
  const fills = rosterFills(roster, bucketsIn(hour, new Date(hour.getTime() + HOUR_MS)), keepKeys(ingress, egress));
  await Promise.all([
    storeTunnelMetrics(db, fills.ingress, 'ingress'),
    storeTunnelMetrics(db, fills.egress, 'egress'),
  ]);
  return fills;
}

// Store a re-fetch of [start, end) with fills. `archive` (older than raw
// retention) writes R2 only and reads the existing values from R2 instead of
// D1. Returns the window's resulting rows (fetched + fills + kept existing
// rows in unanswered buckets) for rollups computed from rows.
export async function storeRefetch(
  env: Env,
  start: Date,
  end: Date,
  fetched: { ingress: NormalizedRow[]; egress: NormalizedRow[] },
  archive: boolean,
): Promise<{ filled: number; answered: Set<string>; rows: { ingress: NormalizedRow[]; egress: NormalizedRow[] } }> {
  const answered = bucketsWithRows(fetched.ingress, fetched.egress);
  await recordSeenRows(env.DB, fetched.ingress, fetched.egress);

  const fills = { ingress: [] as NormalizedRow[], egress: [] as NormalizedRow[] };
  const newFills = { ingress: [] as NormalizedRow[], egress: [] as NormalizedRow[] };
  const kept = { ingress: [] as NormalizedRow[], egress: [] as NormalizedRow[] };
  const fetchedKeys = keepKeys(fetched.ingress, fetched.egress);

  for (let h = snapToHour(start).getTime(); h < end.getTime(); h += HOUR_MS) {
    const hour = new Date(h);
    const buckets = bucketsIn(new Date(Math.max(h, start.getTime())), new Date(Math.min(h + HOUR_MS, end.getTime())));
    if (buckets.length === 0) continue;
    const inWindow = new Set(buckets);
    const existing = archive
      ? await readRawHour(env.RAW_METRICS, hour)
      : await getRawRowsForHour(env.DB, rawTs(hour), rawTs(new Date(h + HOUR_MS)));

    const present = new Set(fetchedKeys);
    const existingFills = new Set<string>();
    for (const dir of ['ingress', 'egress'] as const) {
      for (const r of existing[dir]) {
        if (!inWindow.has(r.ts)) continue;
        const k = `${r.tunnelName}|${dir}|${r.ts}`;
        if (isFill(r)) existingFills.add(k);
        // Unanswered bucket: what we hold stays and counts as present.
        if (!answered.has(r.ts)) { present.add(k); kept[dir].push(r); }
      }
    }

    const f = rosterFills(await getRoster(env.DB, hour, ROSTER_DAYS), buckets, present);
    for (const dir of ['ingress', 'egress'] as const) {
      fills[dir].push(...f[dir]);
      newFills[dir].push(...f[dir].filter((r) => !existingFills.has(`${r.tunnelName}|${dir}|${r.ts}`)));
    }
  }

  const ingress = fetched.ingress.concat(fills.ingress);
  const egress = fetched.egress.concat(fills.egress);
  await Promise.all([
    archive ? Promise.resolve() : Promise.all([
      storeTunnelMetrics(env.DB, fetched.ingress.concat(newFills.ingress), 'ingress'),
      storeTunnelMetrics(env.DB, fetched.egress.concat(newFills.egress), 'egress'),
    ]).then(() => pruneRawRows(env.DB, answered, keepKeys(ingress, egress))),
    // Answered buckets are replaced by fetched + fills; in the others the
    // fills are keys nothing holds, so the merge only adds them. Raw mode
    // also writes the held D1 rows of those buckets, so R2 == D1 even if an
    // earlier R2 write was lost.
    archive
      ? writeRawToR2(env.RAW_METRICS, ingress, egress, answered)
      : writeRawToR2(env.RAW_METRICS, ingress.concat(kept.ingress), egress.concat(kept.egress), answered),
  ]);

  return {
    filled: fills.ingress.length + fills.egress.length,
    answered,
    rows: { ingress: ingress.concat(kept.ingress), egress: egress.concat(kept.egress) },
  };
}
