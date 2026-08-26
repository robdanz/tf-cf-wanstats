// The vitest D1 binding starts empty — no migrations are auto-applied.
// Each test file that touches D1 calls this once (in beforeAll) to create
// the tables it needs, matching migrations/0001_initial.sql, 0002_rollups.sql,
// and 0003_gap_tracking.sql. D1Database.exec() takes one statement at a
// time (embedded newlines can be misread as statement separators), so each
// entry here must be a single logical line.
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS tunnel_metrics ( tunnel_name TEXT NOT NULL, direction TEXT NOT NULL, ts TEXT NOT NULL, bit_rate REAL NOT NULL, PRIMARY KEY (tunnel_name, direction, ts) )`,
  `CREATE INDEX IF NOT EXISTS idx_tm_direction_ts ON tunnel_metrics (direction, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_tm_tunnel_direction_ts ON tunnel_metrics (tunnel_name, direction, ts)`,
  `CREATE TABLE IF NOT EXISTS tunnel_metrics_hourly ( tunnel_name TEXT NOT NULL, direction TEXT NOT NULL, ts TEXT NOT NULL, avg_bit_rate REAL NOT NULL, max_bit_rate REAL NOT NULL, min_bit_rate REAL NOT NULL, sample_count INTEGER NOT NULL, PRIMARY KEY (tunnel_name, direction, ts) )`,
  `CREATE TABLE IF NOT EXISTS tunnel_metrics_daily ( tunnel_name TEXT NOT NULL, direction TEXT NOT NULL, ts TEXT NOT NULL, avg_bit_rate REAL NOT NULL, max_bit_rate REAL NOT NULL, min_bit_rate REAL NOT NULL, sample_count INTEGER NOT NULL, PRIMARY KEY (tunnel_name, direction, ts) )`,
  `CREATE TABLE IF NOT EXISTS gap_tracking ( tunnel_name TEXT NOT NULL, direction TEXT NOT NULL, ts TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, first_detected TEXT NOT NULL, confirmed_empty_at TEXT, PRIMARY KEY (tunnel_name, direction, ts) )`,
  `CREATE INDEX IF NOT EXISTS idx_gap_pending ON gap_tracking (confirmed_empty_at, attempts, first_detected)`,
];

export async function applyTestSchema(db: D1Database): Promise<void> {
  for (const statement of STATEMENTS) {
    await db.exec(statement);
  }
}
