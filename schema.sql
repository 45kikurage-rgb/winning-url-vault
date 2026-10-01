PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS product_master (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL DEFAULT 'url',
  raw_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  redeem_place TEXT NOT NULL,
  specification TEXT NOT NULL DEFAULT '',
  required_conditions TEXT NOT NULL DEFAULT '{}',
  match_key TEXT NOT NULL UNIQUE,
  image_data_uri TEXT,
  confirmed INTEGER NOT NULL DEFAULT 1 CHECK (confirmed IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_product_exact ON product_master(normalized_name, specification, redeem_place, required_conditions, confirmed);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  expires_on TEXT NOT NULL DEFAULT '',
  locked INTEGER NOT NULL DEFAULT 1 CHECK (locked IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(product_id) REFERENCES product_master(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_card_exact ON cards(product_id, expires_on);

CREATE TABLE IF NOT EXISTS pending_confirmations (
  id TEXT PRIMARY KEY,
  match_key TEXT NOT NULL,
  expires_on TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'url',
  raw_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  redeem_place TEXT NOT NULL,
  specification TEXT NOT NULL DEFAULT '',
  required_conditions TEXT NOT NULL DEFAULT '{}',
  image_data_uri TEXT,
  analysis_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_exact ON pending_confirmations(match_key, expires_on);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  canonical_value TEXT NOT NULL UNIQUE,
  value_type TEXT NOT NULL,
  card_id TEXT,
  pending_id TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  analysis_json TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  analyzed_at TEXT,
  classified_at TEXT,
  FOREIGN KEY(card_id) REFERENCES cards(id),
  FOREIGN KEY(pending_id) REFERENCES pending_confirmations(id)
);
CREATE INDEX IF NOT EXISTS idx_items_card ON items(card_id, status, received_at, id);
CREATE INDEX IF NOT EXISTS idx_items_pending ON items(pending_id, status);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL UNIQUE,
  input_total INTEGER NOT NULL DEFAULT 0,
  input_duplicates INTEGER NOT NULL DEFAULT 0,
  existing_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'receiving',
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_created ON analysis_jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS analysis_job_items (
  job_id TEXT NOT NULL,
  item_id TEXT NOT NULL UNIQUE,
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(job_id,item_id),
  FOREIGN KEY(job_id) REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_job_items_state ON analysis_job_items(job_id,state,ordinal);

CREATE TABLE IF NOT EXISTS analysis_staging (
  item_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  batch_no INTEGER NOT NULL,
  result_json TEXT,
  error_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(job_id) REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_analysis_staging_job ON analysis_staging(job_id,batch_no,item_id);

CREATE TABLE IF NOT EXISTS unresolved_items (
  item_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  pattern_key TEXT NOT NULL DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(item_id) REFERENCES items(id)
);
CREATE INDEX IF NOT EXISTS idx_unresolved_pattern ON unresolved_items(pattern_key, updated_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  item_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_item ON audit_log(item_id, created_at);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  identifier_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_started TEXT NOT NULL,
  blocked_until TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Central ledger integration. product_master.id remains the Vault-internal
-- recognition master. ledger_products.product_id is issued only on campaign
-- assignment and is immutable within that campaign.
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
  output_method TEXT NOT NULL DEFAULT 'unset' CHECK(output_method IN ('unset','normal','cokeon','wallet','paypay','text_single')),
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
  exported_at TEXT,
  export_method TEXT,
  export_batch_id TEXT,
  FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES ledger_products(product_id)
);
CREATE INDEX IF NOT EXISTS idx_item_assignments_product ON item_campaign_assignments(product_id,item_id);
CREATE INDEX IF NOT EXISTS idx_item_assignments_campaign ON item_campaign_assignments(campaign_id,item_id);
CREATE INDEX IF NOT EXISTS idx_item_assignments_export ON item_campaign_assignments(product_id,exported_at,item_id);

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
CREATE UNIQUE INDEX IF NOT EXISTS idx_export_one_pending ON export_batches(status) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_export_batches_product ON export_batches(product_id,created_at DESC);

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
