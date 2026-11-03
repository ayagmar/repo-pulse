-- When comments and reviews started being recorded: one row, written with the first
-- comment or review accepted by a release that records them, never moved afterwards.
-- Applying this migration writes nothing, so the previous release leaves it empty.
CREATE TABLE IF NOT EXISTS feature_activations (
  feature TEXT PRIMARY KEY,
  activated_at TEXT NOT NULL,
  delivery_id TEXT NOT NULL
);

-- Every event of one issue or pull request, by repository id and number, so the
-- digest reads a thread's whole history, however old, without scanning `events`.
-- Queries using it must repeat both expressions and this WHERE clause exactly
-- (THREAD_REPOSITORY_ID, THREAD_NUMBER and THREAD_EVENTS_WHERE).
CREATE INDEX IF NOT EXISTS idx_events_thread
  ON events (
    json_extract(event_json, '$.repository.id'),
    COALESCE(
    json_extract(event_json, '$.thread.number'),
    json_extract(event_json, '$.issue.number'),
    json_extract(event_json, '$.pullRequest.number')
  )
  )
  WHERE event_type IN (
    'issue.opened', 'issue.closed', 'issue.reopened',
    'pull_request.opened', 'pull_request.closed', 'pull_request.merged',
    'pull_request.reopened', 'pull_request.ready_for_review',
    'pull_request.converted_to_draft', 'comment.created', 'review.submitted'
  );
