ALTER TABLE ledger_products ADD COLUMN show_in_permanent INTEGER NOT NULL DEFAULT 0 CHECK(show_in_permanent IN (0,1));
