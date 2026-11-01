-- The events the public routes may publish: the four published types, recorded as
-- public. `/public/activity` sums them per UTC day and reads their first day from
-- this index, so it reads only these rows instead of every event in the window.
-- Queries using it must repeat each term of this WHERE clause (PUBLIC_EVENTS_WHERE).
CREATE INDEX IF NOT EXISTS idx_events_public_received_at
  ON events (received_at)
  WHERE event_type IN (
      'release.published', 'star.created', 'push.default_branch', 'pull_request.merged'
    )
    AND json_type(event_json, '$.repository.private') = 'false';
