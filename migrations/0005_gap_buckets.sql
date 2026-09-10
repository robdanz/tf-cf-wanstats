-- Per-cell gap tracking scaled with tunnel count and treated idle tunnels as
-- gaps (1.4M rows at 577 tunnels). Gaps are whole-bucket events (a failed
-- 5-min GraphQL slice affects every tunnel), so track them per bucket. The
-- old rows are unrecoverable noise; any real pending bucket is rediscovered
-- by the ledger on its next pass. DROP TABLE is O(1) regardless of size.
DROP TABLE IF EXISTS gap_tracking;

CREATE TABLE IF NOT EXISTS gap_buckets (
  ts                 TEXT PRIMARY KEY,   -- raw ts format 'YYYY-MM-DDTHH:MM:SSZ', 5-min aligned
  attempts           INTEGER NOT NULL DEFAULT 0,
  first_detected     TEXT NOT NULL,
  confirmed_empty_at TEXT
);

-- Pending scan: confirmed_empty_at IS NULL AND attempts < 3 ORDER BY first_detected.
CREATE INDEX IF NOT EXISTS idx_gap_buckets_pending
  ON gap_buckets (confirmed_empty_at, attempts, first_detected);
