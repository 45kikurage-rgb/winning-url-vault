-- Preserve every existing record as the original ARUNOMATIC intake channel.
ALTER TABLE items ADD COLUMN intake_source TEXT NOT NULL DEFAULT 'arunomatic';
ALTER TABLE cards ADD COLUMN intake_source TEXT NOT NULL DEFAULT 'arunomatic';
ALTER TABLE pending_confirmations ADD COLUMN intake_source TEXT NOT NULL DEFAULT 'arunomatic';
DROP INDEX idx_card_exact;
CREATE UNIQUE INDEX idx_card_exact ON cards(product_id, expires_on, intake_source);
DROP INDEX idx_pending_exact;
CREATE UNIQUE INDEX idx_pending_exact ON pending_confirmations(match_key, expires_on, intake_source);
CREATE INDEX idx_items_intake_status ON items(intake_source,status,received_at,id);
CREATE INDEX idx_cards_intake ON cards(intake_source,id);
CREATE INDEX idx_pending_intake ON pending_confirmations(intake_source,id);
