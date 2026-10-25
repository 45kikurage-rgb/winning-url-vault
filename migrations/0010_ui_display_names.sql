-- UI aliases only. No existing rows, identities, prices, or revenue are changed.
CREATE TABLE IF NOT EXISTS ui_display_names (
  scope TEXT NOT NULL CHECK(scope IN ('sorting','winning')),
  target_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope,target_id)
);
