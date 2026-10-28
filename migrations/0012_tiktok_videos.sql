CREATE TABLE IF NOT EXISTS tiktok_video_links (
  item_id TEXT PRIMARY KEY REFERENCES items(id),
  exported_at TEXT,
  export_batch_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_tiktok_video_unexported ON tiktok_video_links(exported_at,item_id);
CREATE TABLE IF NOT EXISTS tiktok_video_batches (
  id TEXT PRIMARY KEY,
  item_ids_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','cancelled')),
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tiktok_video_pending ON tiktok_video_batches(status) WHERE status='pending';
