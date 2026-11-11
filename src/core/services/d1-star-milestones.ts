import type { StarEvent } from '../models/repo-event.js';
import { REPO_EVENT_TYPES } from '../models/repo-event.js';
import { highestMilestone, RECENT_STARS_DAYS } from '../models/star-milestone.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from './d1-types.js';

/**
 * `idx_events_star_repository` (migration 0011) is a partial index on this expression
 * and `received_at` with this WHERE clause; a query must repeat both exactly for
 * SQLite to use it, and naming it with INDEXED BY fails if they drift apart.
 */
const STAR_REPOSITORY_ID = `json_extract(event_json, '$.repository.id')`;
const STAR_EVENTS_WHERE = `event_type IN ('star.created', 'star.deleted')`;

/** A delivery id seen before keeps what it was first accepted with. */
const NEW_DELIVERY = 'NOT EXISTS (SELECT 1 FROM events WHERE delivery_id = ?)';

interface StarMilestoneStatements {
  /** Run before the history insert, which they check for this delivery id. */
  beforeHistory: D1PreparedStatementLike[];
  /**
   * Run after the history insert, which they update. The ledger then copies the stored
   * event into the delivery row.
   */
  afterHistory: D1PreparedStatementLike[];
}

/**
 * The statements that record a star event's milestone, for the ledger's acceptance
 * batch, or null when the event has no valid repository id or star count.
 *
 * The first star event of a repository writes its baseline: the highest count seen,
 * this one or a recorded one, at or below which no milestone is celebrated. A star
 * added past the highest milestone yet assigned, and past the baseline, takes that
 * milestone, the highest it reaches, for this delivery; the milestones it jumps over
 * are passed with it. The event then stores the milestone with what it says: the
 * previous milestone and the net stars of the last seven days. All of it is in the
 * same batch as the event, so it commits with it or not at all, and none of it runs
 * for a delivery id already recorded.
 */
export function prepareStarMilestoneStatements(
  db: D1DatabaseLike,
  input: { deliveryId: string; event: StarEvent; acceptedAt: string }
): StarMilestoneStatements | null {
  const { deliveryId, event, acceptedAt } = input;
  const repositoryId = event.repository.id;
  const count = event.star.count;
  const valid =
    Number.isSafeInteger(repositoryId) &&
    repositoryId > 0 &&
    Number.isSafeInteger(count) &&
    count >= 0;
  if (!valid) {
    return null;
  }

  const baseline = db
    .prepare(
      `INSERT OR IGNORE INTO star_milestone_baselines (
         repository_id, seen_count, delivery_id, recorded_at
       )
       SELECT ?, MAX(?, COALESCE((
           SELECT MAX(json_extract(event_json, '$.star.count'))
           FROM events INDEXED BY idx_events_star_repository
           WHERE ${STAR_REPOSITORY_ID} = ? AND ${STAR_EVENTS_WHERE}
             AND json_type(event_json, '$.star.count') = 'integer'
         ), 0)), ?, ?
       WHERE ${NEW_DELIVERY}
         AND NOT EXISTS (
           SELECT 1 FROM star_milestone_baselines WHERE repository_id = ?
         )`
    )
    .bind(repositoryId, count, repositoryId, deliveryId, acceptedAt, deliveryId, repositoryId);

  const milestone = highestMilestone(count);
  if (event.type !== REPO_EVENT_TYPES.STAR_CREATED || milestone === null) {
    return { beforeHistory: [baseline], afterHistory: [] };
  }

  const claim = db
    .prepare(
      `INSERT OR IGNORE INTO star_milestones (repository_id, milestone, delivery_id, reached_at)
       SELECT ?, ?, ?, ?
       WHERE ${NEW_DELIVERY}
         AND EXISTS (
           SELECT 1 FROM star_milestone_baselines
           WHERE repository_id = ? AND seen_count < ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM star_milestones WHERE repository_id = ? AND milestone >= ?
         )`
    )
    .bind(
      repositoryId,
      milestone,
      deliveryId,
      acceptedAt,
      deliveryId,
      repositoryId,
      milestone,
      repositoryId,
      milestone
    );

  // `json()` keeps the subquery's object an object: through a subquery, SQLite would
  // otherwise store it as a string.
  const recentSince = new Date(
    Date.parse(acceptedAt) - RECENT_STARS_DAYS * 24 * 3_600_000
  ).toISOString();
  const snapshot = db
    .prepare(
      `UPDATE events
       SET event_json = json_set(event_json, '$.starMilestone', json_object(
         'milestone', ?,
         'reachedAt', ?,
         'previous', json((
           SELECT json_object('milestone', milestone, 'reachedAt', reached_at)
           FROM star_milestones
           WHERE repository_id = ? AND delivery_id <> ?
           ORDER BY milestone DESC
           LIMIT 1
         )),
         'recentStars', json_object('since', ?, 'net', (
           SELECT COALESCE(SUM(CASE event_type WHEN 'star.created' THEN 1 ELSE -1 END), 0)
           FROM events INDEXED BY idx_events_star_repository
           WHERE ${STAR_REPOSITORY_ID} = ? AND ${STAR_EVENTS_WHERE}
             AND received_at >= ? AND received_at <= ?
         ))
       ))
       WHERE delivery_id = ?
         AND json_type(event_json, '$.starMilestone') IS NULL
         AND EXISTS (SELECT 1 FROM star_milestones WHERE delivery_id = ?)`
    )
    .bind(
      milestone,
      acceptedAt,
      repositoryId,
      deliveryId,
      recentSince,
      repositoryId,
      recentSince,
      acceptedAt,
      deliveryId,
      deliveryId
    );

  return { beforeHistory: [baseline, claim], afterHistory: [snapshot] };
}
