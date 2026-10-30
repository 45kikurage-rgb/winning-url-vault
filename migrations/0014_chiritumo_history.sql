-- Hiding transfer history never deletes the stored coupon or intake source.
CREATE TABLE IF NOT EXISTS chiritumo_history_hidden (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  hidden_at TEXT NOT NULL
);
