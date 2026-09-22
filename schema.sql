CREATE TABLE IF NOT EXISTS product_master (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL DEFAULT 'url',
  raw_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  redeem_place TEXT NOT NULL DEFAULT '',
  specification TEXT NOT NULL DEFAULT '',
  image_key TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_product_match ON product_master(normalized_name,redeem_place,specification);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  expires_on TEXT NOT NULL DEFAULT '',
  price_label TEXT NOT NULL DEFAULT '',
  locked INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(product_id) REFERENCES product_master(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_card_exact ON cards(product_id,expires_on,price_label);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL UNIQUE,
  value_type TEXT NOT NULL,
  card_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  classified_at TEXT,
  FOREIGN KEY(card_id) REFERENCES cards(id)
);
CREATE INDEX IF NOT EXISTS idx_items_card ON items(card_id,status);

CREATE TABLE IF NOT EXISTS unresolved_items (
  item_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  pattern_key TEXT NOT NULL DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(item_id) REFERENCES items(id)
);
CREATE INDEX IF NOT EXISTS idx_unresolved_pattern ON unresolved_items(pattern_key);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  item_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);