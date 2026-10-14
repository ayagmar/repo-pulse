-- Every accepted event, kept after its delivery row is pruned.
CREATE TABLE IF NOT EXISTS events (
  delivery_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  repository TEXT NOT NULL,
  received_at TEXT NOT NULL,
  event_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_received_at
  ON events (received_at DESC, delivery_id DESC);

-- Keep events accepted before this table existed. They were stored without
-- repository visibility, so they are recorded as private.
INSERT OR IGNORE INTO events (delivery_id, event_type, repository, received_at, event_json)
SELECT
  delivery_id,
  normalized_event_type,
  repository,
  accepted_at,
  json_insert(normalized_event_json, '$.repository.private', json('true'))
FROM deliveries;
