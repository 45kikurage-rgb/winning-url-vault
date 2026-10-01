PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS vault_campaigns (
  campaign_id TEXT PRIMARY KEY,
  campaign_name TEXT NOT NULL,
  lottery_start_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','closing','closed','correcting')),
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK(is_archived IN (0,1)),
  current_winner_count INTEGER,
  final_winner_count INTEGER,
  final_account_count INTEGER,
  last_refreshed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_campaigns_status ON vault_campaigns(is_archived,status,lottery_start_date,campaign_id);

CREATE TABLE IF NOT EXISTS ledger_products (
  product_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  redemption_place TEXT,
  product_spec TEXT,
  valid_until TEXT,
  identity_key TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK(is_archived IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(card_id) REFERENCES cards(id),
  UNIQUE(campaign_id,identity_key)
);
CREATE INDEX IF NOT EXISTS idx_ledger_products_campaign ON ledger_products(campaign_id,product_id);
CREATE INDEX IF NOT EXISTS idx_ledger_products_card ON ledger_products(card_id,campaign_id);

CREATE TABLE IF NOT EXISTS item_campaign_assignments (
  item_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES ledger_products(product_id)
);
CREATE INDEX IF NOT EXISTS idx_item_assignments_product ON item_campaign_assignments(product_id,item_id);
CREATE INDEX IF NOT EXISTS idx_item_assignments_campaign ON item_campaign_assignments(campaign_id,item_id);

CREATE TABLE IF NOT EXISTS ledger_sync_series (
  source_record_id TEXT PRIMARY KEY,
  current_revision INTEGER NOT NULL DEFAULT 0 CHECK(current_revision >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ledger_outbox (
  id TEXT PRIMARY KEY,
  source_record_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'POST' CHECK(method IN ('POST')),
  path TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at TEXT,
  last_error TEXT,
  ledger_result TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  UNIQUE(source_record_id,source_revision)
);
CREATE INDEX IF NOT EXISTS idx_ledger_outbox_due ON ledger_outbox(status,next_attempt_at,created_at);
