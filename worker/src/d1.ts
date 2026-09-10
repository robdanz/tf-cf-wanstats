import type { NormalizedRow, TunnelStat, GapCell, TrackedGapCell, GapBucket, TrackedGapBucket, CronStep } from './types';

const BATCH_SIZE = 100;

// Conditional upsert: written_at moves only when the row is new or its value
// changed. Light runs re-fetch the same buckets every 5 minutes; with plain
// INSERT OR REPLACE every one of those would look "changed" to
// /api/current?since= polling.
//
// written_at is stamped per D1 batch, not once for the whole call: a full run
// writes thousands of rows across many sequential db.batch() calls, and
// stamping them all with one timestamp let /api/current?since= observe a
// half-committed group and skip its uncommitted tail. When the caller omits
// writtenAt, a written_at group is now at most one D1 batch (BATCH_SIZE rows).
// An explicit writtenAt (tests, callers that pass one) still applies to every
// chunk, preserving single-group semantics for callers that want it.
export async function storeTunnelMetrics(
  db: D1Database,
  rows: NormalizedRow[],
  direction: 'ingress' | 'egress',
  writtenAt?: string,
): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const stamp = writtenAt ?? new Date().toISOString();
    await db.batch(
      chunk.map((row) =>
        db.prepare(`
          INSERT INTO tunnel_metrics (tunnel_name, direction, ts, bit_rate, written_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (tunnel_name, direction, ts) DO UPDATE
            SET bit_rate = excluded.bit_rate, written_at = excluded.written_at
            WHERE bit_rate IS NOT excluded.bit_rate
        `).bind(row.tunnelName, direction, row.ts, row.bitRate, stamp),
      ),
    );
  }
}

export async function rollupHour(db: D1Database, hourStart: string): Promise<number> {
  const hourEnd = new Date(new Date(hourStart).getTime() + 60 * 60 * 1000).toISOString();
  const result = await db.prepare(`
    INSERT OR REPLACE INTO tunnel_metrics_hourly
      (tunnel_name, direction, ts, avg_bit_rate, max_bit_rate, min_bit_rate, sample_count)
    SELECT tunnel_name, direction, ?,
           AVG(bit_rate), MAX(bit_rate), MIN(bit_rate), COUNT(*)
    FROM tunnel_metrics
    WHERE ts >= ? AND ts < ?
    GROUP BY tunnel_name, direction
  `).bind(hourStart, hourStart, hourEnd).run();
  return result.meta.changes ?? 0;
}

export async function rollupDay(db: D1Database, dayStart: string): Promise<number> {
  const dayEnd = new Date(new Date(dayStart).getTime() + 24 * 60 * 60 * 1000).toISOString();
  const result = await db.prepare(`
    INSERT OR REPLACE INTO tunnel_metrics_daily
      (tunnel_name, direction, ts, avg_bit_rate, max_bit_rate, min_bit_rate, sample_count)
    SELECT tunnel_name, direction, ?,
           SUM(avg_bit_rate * sample_count) / SUM(sample_count),
           MAX(max_bit_rate),
           MIN(min_bit_rate),
           SUM(sample_count)
    FROM tunnel_metrics_hourly
    WHERE ts >= ? AND ts < ?
    GROUP BY tunnel_name, direction
  `).bind(dayStart, dayStart, dayEnd).run();
  return result.meta.changes ?? 0;
}

// Retention deletes run sequentially and index-bounded. Every predicate
// leads with direction so idx_*_direction_ts applies (a bare `ts < ?` is a
// full scan — ~1M rows at 577 tunnels); each statement covers one chunk of
// one direction so no single statement can hit D1's timeout. The loop walks
// from the oldest row up to the cutoff, so a purge that failed yesterday
// resumes where it left off.
async function purgeTableInChunks(
  db: D1Database,
  table: 'tunnel_metrics' | 'tunnel_metrics_hourly' | 'tunnel_metrics_daily',
  cutoff: Date,
  chunkMs: number,
  fmt: (d: Date) => string,
): Promise<number> {
  let deleted = 0;
  for (const direction of ['ingress', 'egress'] as const) {
    const oldest = await db.prepare(`SELECT MIN(ts) AS ts FROM ${table} WHERE direction = ?`)
      .bind(direction).first<{ ts: string | null }>();
    if (!oldest?.ts) continue;
    let from = new Date(Math.floor(new Date(oldest.ts).getTime() / chunkMs) * chunkMs);
    while (from < cutoff) {
      const to = new Date(Math.min(from.getTime() + chunkMs, cutoff.getTime()));
      const result = await db.prepare(`DELETE FROM ${table} WHERE direction = ? AND ts >= ? AND ts < ?`)
        .bind(direction, fmt(from), fmt(to)).run();
      deleted += result.meta.changes ?? 0;
      from = to;
    }
  }
  return deleted;
}

// tunnel_metrics stores raw ts (no ms); the rollup tables store toISOString().
// An unaligned cutoff keeps its milliseconds — still a valid lexical bound.
const rawTs = (d: Date): string => d.toISOString().replace('.000Z', 'Z');
const isoTs = (d: Date): string => d.toISOString();

export async function purgeOldData(db: D1Database): Promise<{
  rawDeleted: number;
  hourlyDeleted: number;
  dailyDeleted: number;
  gapTrackingDeleted: number;
}> {
  const now = new Date();
  const rawCutoff = new Date(now);
  rawCutoff.setUTCDate(rawCutoff.getUTCDate() - 7);
  const hourlyCutoff = new Date(now);
  hourlyCutoff.setUTCDate(hourlyCutoff.getUTCDate() - 60);
  const dailyCutoff = new Date(now);
  dailyCutoff.setUTCDate(dailyCutoff.getUTCDate() - 180);

  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  const rawDeleted = await purgeTableInChunks(db, 'tunnel_metrics', rawCutoff, HOUR_MS, rawTs);
  const hourlyDeleted = await purgeTableInChunks(db, 'tunnel_metrics_hourly', hourlyCutoff, DAY_MS, isoTs);
  const dailyDeleted = await purgeTableInChunks(db, 'tunnel_metrics_daily', dailyCutoff, DAY_MS, isoTs);
  // A gap bucket whose ts predates raw retention can never be repaired (the
  // raw rows it would resolve against are gone), so status no longer matters.
  // At most 2,016 rows; the PK range is enough.
  const gapResult = await db.prepare('DELETE FROM gap_buckets WHERE ts < ?').bind(rawTs(rawCutoff)).run();

  return {
    rawDeleted,
    hourlyDeleted,
    dailyDeleted,
    gapTrackingDeleted: gapResult.meta.changes ?? 0,
  };
}

// ── Ledger helpers (reconcile.ts) ───────────────────────────────────────────

// Two per-direction queries keep idx_tm_direction_ts (direction, ts) in play.
// Bounds are raw ts format ('YYYY-MM-DDTHH:MM:SSZ').
export async function getRawRowsForHour(
  db: D1Database,
  hourStart: string,
  hourEnd: string,
): Promise<{ ingress: NormalizedRow[]; egress: NormalizedRow[] }> {
  const sql = 'SELECT tunnel_name, ts, bit_rate FROM tunnel_metrics WHERE direction = ? AND ts >= ? AND ts < ?';
  type Row = { tunnel_name: string; ts: string; bit_rate: number };
  const [ing, eg] = await Promise.all([
    db.prepare(sql).bind('ingress', hourStart, hourEnd).all<Row>(),
    db.prepare(sql).bind('egress', hourStart, hourEnd).all<Row>(),
  ]);
  const toRows = (rows: Row[]): NormalizedRow[] =>
    rows.map((r) => ({ tunnelName: r.tunnel_name, ts: r.ts, bitRate: r.bit_rate }));
  return { ingress: toRows(ing.results), egress: toRows(eg.results) };
}

// MIN(ts) over one direction is an index-range read; a bare MIN(ts) would
// scan the table.
export async function getOldestRawTs(db: D1Database): Promise<string | null> {
  const row = await db.prepare("SELECT MIN(ts) AS ts FROM tunnel_metrics WHERE direction = 'ingress'")
    .first<{ ts: string | null }>();
  return row?.ts ?? null;
}

// ── Gap tracking (detect + bounded auto-repoll) ─────────────────────────────
// See docs/superpowers/specs/2026-08-25-gap-detection-repoll-design.md.
// A gap_tracking row exists only while a cell is unresolved: resolved cells
// are deleted (the raw row is the record); confirmed_empty_at rows are
// terminal and excluded from all future discovery.

export async function findMissingGapCells(
  db: D1Database,
  windowStart: string,
  windowEnd: string,
  rosterSince: string,
): Promise<GapCell[]> {
  const { results } = await db.prepare(`
    WITH RECURSIVE slots(ts) AS (
      SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?1)
      UNION ALL
      SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ts, '+300 seconds') FROM slots
      WHERE strftime('%Y-%m-%dT%H:%M:%SZ', ts, '+300 seconds') < ?2
    ),
    -- Two sargable halves UNIONed (same pattern as CURRENT_METRICS_SQL): a bare
    -- ts predicate can't use idx_tm_direction_ts, and filtering to one direction
    -- would drop tunnels whose only recent data is the other direction.
    active_tunnels AS (
      SELECT tunnel_name FROM tunnel_metrics WHERE direction = 'ingress' AND ts >= ?3
      UNION
      SELECT tunnel_name FROM tunnel_metrics WHERE direction = 'egress' AND ts >= ?3
    ),
    expected AS (
      SELECT at.tunnel_name, d.direction, s.ts
      FROM active_tunnels at
      CROSS JOIN (SELECT 'ingress' AS direction UNION ALL SELECT 'egress') d
      CROSS JOIN slots s
    )
    SELECT e.tunnel_name, e.direction, e.ts
    FROM expected e
    LEFT JOIN tunnel_metrics m
      ON m.tunnel_name = e.tunnel_name AND m.direction = e.direction AND m.ts = e.ts
    LEFT JOIN gap_tracking g
      ON g.tunnel_name = e.tunnel_name AND g.direction = e.direction AND g.ts = e.ts
    WHERE m.ts IS NULL AND g.tunnel_name IS NULL
  `).bind(windowStart, windowEnd, rosterSince).all<{ tunnel_name: string; direction: string; ts: string }>();

  return results.map((r) => ({
    tunnelName: r.tunnel_name,
    direction: r.direction as 'ingress' | 'egress',
    ts: r.ts,
  }));
}

export async function insertGapCells(db: D1Database, cells: GapCell[], now: string): Promise<void> {
  if (cells.length === 0) return;
  for (let i = 0; i < cells.length; i += BATCH_SIZE) {
    const chunk = cells.slice(i, i + BATCH_SIZE);
    await db.batch(
      chunk.map((c) =>
        db.prepare(
          'INSERT OR IGNORE INTO gap_tracking (tunnel_name, direction, ts, attempts, first_detected) VALUES (?, ?, ?, 0, ?)',
        ).bind(c.tunnelName, c.direction, c.ts, now),
      ),
    );
  }
}

// Caps by *distinct timestamp*, not cell count: one missing 5-min bucket can be
// thousands of cells at scale, and a plain LIMIT would split a single bucket's
// cells across runs for nothing — one GraphQL call returns every tunnel for a
// bucket anyway. Oldest-first by the earliest first_detected of each timestamp.
export async function getPendingGaps(db: D1Database, maxDistinctTimestamps: number): Promise<TrackedGapCell[]> {
  const { results } = await db.prepare(`
    WITH candidate_ts AS (
      SELECT ts, MIN(first_detected) AS earliest
      FROM gap_tracking
      WHERE confirmed_empty_at IS NULL AND attempts < 3
      GROUP BY ts
      ORDER BY earliest ASC
      LIMIT ?
    )
    SELECT g.tunnel_name, g.direction, g.ts, g.attempts, g.first_detected
    FROM gap_tracking g
    JOIN candidate_ts c ON g.ts = c.ts
    WHERE g.confirmed_empty_at IS NULL AND g.attempts < 3
    ORDER BY g.first_detected ASC
  `).bind(maxDistinctTimestamps).all<{ tunnel_name: string; direction: string; ts: string; attempts: number; first_detected: string }>();

  return results.map((r) => ({
    tunnelName: r.tunnel_name,
    direction: r.direction as 'ingress' | 'egress',
    ts: r.ts,
    attempts: r.attempts,
    firstDetected: r.first_detected,
  }));
}

export async function deleteResolvedGaps(db: D1Database, cells: GapCell[]): Promise<void> {
  if (cells.length === 0) return;
  for (let i = 0; i < cells.length; i += BATCH_SIZE) {
    const chunk = cells.slice(i, i + BATCH_SIZE);
    await db.batch(
      chunk.map((c) =>
        db.prepare('DELETE FROM gap_tracking WHERE tunnel_name = ? AND direction = ? AND ts = ?')
          .bind(c.tunnelName, c.direction, c.ts),
      ),
    );
  }
}

export async function incrementOrConfirmGaps(db: D1Database, cells: GapCell[], now: string): Promise<void> {
  if (cells.length === 0) return;
  for (let i = 0; i < cells.length; i += BATCH_SIZE) {
    const chunk = cells.slice(i, i + BATCH_SIZE);
    await db.batch(
      chunk.map((c) =>
        db.prepare(`
          UPDATE gap_tracking
          SET attempts = attempts + 1,
              confirmed_empty_at = CASE WHEN attempts + 1 >= 3 THEN ? ELSE NULL END
          WHERE tunnel_name = ? AND direction = ? AND ts = ?
        `).bind(now, c.tunnelName, c.direction, c.ts),
      ),
    );
  }
}

// ── Bucket-level gap tracking (gap_buckets) ─────────────────────────────────
// A bucket is a gap when no tunnel reported in either direction. Per-tunnel
// absence is normal (idle tunnels emit no row), so it is not tracked.

// Twelve 5-min slots per hour, each probed with NOT EXISTS rather than a
// LEFT JOIN — a join would multiply the slot by every matching raw row before
// the NULL test. Both raw probes lead with direction so idx_tm_direction_ts
// applies and stops at the first hit: at most 24 index probes per hour,
// independent of tunnel count.
export async function findMissingBuckets(
  db: D1Database,
  windowStart: string,
  windowEnd: string,
): Promise<GapBucket[]> {
  const { results } = await db.prepare(`
    WITH RECURSIVE slots(ts) AS (
      SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?1)
      UNION ALL
      SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ts, '+300 seconds') FROM slots
      WHERE strftime('%Y-%m-%dT%H:%M:%SZ', ts, '+300 seconds') < ?2
    )
    SELECT s.ts FROM slots s
    WHERE NOT EXISTS (SELECT 1 FROM tunnel_metrics WHERE direction = 'ingress' AND ts = s.ts)
      AND NOT EXISTS (SELECT 1 FROM tunnel_metrics WHERE direction = 'egress' AND ts = s.ts)
      AND NOT EXISTS (SELECT 1 FROM gap_buckets WHERE ts = s.ts)
    ORDER BY s.ts
  `).bind(windowStart, windowEnd).all<{ ts: string }>();
  return results.map((r) => ({ ts: r.ts }));
}

export async function insertGapBuckets(db: D1Database, buckets: GapBucket[], now: string): Promise<void> {
  if (buckets.length === 0) return;
  for (let i = 0; i < buckets.length; i += BATCH_SIZE) {
    const chunk = buckets.slice(i, i + BATCH_SIZE);
    await db.batch(
      chunk.map((b) =>
        db.prepare('INSERT OR IGNORE INTO gap_buckets (ts, attempts, first_detected) VALUES (?, 0, ?)')
          .bind(b.ts, now),
      ),
    );
  }
}

// Oldest first_detected first. Rows are buckets, so a plain LIMIT is the
// bucket budget (unlike the per-cell version, which had to cap by distinct ts).
export async function getPendingGapBuckets(db: D1Database, limit: number): Promise<TrackedGapBucket[]> {
  const { results } = await db.prepare(`
    SELECT ts, attempts, first_detected
    FROM gap_buckets
    WHERE confirmed_empty_at IS NULL AND attempts < 3
    ORDER BY first_detected ASC, ts ASC
    LIMIT ?
  `).bind(limit).all<{ ts: string; attempts: number; first_detected: string }>();
  return results.map((r) => ({ ts: r.ts, attempts: r.attempts, firstDetected: r.first_detected }));
}

export async function deleteResolvedGapBuckets(db: D1Database, buckets: GapBucket[]): Promise<void> {
  if (buckets.length === 0) return;
  for (let i = 0; i < buckets.length; i += BATCH_SIZE) {
    const chunk = buckets.slice(i, i + BATCH_SIZE);
    await db.batch(chunk.map((b) => db.prepare('DELETE FROM gap_buckets WHERE ts = ?').bind(b.ts)));
  }
}

export async function incrementOrConfirmGapBuckets(db: D1Database, buckets: GapBucket[], now: string): Promise<void> {
  if (buckets.length === 0) return;
  for (let i = 0; i < buckets.length; i += BATCH_SIZE) {
    const chunk = buckets.slice(i, i + BATCH_SIZE);
    await db.batch(
      chunk.map((b) =>
        db.prepare(`
          UPDATE gap_buckets
          SET attempts = attempts + 1,
              confirmed_empty_at = CASE WHEN attempts + 1 >= 3 THEN ? ELSE NULL END
          WHERE ts = ?
        `).bind(now, b.ts),
      ),
    );
  }
}

export interface GapBucketRow {
  ts: string;
  attempts: number;
  first_detected: string;
  confirmed_empty_at: string | null;
}

// ts range on the primary key. Bounds are raw ts format.
export async function getGapBuckets(
  db: D1Database,
  start: string,
  end: string,
  status: 'pending' | 'confirmed_empty' | null,
  limit: number,
): Promise<GapBucketRow[]> {
  const statusClause = status === 'pending'
    ? 'AND confirmed_empty_at IS NULL'
    : status === 'confirmed_empty'
      ? 'AND confirmed_empty_at IS NOT NULL'
      : '';
  const { results } = await db.prepare(`
    SELECT ts, attempts, first_detected, confirmed_empty_at
    FROM gap_buckets
    WHERE ts >= ?1 AND ts < ?2 ${statusClause}
    ORDER BY ts
    LIMIT ?3
  `).bind(start, end, limit).all<GapBucketRow>();
  return results;
}

export async function getGapBucketCounts(
  db: D1Database,
  confirmedSince: string,
): Promise<{ pending: number; confirmedEmpty: number }> {
  const [p, c] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM gap_buckets WHERE confirmed_empty_at IS NULL').first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM gap_buckets WHERE confirmed_empty_at >= ?').bind(confirmedSince).first<{ n: number }>(),
  ]);
  return { pending: p?.n ?? 0, confirmedEmpty: c?.n ?? 0 };
}

// Range totals for /api/gaps — the LIMIT-bounded page is not a valid source
// for counts once a status filter narrows it.
export async function getGapBucketRangeCounts(
  db: D1Database,
  start: string,
  end: string,
): Promise<{ pending: number; confirmedEmpty: number }> {
  const [p, c] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM gap_buckets WHERE ts >= ?1 AND ts < ?2 AND confirmed_empty_at IS NULL').bind(start, end).first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM gap_buckets WHERE ts >= ?1 AND ts < ?2 AND confirmed_empty_at IS NOT NULL').bind(start, end).first<{ n: number }>(),
  ]);
  return { pending: p?.n ?? 0, confirmedEmpty: c?.n ?? 0 };
}

export interface GapCellRow {
  tunnel_name: string;
  direction: string;
  ts: string;
  attempts: number;
  first_detected: string;
  confirmed_empty_at: string | null;
}

// Range predicate on ts uses idx_gap_ts; the optional filters are applied
// after the index range. Bounds are raw ts format.
export async function getGapCells(
  db: D1Database,
  start: string,
  end: string,
  tunnel: string | null,
  status: 'pending' | 'confirmed_empty' | null,
  limit: number,
): Promise<GapCellRow[]> {
  const statusClause = status === 'pending'
    ? 'AND confirmed_empty_at IS NULL'
    : status === 'confirmed_empty'
      ? 'AND confirmed_empty_at IS NOT NULL'
      : '';
  const tunnelClause = tunnel !== null ? 'AND tunnel_name = ?3' : '';
  const sql = `
    SELECT tunnel_name, direction, ts, attempts, first_detected, confirmed_empty_at
    FROM gap_tracking
    WHERE ts >= ?1 AND ts < ?2 ${tunnelClause} ${statusClause}
    ORDER BY ts, tunnel_name, direction
    LIMIT ?4
  `;
  const stmt = db.prepare(sql);
  const bound = tunnel !== null ? stmt.bind(start, end, tunnel, limit) : stmt.bind(start, end, null, limit);
  const { results } = await bound.all<GapCellRow>();
  return results;
}

// Both predicates lead idx_gap_pending (confirmed_empty_at, ...).
export async function getGapCounts(
  db: D1Database,
  confirmedSince: string,
): Promise<{ pending: number; confirmedEmpty: number }> {
  const [p, c] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM gap_tracking WHERE confirmed_empty_at IS NULL').first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM gap_tracking WHERE confirmed_empty_at >= ?').bind(confirmedSince).first<{ n: number }>(),
  ]);
  return { pending: p?.n ?? 0, confirmedEmpty: c?.n ?? 0 };
}

// Range totals for /api/gaps — the page (LIMIT-bounded) is not a valid source
// for pending/confirmed_empty counts, since a truncated or filtered page
// undercounts. Same optional-tunnel bind trick as getGapCells: bind null for
// ?3 when tunnel is absent so one prepared statement covers both cases.
export async function getGapRangeCounts(
  db: D1Database,
  start: string,
  end: string,
  tunnel: string | null,
): Promise<{ pending: number; confirmedEmpty: number }> {
  const tunnelClause = tunnel !== null ? 'AND tunnel_name = ?3' : '';
  const pendingSql = `SELECT COUNT(*) AS n FROM gap_tracking WHERE ts >= ?1 AND ts < ?2 ${tunnelClause} AND confirmed_empty_at IS NULL`;
  const confirmedSql = `SELECT COUNT(*) AS n FROM gap_tracking WHERE ts >= ?1 AND ts < ?2 ${tunnelClause} AND confirmed_empty_at IS NOT NULL`;
  const bindArgs = tunnel !== null ? [start, end, tunnel] : [start, end];
  const [p, c] = await Promise.all([
    db.prepare(pendingSql).bind(...bindArgs).first<{ n: number }>(),
    db.prepare(confirmedSql).bind(...bindArgs).first<{ n: number }>(),
  ]);
  return { pending: p?.n ?? 0, confirmedEmpty: c?.n ?? 0 };
}

// ── Current-window bulk query (/api/current) ────────────────────────────────
// Bind: ?1 = since, in raw ts format 'YYYY-MM-DDTHH:MM:SSZ'.
// Per-direction predicates keep idx_tm_direction_ts (direction, ts) in play;
// a bare "ts >= ?" would full-scan tunnel_metrics (millions of rows at
// 500+ tunnels x 7-day retention).
export const CURRENT_METRICS_SQL = `
  SELECT tunnel_name, direction, ts, bit_rate, written_at FROM tunnel_metrics
  WHERE direction = 'ingress' AND ts >= ?1
  UNION ALL
  SELECT tunnel_name, direction, ts, bit_rate, written_at FROM tunnel_metrics
  WHERE direction = 'egress' AND ts >= ?1
  ORDER BY tunnel_name, direction, ts
`;

// ── Changed-since query (/api/current?since=) ───────────────────────────────
// Bind: ?1 = since (exclusive), ?2 = until (inclusive), both toISOString()
// form to match written_at; ?3 = row limit. Uses the partial index
// idx_tm_written_at; NULL (pre-migration) rows never match.
export const CHANGED_SINCE_SQL = `
  SELECT tunnel_name, direction, ts, bit_rate, written_at FROM tunnel_metrics
  WHERE written_at > ?1 AND written_at <= ?2
  ORDER BY written_at, tunnel_name, direction, ts
  LIMIT ?3
`;

// Fallback for /api/current?since= when a single written_at group is larger
// than the page: fetch the whole group (equality on the indexed column) so it
// is returned intact rather than split across pages. Bind: ?1 = written_at.
// LIMIT 100000 is a sanity cap only — a single write group (one D1 batch,
// BATCH_SIZE = 100 rows since F1) can never approach it in practice.
export const CHANGED_SINCE_GROUP_SQL = `
  SELECT tunnel_name, direction, ts, bit_rate, written_at FROM tunnel_metrics
  WHERE written_at = ?1
  ORDER BY tunnel_name, direction, ts
  LIMIT 100000
`;

// ── SQL for per-tunnel p95 ──────────────────────────────────────────────────
// Bind params: ?1=tunnel_name, ?2=direction, ?3=since, ?4=until, ?5=step_seconds
//
// ts format contract: raw rows store 'YYYY-MM-DDTHH:MM:SSZ' (GraphQL
// datetimeFiveMinutes), hourly/daily rows store toISOString()
// 'YYYY-MM-DDTHH:MM:SS.000Z'. Slot-join conditions must transform the slot
// side (replace(s.ts, 'Z', '.000Z')), never wrap m.ts in strftime() — a
// function around m.ts defeats the (tunnel_name, direction, ts) index and
// turns the join into a full scan per slot (>30s on D1 at ~550 tunnels).

export const P95_PER_TUNNEL_RAW_SQL = `
  WITH RECURSIVE slots(ts) AS (
    SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?3)
    UNION ALL
    SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ts, '+' || ?5 || ' seconds') FROM slots
    WHERE strftime('%Y-%m-%dT%H:%M:%SZ', ts, '+' || ?5 || ' seconds') < ?4
  ),
  ranked AS (
    SELECT COALESCE(m.bit_rate, 0) AS val,
           ROW_NUMBER() OVER (ORDER BY COALESCE(m.bit_rate, 0)) AS rn,
           COUNT(*) OVER () AS n
    FROM slots s
    LEFT JOIN tunnel_metrics m
      ON m.ts = s.ts AND m.tunnel_name = ?1 AND m.direction = ?2
  )
  SELECT val FROM ranked WHERE rn = CAST(CEIL(0.95 * n) AS INTEGER) LIMIT 1
`;

export const P95_PER_TUNNEL_HOURLY_SQL = `
  WITH RECURSIVE slots(ts) AS (
    SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?3)
    UNION ALL
    SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ts, '+' || ?5 || ' seconds') FROM slots
    WHERE strftime('%Y-%m-%dT%H:%M:%SZ', ts, '+' || ?5 || ' seconds') < ?4
  ),
  ranked AS (
    SELECT COALESCE(m.avg_bit_rate, 0) AS val,
           ROW_NUMBER() OVER (ORDER BY COALESCE(m.avg_bit_rate, 0)) AS rn,
           COUNT(*) OVER () AS n
    FROM slots s
    LEFT JOIN tunnel_metrics_hourly m
      ON m.ts = replace(s.ts, 'Z', '.000Z') AND m.tunnel_name = ?1 AND m.direction = ?2
  )
  SELECT val FROM ranked WHERE rn = CAST(CEIL(0.95 * n) AS INTEGER) LIMIT 1
`;

export const P95_PER_TUNNEL_DAILY_SQL = `
  WITH RECURSIVE slots(ts) AS (
    SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?3)
    UNION ALL
    SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ts, '+' || ?5 || ' seconds') FROM slots
    WHERE strftime('%Y-%m-%dT%H:%M:%SZ', ts, '+' || ?5 || ' seconds') < ?4
  ),
  ranked AS (
    SELECT COALESCE(m.avg_bit_rate, 0) AS val,
           ROW_NUMBER() OVER (ORDER BY COALESCE(m.avg_bit_rate, 0)) AS rn,
           COUNT(*) OVER () AS n
    FROM slots s
    LEFT JOIN tunnel_metrics_daily m
      ON m.ts = replace(s.ts, 'Z', '.000Z') AND m.tunnel_name = ?1 AND m.direction = ?2
  )
  SELECT val FROM ranked WHERE rn = CAST(CEIL(0.95 * n) AS INTEGER) LIMIT 1
`;

// ── SQL for aggregate p95 ───────────────────────────────────────────────────
// Bind params: ?1=direction, ?2=since, ?3=excludeJson, ?4=until, ?5=step_seconds

export const P95_AGGREGATE_RAW_SQL = `
  WITH RECURSIVE slots(ts) AS (
    SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?2)
    UNION ALL
    SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ts, '+' || ?5 || ' seconds') FROM slots
    WHERE strftime('%Y-%m-%dT%H:%M:%SZ', ts, '+' || ?5 || ' seconds') < ?4
  ),
  totals AS (
    SELECT s.ts, COALESCE(SUM(m.bit_rate), 0) AS val
    FROM slots s
    LEFT JOIN tunnel_metrics m
      ON m.ts = s.ts AND m.direction = ?1
      AND m.tunnel_name NOT IN (SELECT value FROM json_each(?3))
    GROUP BY s.ts
  ),
  ranked AS (
    SELECT val,
           ROW_NUMBER() OVER (ORDER BY val) AS rn,
           COUNT(*) OVER () AS n
    FROM totals
  )
  SELECT val FROM ranked WHERE rn = CAST(CEIL(0.95 * n) AS INTEGER) LIMIT 1
`;

export const P95_AGGREGATE_HOURLY_SQL = `
  WITH RECURSIVE slots(ts) AS (
    SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?2)
    UNION ALL
    SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ts, '+' || ?5 || ' seconds') FROM slots
    WHERE strftime('%Y-%m-%dT%H:%M:%SZ', ts, '+' || ?5 || ' seconds') < ?4
  ),
  totals AS (
    SELECT s.ts, COALESCE(SUM(m.avg_bit_rate), 0) AS val
    FROM slots s
    LEFT JOIN tunnel_metrics_hourly m
      ON m.ts = replace(s.ts, 'Z', '.000Z') AND m.direction = ?1
      AND m.tunnel_name NOT IN (SELECT value FROM json_each(?3))
    GROUP BY s.ts
  ),
  ranked AS (
    SELECT val,
           ROW_NUMBER() OVER (ORDER BY val) AS rn,
           COUNT(*) OVER () AS n
    FROM totals
  )
  SELECT val FROM ranked WHERE rn = CAST(CEIL(0.95 * n) AS INTEGER) LIMIT 1
`;

export const P95_AGGREGATE_DAILY_SQL = `
  WITH RECURSIVE slots(ts) AS (
    SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?2)
    UNION ALL
    SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ts, '+' || ?5 || ' seconds') FROM slots
    WHERE strftime('%Y-%m-%dT%H:%M:%SZ', ts, '+' || ?5 || ' seconds') < ?4
  ),
  totals AS (
    SELECT s.ts, COALESCE(SUM(m.avg_bit_rate), 0) AS val
    FROM slots s
    LEFT JOIN tunnel_metrics_daily m
      ON m.ts = replace(s.ts, 'Z', '.000Z') AND m.direction = ?1
      AND m.tunnel_name NOT IN (SELECT value FROM json_each(?3))
    GROUP BY s.ts
  ),
  ranked AS (
    SELECT val,
           ROW_NUMBER() OVER (ORDER BY val) AS rn,
           COUNT(*) OVER () AS n
    FROM totals
  )
  SELECT val FROM ranked WHERE rn = CAST(CEIL(0.95 * n) AS INTEGER) LIMIT 1
`;

// ── Paginated tunnel list ───────────────────────────────────────────────────

// Bind params: ?1=since, ?2=pageSize, ?3=offset, ?4=until, ?5=step_seconds
// If hasSearch: ?6=searchPattern
export function buildPaginatedTunnelsSql(
  table: 'raw' | 'hourly' | 'daily',
  sortColumn: string,
  sortDir: string,
  hasSearch: boolean,
): string {
  const source = table === 'raw'
    ? 'tunnel_metrics'
    : table === 'hourly'
      ? 'tunnel_metrics_hourly'
      : 'tunnel_metrics_daily';
  const valueCol = table === 'raw' ? 'bit_rate' : 'avg_bit_rate';
  // See ts format contract above: raw ts already matches the slot format;
  // rollup ts carries toISOString() milliseconds, so pad the slot side.
  const slotTs = table === 'raw' ? 's.ts' : "replace(s.ts, 'Z', '.000Z')";

  return `
    WITH RECURSIVE slots(ts) AS (
      SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?1)
      UNION ALL
      SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ts, '+' || ?5 || ' seconds') FROM slots
      WHERE strftime('%Y-%m-%dT%H:%M:%SZ', ts, '+' || ?5 || ' seconds') < ?4
    ),
    tunnel_names AS (
      SELECT DISTINCT tunnel_name FROM ${source}
      WHERE ts >= ?1 ${hasSearch ? 'AND tunnel_name LIKE ?6' : ''}
    ),
    filled AS (
      SELECT tn.tunnel_name, d.direction, s.ts,
             COALESCE(m.${valueCol}, 0) AS val
      FROM tunnel_names tn
      CROSS JOIN (SELECT 'ingress' AS direction UNION ALL SELECT 'egress') d
      CROSS JOIN slots s
      LEFT JOIN ${source} m
        ON m.tunnel_name = tn.tunnel_name AND m.direction = d.direction AND m.ts = ${slotTs}
    ),
    ranked AS (
      SELECT tunnel_name, direction, val,
             ROW_NUMBER() OVER (PARTITION BY tunnel_name, direction ORDER BY val) AS rn,
             COUNT(*) OVER (PARTITION BY tunnel_name, direction) AS n
      FROM filled
    ),
    p95 AS (
      SELECT tunnel_name, direction, val AS p95_bps
      FROM ranked
      WHERE rn = CAST(CEIL(0.95 * n) AS INTEGER)
    ),
    pivoted AS (
      SELECT
        tunnel_name,
        MAX(CASE WHEN direction = 'ingress' THEN p95_bps END) AS p95_ingress_bps,
        MAX(CASE WHEN direction = 'egress'  THEN p95_bps END) AS p95_egress_bps
      FROM p95
      GROUP BY tunnel_name
    )
    SELECT
      tunnel_name,
      p95_ingress_bps,
      p95_egress_bps,
      COALESCE(
        CASE WHEN COALESCE(p95_ingress_bps, 0) > COALESCE(p95_egress_bps, 0)
             THEN p95_ingress_bps ELSE p95_egress_bps END,
        0
      ) AS p95_max
    FROM pivoted
    ORDER BY ${sortColumn} ${sortDir}
    LIMIT ?2 OFFSET ?3
  `;
}

export function buildTunnelCountSql(table: 'raw' | 'hourly' | 'daily', hasSearch: boolean): string {
  const source = table === 'raw'
    ? 'tunnel_metrics'
    : table === 'hourly'
      ? 'tunnel_metrics_hourly'
      : 'tunnel_metrics_daily';
  const searchFilter = hasSearch ? 'AND tunnel_name LIKE ?' : '';
  return `SELECT COUNT(DISTINCT tunnel_name) AS total FROM ${source} WHERE ts >= ? ${searchFilter}`;
}

export function buildTimeSeriesSql(table: 'raw' | 'hourly' | 'daily'): string {
  const source = table === 'raw'
    ? 'tunnel_metrics'
    : table === 'hourly'
      ? 'tunnel_metrics_hourly'
      : 'tunnel_metrics_daily';
  const valueCol = table === 'raw' ? 'bit_rate' : 'avg_bit_rate';
  return `SELECT ts, ${valueCol} AS bit_rate FROM ${source} WHERE tunnel_name = ? AND direction = ? AND ts >= ? ORDER BY ts`;
}

export function getP95PerTunnelSql(table: 'raw' | 'hourly' | 'daily'): string {
  if (table === 'raw') return P95_PER_TUNNEL_RAW_SQL;
  if (table === 'hourly') return P95_PER_TUNNEL_HOURLY_SQL;
  return P95_PER_TUNNEL_DAILY_SQL;
}

export function getP95AggregateSql(table: 'raw' | 'hourly' | 'daily'): string {
  if (table === 'raw') return P95_AGGREGATE_RAW_SQL;
  if (table === 'hourly') return P95_AGGREGATE_HOURLY_SQL;
  return P95_AGGREGATE_DAILY_SQL;
}

// ── Metadata ────────────────────────────────────────────────────────────────

export async function getMetadata(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM cron_metadata WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setMetadata(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare('INSERT OR REPLACE INTO cron_metadata (key, value) VALUES (?, ?)').bind(key, value).run();
}

// cron_metadata is a few dozen rows; one read is cheaper than a key list.
export async function getAllMetadata(db: D1Database): Promise<Record<string, string>> {
  const { results } = await db.prepare('SELECT key, value FROM cron_metadata').all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

const MAX_ERROR_MESSAGE_CHARS = 500;

// Never throws — this runs inside the cron's own catch blocks, and a failure
// here must not abort handleCron or skip the steps that follow it.
export async function recordCronError(db: D1Database, step: CronStep, err: unknown): Promise<void> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_MESSAGE_CHARS);
  console.error(`Cron step ${step} failed: ${message}`);
  const upsert = 'INSERT OR REPLACE INTO cron_metadata (key, value) VALUES (?, ?)';
  try {
    const at = new Date().toISOString();
    await db.batch([
      // Most recent error overall (existing consumers) …
      db.prepare(upsert).bind('last_error_at', at),
      db.prepare(upsert).bind('last_error_step', step),
      db.prepare(upsert).bind('last_error_message', message),
      // … and per step, so an hourly failure cannot mask a daily one.
      db.prepare(upsert).bind(`last_error_${step}_at`, at),
      db.prepare(upsert).bind(`last_error_${step}_message`, message),
    ]);
  } catch (writeErr) {
    const writeMessage = writeErr instanceof Error ? writeErr.message : String(writeErr);
    console.error(`Failed to record cron error for step ${step}: ${writeMessage}`);
  }
}

// ── Billing p95 storage ─────────────────────────────────────────────────────

export async function storeBillingP95(
  db: D1Database,
  period: string,
  tunnelName: string,
  direction: 'ingress' | 'egress',
  p95Bps: number,
  sampleCount: number,
): Promise<void> {
  await db.prepare(`
    INSERT OR REPLACE INTO billing_p95 (period, tunnel_name, direction, p95_bps, sample_count, computed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(period, tunnelName, direction, p95Bps, sampleCount, new Date().toISOString()).run();
}

export async function getBillingP95Summary(
  db: D1Database,
  period: string,
): Promise<{ ingress: number | null; egress: number | null; computed_at: string | null }> {
  const rows = await db.prepare(
    "SELECT direction, p95_bps, computed_at FROM billing_p95 WHERE period = ? AND tunnel_name = '*'"
  ).bind(period).all<{ direction: string; p95_bps: number; computed_at: string }>();

  let ingress: number | null = null;
  let egress: number | null = null;
  let computed_at: string | null = null;

  for (const row of rows.results) {
    if (row.direction === 'ingress') { ingress = row.p95_bps; computed_at = row.computed_at; }
    if (row.direction === 'egress') { egress = row.p95_bps; computed_at = row.computed_at; }
  }

  return { ingress, egress, computed_at };
}

export async function getBillingP95Tunnels(
  db: D1Database,
  period: string,
  sortColumn: string,
  sortDir: string,
  limit: number,
  offset: number,
): Promise<{ tunnels: TunnelStat[]; total: number }> {
  const validCols: Record<string, string> = {
    'name': 'tunnel_name',
    'p95-ingress': 'COALESCE(p95_in, 0)',
    'p95-egress': 'COALESCE(p95_eg, 0)',
    'p95-max': 'COALESCE(CASE WHEN COALESCE(p95_in,0)>COALESCE(p95_eg,0) THEN p95_in ELSE p95_eg END, 0)',
  };
  const col = validCols[sortColumn] ?? 'tunnel_name';
  const dir = sortDir === 'ASC' ? 'ASC' : 'DESC';

  const countResult = await db.prepare(
    "SELECT COUNT(DISTINCT tunnel_name) AS total FROM billing_p95 WHERE period = ? AND tunnel_name != '*'"
  ).bind(period).first<{ total: number }>();

  const { results } = await db.prepare(`
    SELECT
      tunnel_name,
      MAX(CASE WHEN direction = 'ingress' THEN p95_bps END) AS p95_in,
      MAX(CASE WHEN direction = 'egress'  THEN p95_bps END) AS p95_eg
    FROM billing_p95
    WHERE period = ? AND tunnel_name != '*'
    GROUP BY tunnel_name
    ORDER BY ${col} ${dir}
    LIMIT ? OFFSET ?
  `).bind(period, limit, offset).all<{ tunnel_name: string; p95_in: number | null; p95_eg: number | null }>();

  return {
    total: countResult?.total ?? 0,
    tunnels: results.map((r) => ({
      tunnel_name: r.tunnel_name,
      p95_ingress_bps: r.p95_in,
      p95_egress_bps: r.p95_eg,
    })),
  };
}
