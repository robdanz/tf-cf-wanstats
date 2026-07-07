import type { NormalizedRow, TunnelStat } from './types';

const BATCH_SIZE = 100;

export async function storeTunnelMetrics(
  db: D1Database,
  rows: NormalizedRow[],
  direction: 'ingress' | 'egress',
): Promise<void> {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    await db.batch(
      chunk.map((row) =>
        db.prepare(
          'INSERT OR REPLACE INTO tunnel_metrics (tunnel_name, direction, ts, bit_rate) VALUES (?, ?, ?, ?)',
        ).bind(row.tunnelName, direction, row.ts, row.bitRate),
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
}> {
  const now = new Date();
  const rawCutoff = new Date(now);
  rawCutoff.setUTCDate(rawCutoff.getUTCDate() - 7);
  const hourlyCutoff = new Date(now);
  hourlyCutoff.setUTCDate(hourlyCutoff.getUTCDate() - 60);
  const dailyCutoff = new Date(now);
  dailyCutoff.setUTCDate(dailyCutoff.getUTCDate() - 180);

  const [rawResult, hourlyResult, dailyResult] = await Promise.all([
    db.prepare('DELETE FROM tunnel_metrics WHERE ts < ?').bind(rawCutoff.toISOString()).run(),
    db.prepare('DELETE FROM tunnel_metrics_hourly WHERE ts < ?').bind(hourlyCutoff.toISOString()).run(),
    db.prepare('DELETE FROM tunnel_metrics_daily WHERE ts < ?').bind(dailyCutoff.toISOString()).run(),
  ]);

  return {
    rawDeleted: rawResult.meta.changes ?? 0,
    hourlyDeleted: hourlyResult.meta.changes ?? 0,
    dailyDeleted: dailyResult.meta.changes ?? 0,
  };
}

// ── SQL for per-tunnel p95 ──────────────────────────────────────────────────
// Bind params: ?1=tunnel_name, ?2=direction, ?3=since, ?4=until, ?5=step_seconds

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
      ON strftime('%Y-%m-%dT%H:%M:%SZ', m.ts) = s.ts AND m.tunnel_name = ?1 AND m.direction = ?2
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
      ON strftime('%Y-%m-%dT%H:%M:%SZ', m.ts) = s.ts AND m.tunnel_name = ?1 AND m.direction = ?2
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
      ON strftime('%Y-%m-%dT%H:%M:%SZ', m.ts) = s.ts AND m.direction = ?1
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
      ON strftime('%Y-%m-%dT%H:%M:%SZ', m.ts) = s.ts AND m.direction = ?1
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
        ON m.tunnel_name = tn.tunnel_name AND m.direction = d.direction AND strftime('%Y-%m-%dT%H:%M:%SZ', m.ts) = s.ts
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
