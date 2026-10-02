-- Revenue starts at 2026-10 JST. Existing extraction data is preserved.
PRAGMA foreign_keys = ON;

ALTER TABLE ledger_products ADD COLUMN unit_price INTEGER
  CHECK(unit_price IS NULL OR (typeof(unit_price)='integer' AND unit_price BETWEEN 0 AND 9007199254740991));

CREATE TABLE product_monthly_revenue (
  month TEXT NOT NULL CHECK(month >= '2026-10' AND month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  campaign_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  winner_count INTEGER NOT NULL CHECK(winner_count BETWEEN 0 AND 9007199254740991),
  unit_price INTEGER CHECK(unit_price IS NULL OR unit_price BETWEEN 0 AND 9007199254740991),
  amount INTEGER CHECK((unit_price IS NULL AND amount IS NULL) OR
    (unit_price IS NOT NULL AND typeof(amount)='integer' AND amount BETWEEN 0 AND 9007199254740991 AND amount=winner_count*unit_price)),
  source_revision INTEGER NOT NULL DEFAULT 0 CHECK(source_revision BETWEEN 0 AND 9007199254740991),
  sync_status TEXT NOT NULL DEFAULT 'unset' CHECK(sync_status IN ('unset','pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at TEXT,
  last_error TEXT,
  finalized_at TEXT,
  updated_at TEXT NOT NULL,
  last_synced_at TEXT,
  PRIMARY KEY(month,product_id),
  FOREIGN KEY(product_id) REFERENCES ledger_products(product_id)
);
CREATE INDEX idx_product_month_revenue_due ON product_monthly_revenue(sync_status,next_attempt_at,updated_at);
CREATE INDEX idx_product_month_revenue_campaign ON product_monthly_revenue(campaign_id,month,product_id);

-- One-time projection of existing October-and-later assignments. Prices remain explicitly unset.
INSERT OR IGNORE INTO product_monthly_revenue
  (month,campaign_id,product_id,winner_count,unit_price,amount,source_revision,sync_status,updated_at)
SELECT strftime('%Y-%m',datetime(i.received_at,'+9 hours')),a.campaign_id,a.product_id,COUNT(*),NULL,NULL,0,'unset',CURRENT_TIMESTAMP
FROM item_campaign_assignments a JOIN items i ON i.id=a.item_id
WHERE i.status='active' AND datetime(i.received_at)>=datetime('2026-09-30T15:00:00Z')
GROUP BY strftime('%Y-%m',datetime(i.received_at,'+9 hours')),a.campaign_id,a.product_id;
