import type { PublicFeedMaterial } from '../models/public-feed.js';
import type { RepoEvent, SenderHistory } from '../models/repo-event.js';
import { deserializeRepoEvent, serializeRepoEvent } from '../models/repo-event.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from './d1-types.js';

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
 * Prepare the history insert for an accepted delivery. The ledger batches it with
 * the delivery insert so an event is never queued without being recorded.
 */
export function prepareEventHistoryInsert(
  db: D1DatabaseLike,
  input: { deliveryId: string; repository: string; event: RepoEvent; receivedAt: string }
): D1PreparedStatementLike {
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
           CASE WHEN json_type(event_json, '$.sender.id') = 'integer'
             THEN json_extract(event_json, '$.sender.id') END AS senderId,
           json_extract(event_json, '$.sender.login') AS senderLogin,
           json_extract(event_json, '$.sender.url') AS senderUrl,
           json_extract(event_json, '$.repository.owner') AS repositoryOwner
         FROM events
         WHERE received_at >= ? AND received_at < ?
         ORDER BY received_at ASC, delivery_id ASC`
      )
      .bind(start.toISOString(), end.toISOString())
      .all<EventActivity>();

    return rows.results;
  }

  /**
   * The event already recorded for `deliveryId`, if any, so a redelivery keeps the text
   * it was first accepted with; otherwise what was recorded from `senderId` so far. Both
   * come from one query, and the counts read only the sender's rows through
   * `idx_events_sender_received_at`.
   */
  async readSenderHistory(
    deliveryId: string,
    senderId: number,
    repository: string
  ): Promise<{ storedEvent: RepoEvent } | { senderHistory: SenderHistory }> {
    const row = await this.db
      .prepare(
        `SELECT
           (SELECT event_json FROM events WHERE delivery_id = ?) AS storedEventJson,
           MIN(received_at) AS firstSeenAt,
           COUNT(*) AS priorEvents,
           COUNT(DISTINCT repository) AS priorRepositories,
           COALESCE(SUM(repository = ?), 0) AS priorInRepository
         FROM events
         WHERE json_extract(event_json, '$.sender.id') = ?`
      )
      .bind(deliveryId, repository, senderId)
      .first<SenderHistory & { storedEventJson: string | null }>();
    if (row === null) {
      throw new Error('Sender history query returned no row');
    }

    const { storedEventJson, ...senderHistory } = row;
    return storedEventJson === null
      ? { senderHistory }
      : { storedEvent: deserializeRepoEvent(storedEventJson) };
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
    // Only a JSON `false` in `$.repository.private` counts as recorded public: true,
    // a missing flag (events from before visibility was stored) or any other value
    // does not. Each field is read only when stored with its JSON type, because SQLite
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
           WHERE event_type IN (
               'release.published', 'star.created', 'push.default_branch', 'pull_request.merged'
             )
             AND received_at >= ?
             AND json_type(event_json, '$.repository.private') = 'false'
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
