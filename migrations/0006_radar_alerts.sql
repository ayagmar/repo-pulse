-- One row per momentum alert, such as 'stars:owner/repo'. A check claims the row before
-- posting and records when the post went out, which starts the alert's cooldown.
CREATE TABLE IF NOT EXISTS radar_alerts (
  alert_id TEXT PRIMARY KEY,
  claimed_at TEXT NOT NULL,
  sent_at TEXT
);

-- The radar counts recent stars every ten minutes, then earlier stars for the few
-- repositories with enough recent ones.
CREATE INDEX IF NOT EXISTS idx_events_type_received_at
  ON events (event_type, received_at);
CREATE INDEX IF NOT EXISTS idx_events_repository_type_received_at
  ON events (repository, event_type, received_at);
