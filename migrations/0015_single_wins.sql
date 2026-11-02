CREATE TABLE IF NOT EXISTS vault_single_wins (
  request_id TEXT PRIMARY KEY NOT NULL,
  snapshot_key TEXT NOT NULL,
  preview_token TEXT NOT NULL,
  card_id TEXT NOT NULL,
  intake_source TEXT NOT NULL CHECK(intake_source IN ('arunomatic','chiritumo')),
  item_ids_json TEXT NOT NULL CHECK(json_valid(item_ids_json)),
  product_json TEXT NOT NULL CHECK(json_valid(product_json)),
  registration_date TEXT NOT NULL,
  campaign_id TEXT,
  product_id TEXT NOT NULL UNIQUE,
  assigned_count INTEGER NOT NULL DEFAULT 0,
  checked INTEGER NOT NULL DEFAULT 1 CHECK(checked=1),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  invalidated_at TEXT,
  FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_single_wins_card ON vault_single_wins(card_id,intake_source,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_wins_snapshot ON vault_single_wins(snapshot_key) WHERE invalidated_at IS NULL;
