import type { RepoEvent } from '../models/repo-event.js';
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
           json_extract(event_json, '$.pullRequest.url') AS pullRequestUrl
         FROM events
         WHERE received_at >= ? AND received_at < ?
         ORDER BY received_at ASC, delivery_id ASC`
      )
      .bind(start.toISOString(), end.toISOString())
      .all<EventActivity>();

    return rows.results;
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
