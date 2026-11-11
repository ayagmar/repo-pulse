import type { PublicActivityMaterial } from '../models/public-activity.js';
import type { PublicFeedMaterial } from '../models/public-feed.js';
import type { RepoEvent } from '../models/repo-event.js';
import { deserializeRepoEvent, serializeRepoEvent } from '../models/repo-event.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from './d1-types.js';
import { SQL_IS_PUBLISHABLE } from './public-event-rules.js';

export interface EventHistoryEntry {
  deliveryId: string;
  receivedAt: Date;
  event: RepoEvent;
}

interface EventHistoryRow {
  deliveryId: string;
  receivedAt: string;
  eventJson: string;
}

/**
 * Prepare the history insert for an accepted delivery. The ledger batches it after the
 * delivery insert, which runs only for a delivery id not yet in `events`, so a delivery
 * id seen before keeps its first event and is not queued again. Both are in one batch, so
 * an event is never queued without being recorded. When this insert adds `senderHistory`
 * or a milestone, the ledger then copies the stored event into the delivery row.
 *
 * With `rememberSenderId`, the stored event gets `senderHistory`: what was recorded
 * from that sender before. The same statement counts and inserts, so two deliveries
 * from one sender racing each other are counted in the order they were inserted.
 */
export function prepareEventHistoryInsert(
  db: D1DatabaseLike,
  input: {
    deliveryId: string;
    repository: string;
    event: RepoEvent;
    receivedAt: string;
    rememberSenderId?: number;
  }
): D1PreparedStatementLike {
  if (input.rememberSenderId !== undefined) {
    return db
      .prepare(
        `INSERT OR IGNORE INTO events (
           delivery_id,
           event_type,
           repository,
           received_at,
           event_json
         )
         SELECT ?, ?, ?, ?, json_set(?, '$.senderHistory', json_object(
           'firstSeenAt', MIN(received_at),
           'priorEvents', COUNT(*),
           'priorRepositories', COUNT(DISTINCT repository),
           'priorInRepository', COALESCE(SUM(repository = ?), 0)
         ))
         FROM events
         WHERE json_extract(event_json, '$.sender.id') = ?`
      )
      .bind(
        input.deliveryId,
        input.event.type,
        input.repository,
        input.receivedAt,
        serializeRepoEvent(input.event),
        input.repository,
        input.rememberSenderId
      );
  }

  return db
    .prepare(
      `INSERT OR IGNORE INTO events (
         delivery_id,
         event_type,
         repository,
         received_at,
         event_json
       ) VALUES (?, ?, ?, ?, ?)`
    )
    .bind(
      input.deliveryId,
      input.event.type,
      input.repository,
      input.receivedAt,
      serializeRepoEvent(input.event)
    );
}

/**
 * The events the public routes may publish: the four published types, recorded as
 * public. Only a JSON `false` in `$.repository.private` counts as recorded public:
 * true, a missing flag (events from before visibility was stored) or any other value
 * does not. `idx_events_public_received_at` (migration 0009) has this WHERE clause,
 * and SQLite uses the index only for a query that repeats each of its terms; a query
 * naming it with INDEXED BY fails if they drift apart.
 */
const PUBLIC_EVENTS_WHERE = `event_type IN (
    'release.published', 'star.created', 'push.default_branch', 'pull_request.merged'
  )
  AND json_type(event_json, '$.repository.private') = 'false'`;

/** Of those, the ones the feed would publish, by the feed's own rules. */
const PUBLIC_ACTIVITY_WHERE = `${PUBLIC_EVENTS_WHERE}
  AND ${SQL_IS_PUBLISHABLE}`;

/**
 * Every event type about one issue or pull request. `idx_events_thread` (migration
 * 0010) is a partial index with this WHERE clause on the repository id and
 * `THREAD_NUMBER`; a query must repeat both expressions and this term exactly for
 * SQLite to use it, and naming it with INDEXED BY fails if they drift apart.
 */
const THREAD_EVENTS_WHERE = `event_type IN (
    'issue.opened', 'issue.closed', 'issue.reopened',
    'pull_request.opened', 'pull_request.closed', 'pull_request.merged',
    'pull_request.reopened', 'pull_request.ready_for_review',
    'pull_request.converted_to_draft', 'comment.created', 'review.submitted'
  )`;
const THREAD_REPOSITORY_ID = `json_extract(event_json, '$.repository.id')`;
const THREAD_NUMBER = `COALESCE(
    json_extract(event_json, '$.thread.number'),
    json_extract(event_json, '$.issue.number'),
    json_extract(event_json, '$.pullRequest.number')
  )`;

/** Event types that the digest's activity summary leaves out: they feed the waiting list. */
const CONVERSATION_EVENT_TYPES = `(
    'comment.created', 'review.submitted',
    'pull_request.ready_for_review', 'pull_request.converted_to_draft'
  )`;

/** The comment and review feature's activation record in `feature_activations`. */
export const THREAD_ACTIVATION = 'thread_replies';

/** The fields the waiting list and response times need from one thread event. */
export interface ThreadEventRow {
  deliveryId: string;
  eventType: RepoEvent['type'];
  receivedAt: string;
  occurredAt: string | null;
  repositoryId: number;
  /** The repository's name when the event was recorded. */
  repository: string;
  repositoryOwner: string | null;
  number: number;
  kind: 'issue' | 'pull_request';
  title: string | null;
  url: string | null;
  state: 'open' | 'closed' | null;
  /** 1 or 0 when the event says whether the pull request is a draft, else null. */
  draft: number | null;
  /** The issue's or pull request's creation time on GitHub, when recorded. */
  createdAt: string | null;
  senderId: number | null;
  senderLogin: string | null;
  reviewState: string | null;
  /** 1 when the comment or review has a body. */
  hasBody: number;
  /**
   * How many events the thread has in all, returned or not, or null when it has more
   * than the read's per-thread limit.
   */
  threadEvents: number | null;
}

export interface ThreadActivityMaterial {
  /** When comments and reviews started being recorded, or null before the first one. */
  activatedAt: string | null;
  rows: ThreadEventRow[];
}

/** The fields a digest needs from one recorded event. */
export interface EventActivity {
  eventType: RepoEvent['type'];
  repository: string;
  repositoryUrl: string;
  commitCount: number | null;
  releaseTagName: string | null;
  releaseUrl: string | null;
  pullRequestNumber: number | null;
  pullRequestTitle: string | null;
  pullRequestUrl: string | null;
  /** Who opened the pull request; null on events stored before it was recorded. */
  pullRequestAuthor: string | null;
  /** Null when the event has no numeric sender id. */
  senderId: number | null;
  senderLogin: string | null;
  senderUrl: string | null;
  repositoryOwner: string | null;
}

/** One `star.created` event, with the running total it brought the repository to. */
export interface RecentStar {
  login: string;
  repositoryUrl: string;
  starCount: number;
}

export class D1EventHistory {
  constructor(private readonly db: D1DatabaseLike) {}

  /** Events received in [start, end), oldest first. Reads only the fields a digest needs. */
  async listActivityBetween(start: Date, end: Date): Promise<EventActivity[]> {
    const rows = await this.db
      .prepare(
        `SELECT
           event_type AS eventType,
           repository,
           json_extract(event_json, '$.repository.url') AS repositoryUrl,
           json_array_length(event_json, '$.push.commits') AS commitCount,
           json_extract(event_json, '$.release.tagName') AS releaseTagName,
           json_extract(event_json, '$.release.url') AS releaseUrl,
           json_extract(event_json, '$.pullRequest.number') AS pullRequestNumber,
           json_extract(event_json, '$.pullRequest.title') AS pullRequestTitle,
           json_extract(event_json, '$.pullRequest.url') AS pullRequestUrl,
           json_extract(event_json, '$.pullRequest.author') AS pullRequestAuthor,
           CASE WHEN json_type(event_json, '$.sender.id') = 'integer'
             THEN json_extract(event_json, '$.sender.id') END AS senderId,
           json_extract(event_json, '$.sender.login') AS senderLogin,
           json_extract(event_json, '$.sender.url') AS senderUrl,
           json_extract(event_json, '$.repository.owner') AS repositoryOwner
         FROM events
         WHERE received_at >= ? AND received_at < ?
           AND event_type NOT IN ${CONVERSATION_EVENT_TYPES}
         ORDER BY received_at ASC, delivery_id ASC`
      )
      .bind(start.toISOString(), end.toISOString())
      .all<EventActivity>();

    return rows.results;
  }

  /**
   * The stored events of the `threadLimit` threads most recently active since `since`,
   * oldest first per thread, and the activation instant, if any. One query: candidates
   * through the type and time index, then each one's events, whatever their age, through
   * the thread index, reading at most `threadEventLimit + 1` of them per thread, and
   * returning at most `rowLimit` rows. Each row carries how many events its thread has,
   * or null when it has more than `threadEventLimit`, so a thread that is too long, or
   * cut by `rowLimit`, can be told apart and left out. What it costs in D1 rows read is
   * bounded by these limits, not by the history.
   */
  async readThreadActivity(
    since: Date,
    limits: { threads: number; eventsPerThread: number; rows: number }
  ): Promise<ThreadActivityMaterial> {
    const rows = await this.db
      .prepare(
        `WITH activation AS (
           SELECT activated_at FROM feature_activations WHERE feature = ?
         ),
         candidates AS (
           SELECT
             ${THREAD_REPOSITORY_ID} AS repositoryId,
             ${THREAD_NUMBER} AS threadNumber,
             MAX(received_at) AS lastReceivedAt
           FROM events INDEXED BY idx_events_type_received_at
           WHERE ${THREAD_EVENTS_WHERE}
             AND received_at >= ?
           GROUP BY repositoryId, threadNumber
           ORDER BY lastReceivedAt DESC, repositoryId ASC, threadNumber ASC
           LIMIT ?
         ),
         thread_events AS (
           SELECT
             candidates.lastReceivedAt,
             candidates.repositoryId,
             candidates.threadNumber,
             events.delivery_id AS deliveryId,
             events.event_type AS eventType,
             events.received_at AS receivedAt,
             events.event_json AS eventJson
           FROM candidates
           JOIN events ON events.rowid IN (
             SELECT rowid
             FROM events INDEXED BY idx_events_thread
             WHERE ${THREAD_REPOSITORY_ID} = candidates.repositoryId
               AND ${THREAD_NUMBER} = candidates.threadNumber
               AND ${THREAD_EVENTS_WHERE}
             LIMIT ?
           )
         )
         SELECT
           deliveryId,
           eventType,
           receivedAt,
           CASE WHEN json_type(eventJson, '$.occurredAt') = 'text'
             THEN json_extract(eventJson, '$.occurredAt') END AS occurredAt,
           repositoryId,
           json_extract(eventJson, '$.repository.fullName') AS repository,
           json_extract(eventJson, '$.repository.owner') AS repositoryOwner,
           threadNumber AS number,
           CASE
             WHEN eventType LIKE 'issue.%' THEN 'issue'
             WHEN eventType LIKE 'pull_request.%' OR eventType = 'review.submitted'
               THEN 'pull_request'
             ELSE json_extract(eventJson, '$.thread.kind')
           END AS kind,
           COALESCE(
             json_extract(eventJson, '$.thread.title'),
             json_extract(eventJson, '$.issue.title'),
             json_extract(eventJson, '$.pullRequest.title')
           ) AS title,
           COALESCE(
             json_extract(eventJson, '$.thread.url'),
             json_extract(eventJson, '$.issue.url'),
             json_extract(eventJson, '$.pullRequest.url')
           ) AS url,
           COALESCE(
             json_extract(eventJson, '$.thread.state'),
             json_extract(eventJson, '$.issue.state'),
             json_extract(eventJson, '$.pullRequest.state')
           ) AS state,
           CASE COALESCE(
               json_type(eventJson, '$.thread.draft'),
               json_type(eventJson, '$.pullRequest.draft')
             )
             WHEN 'true' THEN 1 WHEN 'false' THEN 0
           END AS draft,
           COALESCE(
             json_extract(eventJson, '$.thread.createdAt'),
             json_extract(eventJson, '$.issue.createdAt'),
             json_extract(eventJson, '$.pullRequest.createdAt')
           ) AS createdAt,
           CASE WHEN json_type(eventJson, '$.sender.id') = 'integer'
             THEN json_extract(eventJson, '$.sender.id') END AS senderId,
           json_extract(eventJson, '$.sender.login') AS senderLogin,
           json_extract(eventJson, '$.review.state') AS reviewState,
           (json_type(eventJson, '$.comment.body') = 'text'
             OR json_type(eventJson, '$.review.body') = 'text') AS hasBody,
           CASE WHEN COUNT(*) OVER (PARTITION BY repositoryId, threadNumber) <= ?
             THEN COUNT(*) OVER (PARTITION BY repositoryId, threadNumber) END AS threadEvents,
           (SELECT activated_at FROM activation) AS activatedAt
         FROM thread_events
         ORDER BY lastReceivedAt DESC, repositoryId ASC, threadNumber ASC,
           receivedAt ASC, deliveryId ASC
         LIMIT ?`
      )
      .bind(
        THREAD_ACTIVATION,
        since.toISOString(),
        limits.threads,
        limits.eventsPerThread + 1,
        limits.eventsPerThread,
        limits.rows
      )
      .all<ThreadEventRow & { activatedAt: string }>();

    return {
      activatedAt: rows.results[0]?.activatedAt ?? null,
      rows: rows.results,
    };
  }

  /** When each sender's earliest recorded event was received, by sender id. */
  async readFirstSeen(senderIds: readonly number[]): Promise<Map<number, Date>> {
    if (senderIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .prepare(
        `SELECT
           json_extract(event_json, '$.sender.id') AS senderId,
           MIN(received_at) AS firstSeenAt
         FROM events
         WHERE json_extract(event_json, '$.sender.id') IN (SELECT value FROM json_each(?))
         GROUP BY json_extract(event_json, '$.sender.id')`
      )
      .bind(JSON.stringify(senderIds))
      .all<{ senderId: number; firstSeenAt: string }>();

    return new Map(rows.results.map((row) => [row.senderId, new Date(row.firstSeenAt)]));
  }

  /** Repositories with events received since `since`, most recently active first. */
  async listActiveRepositories(since: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .prepare(
        `SELECT repository
         FROM events
         WHERE received_at >= ?
         GROUP BY repository
         ORDER BY MAX(received_at) DESC
         LIMIT ?`
      )
      .bind(since.toISOString(), limit)
      .all<{ repository: string }>();

    return rows.results.map((row) => row.repository);
  }

  /** A repository's `star.created` events received since `since`, newest first. */
  async listRecentStars(repository: string, since: Date, limit: number): Promise<RecentStar[]> {
    const rows = await this.db
      .prepare(
        `SELECT
           json_extract(event_json, '$.sender.login') AS login,
           json_extract(event_json, '$.repository.url') AS repositoryUrl,
           json_extract(event_json, '$.star.count') AS starCount
         FROM events
         WHERE repository = ? AND event_type = 'star.created' AND received_at >= ?
         ORDER BY received_at DESC, delivery_id DESC
         LIMIT ?`
      )
      .bind(repository, since.toISOString(), limit)
      .all<RecentStar>();

    return rows.results;
  }

  /**
   * What the public feed is built from, before any visibility check: the newest
   * `limit` events of the published types received since `since`, and each
   * repository's star count at the end of every UTC day since then that had a
   * star change. Only events recorded as public are read, and only the fields the
   * feed publishes.
   */
  async readPublicFeedMaterial(limit: number, since: Date): Promise<PublicFeedMaterial> {
    // Each field is read only when stored with its JSON type, because SQLite
    // would turn `true` into 1, a non-array into a length of 0, and an object into
    // its JSON text, nested fields included.
    // The events query walks the time index newest first and stops after `limit`
    // matches. The planner would otherwise pick the type index and sort every match;
    // on a public route, D1 rows read must not grow with the history.
    const [events, starDays] = await Promise.all([
      this.db
        .prepare(
          `SELECT
             event_type AS type,
             repository,
             received_at AS at,
             CASE WHEN json_type(event_json, '$.release.tagName') = 'text'
               THEN json_extract(event_json, '$.release.tagName') END AS releaseTag,
             CASE WHEN json_type(event_json, '$.release.url') = 'text'
               THEN json_extract(event_json, '$.release.url') END AS releaseUrl,
             CASE WHEN json_type(event_json, '$.star.count') = 'integer'
               THEN json_extract(event_json, '$.star.count') END AS starCount,
             CASE WHEN json_type(event_json, '$.push.compareUrl') = 'text'
               THEN json_extract(event_json, '$.push.compareUrl') END AS compareUrl,
             CASE WHEN json_type(event_json, '$.push.commits') = 'array'
               THEN json_array_length(event_json, '$.push.commits') END AS commitCount,
             CASE WHEN json_type(event_json, '$.pullRequest.number') = 'integer'
               THEN json_extract(event_json, '$.pullRequest.number') END AS pullRequestNumber,
             CASE WHEN json_type(event_json, '$.pullRequest.title') = 'text'
               THEN json_extract(event_json, '$.pullRequest.title') END AS pullRequestTitle,
             CASE WHEN json_type(event_json, '$.pullRequest.url') = 'text'
               THEN json_extract(event_json, '$.pullRequest.url') END AS pullRequestUrl
           FROM events INDEXED BY idx_events_received_at
           WHERE ${PUBLIC_EVENTS_WHERE}
             AND received_at >= ?
           ORDER BY received_at DESC, delivery_id DESC
           LIMIT ?`
        )
        .bind(since.toISOString(), limit)
        .all<PublicFeedMaterial['events'][number]>(),
      this.db
        .prepare(
          `SELECT repository, date, stars
           FROM (
             SELECT
               repository,
               substr(received_at, 1, 10) AS date,
               CASE WHEN json_type(event_json, '$.star.count') = 'integer'
                 THEN json_extract(event_json, '$.star.count') END AS stars,
               ROW_NUMBER() OVER (
                 PARTITION BY repository, substr(received_at, 1, 10)
                 ORDER BY received_at DESC, delivery_id DESC
               ) AS position
             FROM events
             WHERE event_type IN ('star.created', 'star.deleted')
               AND received_at >= ?
               AND json_type(event_json, '$.repository.private') = 'false'
           )
           WHERE position = 1
           ORDER BY repository ASC, date ASC`
        )
        .bind(since.toISOString())
        .all<PublicFeedMaterial['starDays'][number]>(),
    ]);

    return { events: events.results, starDays: starDays.results };
  }

  /**
   * What public activity is built from, before any visibility check: the published
   * events recorded as public since `since`, summed per UTC day and repository, and
   * the first UTC day with such an event. Both read only
   * `idx_events_public_received_at`'s rows, so private and unpublished events cost
   * nothing; the first day is one index row.
   */
  async readPublicActivityMaterial(since: Date): Promise<PublicActivityMaterial> {
    const [first, rows] = await Promise.all([
      this.db
        .prepare(
          `SELECT substr(MIN(received_at), 1, 10) AS since
           FROM events INDEXED BY idx_events_public_received_at
           WHERE ${PUBLIC_ACTIVITY_WHERE}`
        )
        .first<{ since: string | null }>(),
      this.db
        .prepare(
          `SELECT
             substr(received_at, 1, 10) AS date,
             repository,
             SUM(event_type = 'push.default_branch') AS pushes,
             COALESCE(SUM(CASE WHEN event_type = 'push.default_branch'
               THEN json_array_length(event_json, '$.push.commits') END), 0) AS commits,
             SUM(event_type = 'pull_request.merged') AS merges,
             SUM(event_type = 'release.published') AS releases,
             SUM(event_type = 'star.created') AS stars,
             MAX(received_at) AS lastAt
           FROM events INDEXED BY idx_events_public_received_at
           WHERE ${PUBLIC_ACTIVITY_WHERE}
             AND received_at >= ?
           GROUP BY date, repository
           ORDER BY lastAt DESC, repository ASC`
        )
        .bind(since.toISOString())
        .all<PublicActivityMaterial['rows'][number]>(),
    ]);

    return { since: first?.since ?? null, rows: rows.results };
  }

  /** The event recorded for a delivery id, or null when there is none. */
  async findEvent(deliveryId: string): Promise<RepoEvent | null> {
    const row = await this.db
      .prepare('SELECT event_json AS eventJson FROM events WHERE delivery_id = ?')
      .bind(deliveryId)
      .first<Pick<EventHistoryRow, 'eventJson'>>();
    return row === null ? null : deserializeRepoEvent(row.eventJson);
  }

  async listRecentEvents(limit = 50): Promise<EventHistoryEntry[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    const rows = await this.db
      .prepare(
        `SELECT
           delivery_id AS deliveryId,
           received_at AS receivedAt,
           event_json AS eventJson
         FROM events
         ORDER BY received_at DESC, delivery_id DESC
         LIMIT ?`
      )
      .bind(boundedLimit)
      .all<EventHistoryRow>();

    return rows.results.map((row) => ({
      deliveryId: row.deliveryId,
      receivedAt: new Date(row.receivedAt),
      event: deserializeRepoEvent(row.eventJson),
    }));
  }
}
