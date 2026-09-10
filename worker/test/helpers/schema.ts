// The vitest D1 binding starts empty — no migrations are auto-applied.
// Each test file that touches D1 calls this once (in beforeAll) to create
// the tables it needs, matching migrations/0001_initial.sql, 0002_rollups.sql,
// 0004_written_at.sql, and 0005_gap_buckets.sql (0003's gap_tracking is dropped by 0005). D1Database.exec() takes one
// statement at a time (embedded newlines can be misread as statement separators),
// so each entry here must be a single logical line.
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS tunnel_metrics ( tunnel_name TEXT NOT NULL, direction TEXT NOT NULL, ts TEXT NOT NULL, bit_rate REAL NOT NULL, written_at TEXT, PRIMARY KEY (tunnel_name, direction, ts) )`,
  `CREATE INDEX IF NOT EXISTS idx_tm_direction_ts ON tunnel_metrics (direction, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_tm_tunnel_direction_ts ON tunnel_metrics (tunnel_name, direction, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_tm_written_at ON tunnel_metrics (written_at) WHERE written_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS tunnel_metrics_hourly ( tunnel_name TEXT NOT NULL, direction TEXT NOT NULL, ts TEXT NOT NULL, avg_bit_rate REAL NOT NULL, max_bit_rate REAL NOT NULL, min_bit_rate REAL NOT NULL, sample_count INTEGER NOT NULL, PRIMARY KEY (tunnel_name, direction, ts) )`,
  `CREATE TABLE IF NOT EXISTS tunnel_metrics_daily ( tunnel_name TEXT NOT NULL, direction TEXT NOT NULL, ts TEXT NOT NULL, avg_bit_rate REAL NOT NULL, max_bit_rate REAL NOT NULL, min_bit_rate REAL NOT NULL, sample_count INTEGER NOT NULL, PRIMARY KEY (tunnel_name, direction, ts) )`,
  `CREATE TABLE IF NOT EXISTS gap_buckets ( ts TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, first_detected TEXT NOT NULL, confirmed_empty_at TEXT )`,
  `CREATE INDEX IF NOT EXISTS idx_gap_buckets_pending ON gap_buckets (confirmed_empty_at, attempts, first_detected)`,
  `CREATE TABLE IF NOT EXISTS cron_metadata ( key TEXT PRIMARY KEY, value TEXT NOT NULL )`,
  `CREATE TABLE IF NOT EXISTS billing_p95 ( period TEXT NOT NULL, tunnel_name TEXT NOT NULL, direction TEXT NOT NULL, p95_bps REAL NOT NULL, sample_count INTEGER NOT NULL, computed_at TEXT NOT NULL, PRIMARY KEY (period, tunnel_name, direction) )`,
];

export async function applyTestSchema(db: D1Database): Promise<void> {
  for (const statement of STATEMENTS) {
    await db.exec(statement);
  }
}
