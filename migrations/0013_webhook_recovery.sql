CREATE TABLE webhook_recovery_scan (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  cursor TEXT,
  next_scan_at INTEGER NOT NULL
);

CREATE TABLE webhook_recovery_attempts (
  guid TEXT PRIMARY KEY NOT NULL,
  original_at TEXT,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_webhook_recovery_expiry ON webhook_recovery_attempts (expires_at);
