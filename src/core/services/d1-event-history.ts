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

export class D1EventHistory {
  constructor(private readonly db: D1DatabaseLike) {}

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
