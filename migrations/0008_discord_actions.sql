-- Discord interactions already taken up, by Discord's interaction id. A replayed
-- request finds its row and does nothing.
CREATE TABLE IF NOT EXISTS discord_interactions (
  interaction_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

-- The latest outcome of each action taken from an alert's buttons, written after the
-- GitHub call. The alert's message is rebuilt from these rows.
CREATE TABLE IF NOT EXISTS discord_actions (
  delivery_id TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  PRIMARY KEY (delivery_id, action)
);
