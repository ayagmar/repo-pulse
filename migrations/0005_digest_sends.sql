-- One row per provider and digest, such as 'daily:2026-10-15'. A provider claims the
-- row before posting, so overlapping cron runs post a digest only once.
CREATE TABLE IF NOT EXISTS digest_sends (
  digest_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  sent_at TEXT,
  PRIMARY KEY (digest_id, provider_name)
);
