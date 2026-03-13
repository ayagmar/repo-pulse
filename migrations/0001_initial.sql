CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  source_event_type TEXT NOT NULL,
  normalized_event_type TEXT NOT NULL,
  repository TEXT NOT NULL,
  matched_pattern TEXT,
  normalized_event_json TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  status TEXT NOT NULL,
  next_attempt_at TEXT,
  processing_attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  processing_started_at TEXT,
  processing_finished_at TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  last_failure_classification TEXT
);

CREATE TABLE IF NOT EXISTS provider_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL,
  delivery_attempt INTEGER NOT NULL,
  provider_name TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  success INTEGER NOT NULL,
  error_message TEXT,
  FOREIGN KEY (delivery_id) REFERENCES deliveries (delivery_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deliveries_status_next_attempt_at
  ON deliveries (status, next_attempt_at, accepted_at);

CREATE INDEX IF NOT EXISTS idx_deliveries_status_lease_expires_at
  ON deliveries (status, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_provider_attempts_delivery_id
  ON provider_attempts (delivery_id, id DESC);
