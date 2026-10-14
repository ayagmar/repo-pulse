-- When each momentum alert was last sent, such as 'stars:owner/repo'. An alert is
-- claimed here before it is posted, which also enforces its cooldown.
CREATE TABLE IF NOT EXISTS radar_alerts (
  alert_id TEXT PRIMARY KEY,
  alerted_at TEXT NOT NULL
);

-- The radar counts recent stars every ten minutes.
CREATE INDEX IF NOT EXISTS idx_events_type_received_at
  ON events (event_type, received_at);
