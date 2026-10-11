-- Match the admin list's newest-first order without sorting the whole ledger.
CREATE INDEX IF NOT EXISTS idx_deliveries_accepted_at
  ON deliveries (accepted_at DESC, delivery_id DESC);

CREATE INDEX IF NOT EXISTS idx_deliveries_status_accepted_at
  ON deliveries (status, accepted_at DESC, delivery_id DESC);
