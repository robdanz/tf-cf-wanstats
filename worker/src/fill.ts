import type { NormalizedRow } from './types';

// Placeholder for a tunnel/direction the source settled on reporting nothing
// for. Near the low end of what the dataset reports (1066 bps is the most
// common value in the customer's 2026-10-13 export; a few rows go down to
// 746), so a fill reads as "idle", not as a hole — and 1025 appears nowhere
// in that export, so a consumer can tell a fill from a real reading.
export const FILL_BIT_RATE = 1025;

// Rows to add to a re-fetch so a consumer sees a value for every bucket of
// every tunnel/direction that was live in that hour. Used only by the
// re-fetch paths (repoll.ts at +14h/+38h/+62h, /api/backfill), never by the
// live collector: by then Cloudflare has had its look at the hour.
//
// A fill is made for (tunnel, direction, ts) when
//   - the source answered bucket ts (≥1 row in either direction) — an empty
//     answer can be transient and is a bucket-level gap (gaps.ts), not ours;
//   - the tunnel has ≥1 real row in that direction in the same UTC hour;
//   - and no real row for it at ts.
// So every gap shorter than an hour is filled completely (both ends of it lie
// in hours where the tunnel has data), while a tunnel that is down for hours
// stays empty in the hours it has no data at all.
//
// Fills go through the same replace-by-bucket write as real rows: a later
// pass that gets a real value replaces the fill (new written_at), and an
// unchanged fill keeps its written_at.
export function absentRowFills(
  ingress: NormalizedRow[],
  egress: NormalizedRow[],
): { ingress: NormalizedRow[]; egress: NormalizedRow[] } {
  const answeredByHour = new Map<string, Set<string>>();
  for (const r of [...ingress, ...egress]) {
    const hour = r.ts.slice(0, 13);
    if (!answeredByHour.has(hour)) answeredByHour.set(hour, new Set());
    answeredByHour.get(hour)!.add(r.ts);
  }

  function fillsFor(rows: NormalizedRow[]): NormalizedRow[] {
    const have = new Set<string>();
    const tunnelsByHour = new Map<string, Set<string>>();
    for (const r of rows) {
      have.add(`${r.tunnelName}|${r.ts}`);
      const hour = r.ts.slice(0, 13);
      if (!tunnelsByHour.has(hour)) tunnelsByHour.set(hour, new Set());
      tunnelsByHour.get(hour)!.add(r.tunnelName);
    }
    const fills: NormalizedRow[] = [];
    for (const [hour, tunnels] of tunnelsByHour) {
      for (const ts of answeredByHour.get(hour)!) {
        for (const tunnelName of tunnels) {
          if (!have.has(`${tunnelName}|${ts}`)) fills.push({ tunnelName, ts, bitRate: FILL_BIT_RATE });
        }
      }
    }
    return fills;
  }

  return { ingress: fillsFor(ingress), egress: fillsFor(egress) };
}

// The fetched rows plus their fills, and how many fills were added.
export function withAbsentRowFills(
  ingress: NormalizedRow[],
  egress: NormalizedRow[],
): { ingress: NormalizedRow[]; egress: NormalizedRow[]; filled: number } {
  const fills = absentRowFills(ingress, egress);
  return {
    ingress: ingress.concat(fills.ingress),
    egress: egress.concat(fills.egress),
    filled: fills.ingress.length + fills.egress.length,
  };
}
