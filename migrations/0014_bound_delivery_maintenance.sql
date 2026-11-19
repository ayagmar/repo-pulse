CREATE INDEX idx_deliveries_exhausted_pending ON deliveries (delivery_id)
  WHERE status = 'pending' AND processing_attempts >= max_attempts;

CREATE INDEX idx_deliveries_attempted_pending ON deliveries (delivery_id)
  WHERE status = 'pending' AND processing_attempts > 0 AND processing_attempts < max_attempts;

CREATE INDEX idx_deliveries_due ON deliveries (next_attempt_at, accepted_at)
  WHERE status = 'pending' AND next_attempt_at IS NOT NULL AND processing_attempts < max_attempts;

CREATE INDEX idx_provider_attempts_receipts
  ON provider_attempts (delivery_id, provider_name, success, delivery_attempt);

CREATE TABLE delivery_maintenance (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  started_after TEXT NOT NULL,
  scanned_through TEXT
);

INSERT INTO delivery_maintenance VALUES (1, '', NULL);
