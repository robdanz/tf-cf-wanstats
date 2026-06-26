-- Hourly rollups of 5-min raw data. Used for 7d/30d dashboard views.
CREATE TABLE IF NOT EXISTS tunnel_metrics_hourly (
  tunnel_name  TEXT    NOT NULL,
  direction    TEXT    NOT NULL,
  ts           TEXT    NOT NULL,
  avg_bit_rate REAL    NOT NULL,
  max_bit_rate REAL    NOT NULL,
  min_bit_rate REAL    NOT NULL,
  sample_count INTEGER NOT NULL,
  PRIMARY KEY (tunnel_name, direction, ts)
);

CREATE INDEX IF NOT EXISTS idx_tmh_direction_ts
  ON tunnel_metrics_hourly (direction, ts);
CREATE INDEX IF NOT EXISTS idx_tmh_tunnel_direction_ts
  ON tunnel_metrics_hourly (tunnel_name, direction, ts);

-- Daily rollups. Used for 90d/180d dashboard views.
CREATE TABLE IF NOT EXISTS tunnel_metrics_daily (
  tunnel_name  TEXT    NOT NULL,
  direction    TEXT    NOT NULL,
  ts           TEXT    NOT NULL,
  avg_bit_rate REAL    NOT NULL,
  max_bit_rate REAL    NOT NULL,
  min_bit_rate REAL    NOT NULL,
  sample_count INTEGER NOT NULL,
  PRIMARY KEY (tunnel_name, direction, ts)
);

CREATE INDEX IF NOT EXISTS idx_tmd_direction_ts
  ON tunnel_metrics_daily (direction, ts);
CREATE INDEX IF NOT EXISTS idx_tmd_tunnel_direction_ts
  ON tunnel_metrics_daily (tunnel_name, direction, ts);

-- Pre-computed billing-grade p95 from R2 raw data.
CREATE TABLE IF NOT EXISTS billing_p95 (
  period       TEXT    NOT NULL,
  tunnel_name  TEXT    NOT NULL,
  direction    TEXT    NOT NULL,
  p95_bps      REAL    NOT NULL,
  sample_count INTEGER NOT NULL,
  computed_at  TEXT    NOT NULL,
  PRIMARY KEY (period, tunnel_name, direction)
);

-- Key-value metadata for cron state tracking.
CREATE TABLE IF NOT EXISTS cron_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
