-- One row per provider that accepted a day's digest, so it is sent only once.
CREATE TABLE IF NOT EXISTS digest_sends (
  digest_date TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (digest_date, provider_name)
);
