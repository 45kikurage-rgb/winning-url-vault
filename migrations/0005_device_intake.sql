CREATE TABLE IF NOT EXISTS sending_tokens (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sending_tokens_device ON sending_tokens(device_id,revoked_at);
CREATE TABLE IF NOT EXISTS intake_receipts (
  job_id TEXT PRIMARY KEY REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  owner_key TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'receiving',
  dispatched INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(owner_key,client_request_id)
);
CREATE INDEX IF NOT EXISTS idx_intake_recovery ON intake_receipts(dispatched,created_at);
CREATE TABLE IF NOT EXISTS sending_rate_limits (
  device_id TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
