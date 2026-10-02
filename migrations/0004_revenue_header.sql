-- Keep the JST daily revenue header query bounded to the selected receive date.
CREATE INDEX IF NOT EXISTS idx_items_received_status ON items(datetime(received_at),status,id);
