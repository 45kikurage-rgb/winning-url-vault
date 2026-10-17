-- Isolated provisional inbox: existing records and current normal receive remain unchanged.
CREATE TABLE IF NOT EXISTS provisional_mode (
  id INTEGER PRIMARY KEY CHECK(id=1),
  mode TEXT NOT NULL DEFAULT 'normal' CHECK(mode IN ('normal','A','B','C','D','E')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO provisional_mode(id,mode) VALUES (1,'normal');

CREATE TABLE IF NOT EXISTS provisional_buckets (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL CHECK(slot IN ('A','B','C','D','E')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','published')),
  published_card_id TEXT,
  draft_unit_price INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  FOREIGN KEY(published_card_id) REFERENCES cards(id)
);
CREATE INDEX IF NOT EXISTS idx_provisional_buckets_slot ON provisional_buckets(slot,status);

CREATE TABLE IF NOT EXISTS provisional_slots (
  slot TEXT PRIMARY KEY CHECK(slot IN ('A','B','C','D','E')),
  active_bucket_id TEXT NOT NULL REFERENCES provisional_buckets(id)
);
INSERT OR IGNORE INTO provisional_buckets(id,slot) VALUES
 ('initial-A','A'),('initial-B','B'),('initial-C','C'),('initial-D','D'),('initial-E','E');
INSERT OR IGNORE INTO provisional_slots(slot,active_bucket_id) VALUES
 ('A','initial-A'),('B','initial-B'),('C','initial-C'),('D','initial-D'),('E','initial-E');

CREATE TABLE IF NOT EXISTS provisional_receipts (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  bucket_id TEXT NOT NULL REFERENCES provisional_buckets(id),
  raw_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'receiving' CHECK(status IN ('receiving','stored')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_key,client_request_id)
);
CREATE INDEX IF NOT EXISTS idx_provisional_receipts_bucket ON provisional_receipts(bucket_id,status);

CREATE TABLE IF NOT EXISTS provisional_entries (
  item_id TEXT PRIMARY KEY REFERENCES items(id),
  receipt_id TEXT NOT NULL REFERENCES provisional_receipts(id),
  bucket_id TEXT NOT NULL REFERENCES provisional_buckets(id),
  source_label TEXT NOT NULL DEFAULT '',
  parsed_expiry TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_provisional_entries_bucket ON provisional_entries(bucket_id,item_id);
