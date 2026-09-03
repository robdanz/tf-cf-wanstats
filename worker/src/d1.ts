import type { NormalizedRow, TunnelStat, GapCell, TrackedGapCell, CronStep } from './types';

const BATCH_SIZE = 100;

// Conditional upsert: written_at moves only when the row is new or its value
// changed. Light runs re-fetch the same buckets every 5 minutes; with plain
// INSERT OR REPLACE every one of those would look "changed" to
// /api/current?since= polling.
export async function storeTunnelMetrics(
  db: D1Database,
  rows: NormalizedRow[],
  direction: 'ingress' | 'egress',
  writtenAt: string = new Date().toISOString(),
): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    await db.batch(
      chunk.map((row) =>
        db.prepare(`
          INSERT INTO tunnel_metrics (tunnel_name, direction, ts, bit_rate, written_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (tunnel_name, direction, ts) DO UPDATE
            SET bit_rate = excluded.bit_rate, written_at = excluded.written_at
            WHERE bit_rate IS NOT excluded.bit_rate
        `).bind(row.tunnelName, direction, row.ts, row.bitRate, writtenAt),
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

  const [rawResult, hourlyResult, dailyResult, gapResult] = await Promise.all([
    db.prepare('DELETE FROM tunnel_metrics WHERE ts < ?').bind(rawCutoff.toISOString()).run(),
    db.prepare('DELETE FROM tunnel_metrics_hourly WHERE ts < ?').bind(hourlyCutoff.toISOString()).run(),
    db.prepare('DELETE FROM tunnel_metrics_daily WHERE ts < ?').bind(dailyCutoff.toISOString()).run(),
    db.prepare('DELETE FROM gap_tracking WHERE confirmed_empty_at IS NOT NULL AND confirmed_empty_at < ?').bind(rawCutoff.toISOString()).run(),
  ]);

  return {
    rawDeleted: rawResult.meta.changes ?? 0,
    hourlyDeleted: hourlyResult.meta.changes ?? 0,
    dailyDeleted: dailyResult.meta.changes ?? 0,
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
export const CHANGED_SINCE_GROUP_SQL = `
  SELECT tunnel_name, direction, ts, bit_rate, written_at FROM tunnel_metrics
  WHERE written_at = ?1
  ORDER BY tunnel_name, direction, ts
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

const MAX_ERROR_MESSAGE_CHARS = 500;

// Never throws — this runs inside the cron's own catch blocks, and a failure
// here must not abort handleCron or skip the steps that follow it.
export async function recordCronError(db: D1Database, step: CronStep, err: unknown): Promise<void> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_MESSAGE_CHARS);
  console.error(`Cron step ${step} failed: ${message}`);
  const upsert = 'INSERT OR REPLACE INTO cron_metadata (key, value) VALUES (?, ?)';
  try {
    await db.batch([
      db.prepare(upsert).bind('last_error_at', new Date().toISOString()),
      db.prepare(upsert).bind('last_error_step', step),
      db.prepare(upsert).bind('last_error_message', message),
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
