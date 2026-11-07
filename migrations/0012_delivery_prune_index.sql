-- Deliveries that have finished, by status and finish time. The retention prune runs every
-- cron minute; with this index it reads only the rows past retention instead of every
-- succeeded row. Queries using it must repeat `processing_finished_at IS NOT NULL`.
CREATE INDEX IF NOT EXISTS idx_deliveries_status_processing_finished_at
  ON deliveries (status, processing_finished_at)
  WHERE processing_finished_at IS NOT NULL;
