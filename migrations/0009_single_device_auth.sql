-- Non-destructive, single-browser login identity and signed challenge replay gate.
-- All existing items, cards, revenue and ARUNOMATIC send-only tokens are untouched.
CREATE TABLE IF NOT EXISTS vault_login_device (
  id INTEGER PRIMARY KEY CHECK(id=1),
  credential_id TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  pairing_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS vault_login_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_login_nonces_expiry ON vault_login_nonces(expires_at);
