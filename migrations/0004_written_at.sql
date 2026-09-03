-- written_at: worker clock at the moment a raw row was inserted or its
-- bit_rate changed (see the conditional upsert in d1.ts storeTunnelMetrics).
-- NULL on rows written before this migration. ADD COLUMN is metadata-only in
-- SQLite; the partial index is empty at creation, so this is instant at any
-- table size. Deliberately no backfill UPDATE.
ALTER TABLE tunnel_metrics ADD COLUMN written_at TEXT;

CREATE INDEX IF NOT EXISTS idx_tm_written_at
  ON tunnel_metrics (written_at)
  WHERE written_at IS NOT NULL;

-- /api/gaps queries gap_tracking by ts range; the PK leads with tunnel_name.
CREATE INDEX IF NOT EXISTS idx_gap_ts
  ON gap_tracking (ts);
