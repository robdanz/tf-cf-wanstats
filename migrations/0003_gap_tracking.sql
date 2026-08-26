-- Gap tracking for the auto-repoll cron step. A row exists only while a
-- (tunnel_name, direction, ts) cell is unresolved: resolved cells are
-- deleted (the raw tunnel_metrics row is the record), confirmed_empty_at
-- rows are terminal and excluded from future discovery.
CREATE TABLE IF NOT EXISTS gap_tracking (
  tunnel_name        TEXT    NOT NULL,
  direction          TEXT    NOT NULL,   -- 'ingress' | 'egress'
  ts                 TEXT    NOT NULL,   -- raw ts format, 'YYYY-MM-DDTHH:MM:SSZ'
  attempts           INTEGER NOT NULL DEFAULT 0,
  first_detected     TEXT    NOT NULL,
  confirmed_empty_at TEXT,
  PRIMARY KEY (tunnel_name, direction, ts)
);

CREATE INDEX IF NOT EXISTS idx_gap_pending
  ON gap_tracking (confirmed_empty_at, attempts, first_detected);
