-- Where star milestones start for each repository, by GitHub repository id: written with
-- the first star event accepted by a release that celebrates milestones, from the
-- highest star count seen so far. Every milestone at or below `seen_count` is passed
-- without a celebration. Applying this migration writes nothing, so the previous
-- release leaves it empty.
CREATE TABLE IF NOT EXISTS star_milestone_baselines (
  repository_id INTEGER PRIMARY KEY,
  seen_count INTEGER NOT NULL,
  delivery_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

-- Each celebrated milestone, assigned to the one accepted delivery that crossed it. A
-- delivery that jumps over several gets only the highest: the lower ones are passed.
CREATE TABLE IF NOT EXISTS star_milestones (
  repository_id INTEGER NOT NULL,
  milestone INTEGER NOT NULL,
  delivery_id TEXT NOT NULL UNIQUE,
  reached_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, milestone)
);

-- Star events by repository id and receipt time, for the highest count seen before the
-- baseline and the stars of the last seven days. Queries using it must repeat the
-- expression and this WHERE clause exactly (STAR_REPOSITORY_ID and STAR_EVENTS_WHERE).
CREATE INDEX IF NOT EXISTS idx_events_star_repository
  ON events (json_extract(event_json, '$.repository.id'), received_at)
  WHERE event_type IN ('star.created', 'star.deleted');
