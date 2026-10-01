PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS campaign_products (
  product_id TEXT PRIMARY KEY NOT NULL,
  campaign_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK(is_archived IN (0,1)),
  source_revision INTEGER NOT NULL DEFAULT 1 CHECK(source_revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE RESTRICT,
  UNIQUE(campaign_id,card_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_products_campaign ON campaign_products(campaign_id,product_id);

CREATE TABLE IF NOT EXISTS campaign_product_items (
  item_id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES campaign_products(product_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_campaign_product_items_product ON campaign_product_items(product_id,item_id);

CREATE TABLE IF NOT EXISTS vault_campaign_sync_state (
  campaign_id TEXT PRIMARY KEY NOT NULL,
  totals_revision INTEGER NOT NULL DEFAULT 0 CHECK(totals_revision >= 0),
  lifecycle_revision INTEGER NOT NULL DEFAULT 0 CHECK(lifecycle_revision >= 0),
  outbox_sequence INTEGER NOT NULL DEFAULT 0 CHECK(outbox_sequence >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_sequence INTEGER NOT NULL CHECK(campaign_sequence >= 1),
  path TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK(source_revision >= 1),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','retry','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  available_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE(source_record_id,source_revision),
  UNIQUE(campaign_id,campaign_sequence)
);
CREATE INDEX IF NOT EXISTS idx_ledger_outbox_delivery ON ledger_outbox(status,available_at,created_at,campaign_sequence);
