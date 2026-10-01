PRAGMA foreign_keys = ON;

ALTER TABLE ledger_products ADD COLUMN output_method TEXT NOT NULL DEFAULT 'unset'
  CHECK(output_method IN ('unset','normal','cokeon','wallet','paypay','text_single'));

ALTER TABLE item_campaign_assignments ADD COLUMN exported_at TEXT;
ALTER TABLE item_campaign_assignments ADD COLUMN export_method TEXT;
ALTER TABLE item_campaign_assignments ADD COLUMN export_batch_id TEXT;

CREATE INDEX IF NOT EXISTS idx_item_assignments_export
  ON item_campaign_assignments(product_id,exported_at,item_id);

CREATE TABLE IF NOT EXISTS export_batches (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  item_ids_json TEXT NOT NULL CHECK(json_valid(item_ids_json)),
  copy_order TEXT NOT NULL DEFAULT 'received' CHECK(copy_order IN ('received','asc')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','cancelled')),
  item_count INTEGER NOT NULL DEFAULT 0 CHECK(item_count >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  cancelled_at TEXT,
  FOREIGN KEY(product_id) REFERENCES ledger_products(product_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_export_one_pending
  ON export_batches(status) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_export_batches_product
  ON export_batches(product_id,created_at DESC);
