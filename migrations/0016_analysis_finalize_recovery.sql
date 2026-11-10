ALTER TABLE analysis_jobs ADD COLUMN finalize_owner TEXT;
ALTER TABLE analysis_jobs ADD COLUMN finalize_until TEXT;
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_recovery ON analysis_jobs(status,updated_at);
-- The guard is inserted and removed inside one D1 batch. A stale owner fails
-- the constraint and no business or checkpoint writes in that batch commit.
CREATE TABLE IF NOT EXISTS analysis_finalize_guard (
  job_id TEXT PRIMARY KEY,
  current_owner INTEGER NOT NULL CHECK(current_owner=1)
);
