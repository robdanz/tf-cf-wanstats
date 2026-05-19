-- Cloudflare WAN tunnel utilization metrics
-- One row per tunnel per direction per 5-minute interval.
-- Composite PK prevents duplicate inserts from cron retries.

CREATE TABLE IF NOT EXISTS tunnel_metrics (
  tunnel_name TEXT NOT NULL,
  direction   TEXT NOT NULL,  -- 'ingress' | 'egress'
  ts          TEXT NOT NULL,  -- ISO 8601 5-min bucket, e.g. '2024-01-15T14:05:00Z'
  bit_rate    REAL NOT NULL,  -- avg bitRateFiveMinutes in bits per second
  PRIMARY KEY (tunnel_name, direction, ts)
);

CREATE INDEX IF NOT EXISTS idx_tm_direction_ts ON tunnel_metrics (direction, ts);
CREATE INDEX IF NOT EXISTS idx_tm_tunnel_direction_ts ON tunnel_metrics (tunnel_name, direction, ts);
