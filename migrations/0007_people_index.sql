-- Who sent an event, across all repositories: alerts count a sender's earlier events,
-- and the weekly digest reads when each active person was first seen.
CREATE INDEX IF NOT EXISTS idx_events_sender_received_at
  ON events (json_extract(event_json, '$.sender.id'), received_at);
