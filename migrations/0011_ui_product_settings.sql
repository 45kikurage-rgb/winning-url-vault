-- Reversible list organization only. No business lifecycle or existing rows change.
CREATE TABLE IF NOT EXISTS ui_product_settings (
  product_id TEXT PRIMARY KEY,
  manual_finished INTEGER NOT NULL DEFAULT 0 CHECK(manual_finished IN (0,1)),
  updated_at TEXT NOT NULL,
  FOREIGN KEY(product_id) REFERENCES ledger_products(product_id)
);
