-- Roster for absent-row fills (worker/src/fill.ts): one row per tunnel per
-- UTC day it had at least one real (non-fill) row in either direction, with
-- the first such ts that day. A tunnel is expected to have a value in every
-- bucket of hour H when it was seen in the 7 days up to H.
CREATE TABLE IF NOT EXISTS tunnel_seen_days (
  tunnel_name TEXT NOT NULL,
  day         TEXT NOT NULL,   -- 'YYYY-MM-DD'
  first_ts    TEXT NOT NULL,   -- raw ts format 'YYYY-MM-DDTHH:MM:SSZ'
  PRIMARY KEY (tunnel_name, day)
);
CREATE INDEX IF NOT EXISTS idx_tsd_day ON tunnel_seen_days (day);

-- Seed: the last 3 days exactly from the hourly rollups (per-direction ranges
-- keep idx_tmh_direction_ts in play), older days from the daily rollups with
-- first_ts at midnight. No fills exist yet, so every rollup row is real.
INSERT OR IGNORE INTO tunnel_seen_days (tunnel_name, day, first_ts)
  SELECT tunnel_name, substr(ts, 1, 10), replace(MIN(ts), '.000Z', 'Z') FROM (
    SELECT tunnel_name, ts FROM tunnel_metrics_hourly
      WHERE direction = 'ingress' AND ts >= strftime('%Y-%m-%dT00:00:00.000Z', 'now', '-3 days')
    UNION ALL
    SELECT tunnel_name, ts FROM tunnel_metrics_hourly
      WHERE direction = 'egress' AND ts >= strftime('%Y-%m-%dT00:00:00.000Z', 'now', '-3 days')
  ) GROUP BY tunnel_name, substr(ts, 1, 10);

INSERT OR IGNORE INTO tunnel_seen_days (tunnel_name, day, first_ts)
  SELECT tunnel_name, substr(ts, 1, 10), substr(ts, 1, 10) || 'T00:00:00Z'
  FROM tunnel_metrics_daily GROUP BY tunnel_name, substr(ts, 1, 10);
