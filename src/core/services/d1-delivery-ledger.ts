import type {
  DeliveryDetails,
  DeliveryStats,
  DeliveryStatus,
  DeliverySummary,
  ProviderAttemptRecord,
} from '../models/delivery-ledger.js';
import { DELIVERY_STATUSES } from '../models/delivery-ledger.js';
import type { FailureClassification } from '../models/failure-classification.js';
import type { RepoEvent } from '../models/repo-event.js';
import {
  deserializeRepoEvent,
  REPO_EVENT_TYPES,
  serializeRepoEvent,
} from '../models/repo-event.js';
import { prepareEventHistoryInsert, THREAD_ACTIVATION } from './d1-event-history.js';
import { prepareStarMilestoneStatements } from './d1-star-milestones.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from './d1-types.js';

const SWEEP_LIMIT = 4;
const PRUNE_DELIVERY_LIMIT = 4;
const PRUNE_RECEIPT_LIMIT = 8;

const ATTEMPTED_PENDING = `status = 'pending' AND processing_attempts > 0 AND processing_attempts < max_attempts`;
const EXPIRED_SUCCEEDED = `SELECT delivery_id FROM deliveries INDEXED BY idx_deliveries_status_processing_finished_at
  WHERE status = 'succeeded' AND processing_finished_at IS NOT NULL AND processing_finished_at < ?
  ORDER BY processing_finished_at LIMIT ?`;

const HAS_ALL_RECEIPTS = `json_array_length(providers) > 0 AND NOT EXISTS (
  SELECT 1 FROM json_each(providers) AS provider
  WHERE NOT EXISTS (SELECT 1 FROM provider_attempts AS attempt
    WHERE attempt.delivery_id = candidates.delivery_id AND attempt.provider_name = provider.value AND attempt.success = 1)
)`;

interface PersistDeliveryInput {
  deliveryId: string;
  sourceEventType: string;
  repository: string;
  event: RepoEvent;
  maxAttempts: number;
  /** Record what was seen from this sender before, on the stored event. */
  rememberSenderId?: number;
  /** For a star event: record its repository's milestones, and any it celebrates. */
  recordStarMilestone?: boolean;
}

interface DeliveryForProcessing {
  deliveryId: string;
  repository: string;
  event: RepoEvent;
  processingAttempt: number;
  maxAttempts: number;
}

interface DeliveryRow {
  deliveryId: string;
  sourceEventType: string;
  eventType: RepoEvent['type'];
  repository: string;
  status: DeliveryStatus;
  acceptedAt: string;
  nextAttemptAt: string | null;
  processingStartedAt: string | null;
  processingFinishedAt: string | null;
  processingAttempts: number;
  maxAttempts: number;
  providerAttemptCount: number;
  lastError: string | null;
  lastFailureClassification: FailureClassification | null;
}

interface DeliveryDetailRow extends DeliveryRow {
  eventJson: string;
}

interface ProviderAttempt {
  provider: string;
  success: boolean;
  error?: string;
  attemptedAt: Date;
}

type DeliveryOutcome =
  | { status: 'succeeded'; at: Date }
  | {
      status: 'pending' | 'failed' | 'processing';
      at: Date;
      error: string;
      classification: FailureClassification;
    };

interface ProviderAttemptRow {
  id: number;
  deliveryAttempt: number;
  provider: string;
  attemptedAt: string;
  success: number;
  error: string | null;
}

interface RetryQueuedResult {
  outcome: 'retry_queued';
}

interface RetryNotFoundResult {
  outcome: 'not_found';
}

interface RetryRejectedResult {
  outcome: 'not_retryable';
  status: DeliveryStatus;
}

interface PersistDeliveryAccepted {
  outcome: 'accepted';
}

/** Recorded for history only, as its stored event says: no delivery is queued. */
interface PersistDeliveryRecorded {
  outcome: 'recorded';
}

interface PersistDeliveryDuplicate {
  outcome: 'duplicate';
}

export type ClaimedDelivery = DeliveryForProcessing;
type RetryDeliveryResult = RetryQueuedResult | RetryNotFoundResult | RetryRejectedResult;
type PersistDeliveryResult =
  | PersistDeliveryAccepted
  | PersistDeliveryRecorded
  | PersistDeliveryDuplicate;

function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function summarizeDeliveryRow(row: DeliveryRow): DeliverySummary {
  return {
    deliveryId: row.deliveryId,
    sourceEventType: row.sourceEventType,
    eventType: row.eventType,
    repository: row.repository,
    status: row.status,
    acceptedAt: new Date(row.acceptedAt),
    nextAttemptAt: toDate(row.nextAttemptAt),
    processingStartedAt: toDate(row.processingStartedAt),
    processingFinishedAt: toDate(row.processingFinishedAt),
    processingAttempts: row.processingAttempts,
    maxAttempts: row.maxAttempts,
    providerAttemptCount: row.providerAttemptCount,
    lastError: row.lastError,
    lastFailureClassification: row.lastFailureClassification,
  };
}

function mapProviderAttemptRow(row: ProviderAttemptRow): ProviderAttemptRecord {
  return {
    id: row.id,
    deliveryAttempt: row.deliveryAttempt,
    provider: row.provider,
    attemptedAt: new Date(row.attemptedAt),
    success: row.success === 1,
    error: row.error,
  };
}

export class D1DeliveryLedger {
  constructor(private readonly db: D1DatabaseLike) {}

  /**
   * Record an accepted event and, unless it is history-only, queue its delivery, in one
   * D1 batch. A delivery id already in `events`, the permanent history, is never queued
   * again: a GitHub redelivery is a duplicate even after its delivery row was pruned,
   * whatever its payload says now, and its first recorded event is kept. The batch is one
   * transaction, so a run stopped mid-write leaves both rows or neither, and the next
   * delivery of that id finds them both or starts over.
   *
   * The delivery row is inserted first, while the history can still say whether the id
   * is new, then given the event exactly as stored, after the statements that add to it
   * (`senderHistory`, `starMilestone`). The first recorded comment or review also sets the
   * activation instant, which never moves. With `recordStarMilestone`, a star event's
   * milestone is decided in the same batch (see `prepareStarMilestoneStatements`).
   */
  async persistAcceptedDelivery(input: PersistDeliveryInput): Promise<PersistDeliveryResult> {
    const acceptedAt = new Date().toISOString();
    const { event } = input;
    const statements: D1PreparedStatementLike[] = [];
    // A history-only event is recorded and never queued.
    const deliveryIndex =
      event.alert === false
        ? null
        : statements.push(
            this.db
              .prepare(
                `INSERT OR IGNORE INTO deliveries (
                  delivery_id,
                  source_event_type,
                  normalized_event_type,
                  repository,
                  normalized_event_json,
                  accepted_at,
                  status,
                  next_attempt_at,
                  processing_attempts,
                  max_attempts,
                  processing_started_at,
                  processing_finished_at,
                  lease_expires_at,
                  last_error,
                  last_failure_classification
                )
                SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, NULL
                WHERE NOT EXISTS (SELECT 1 FROM events WHERE delivery_id = ?)`
              )
              .bind(
                input.deliveryId,
                input.sourceEventType,
                event.type,
                input.repository,
                serializeRepoEvent(event),
                acceptedAt,
                DELIVERY_STATUSES.PENDING,
                acceptedAt,
                input.maxAttempts,
                input.deliveryId
              )
          ) - 1;
    const milestone =
      input.recordStarMilestone === true &&
      (event.type === REPO_EVENT_TYPES.STAR_CREATED || event.type === REPO_EVENT_TYPES.STAR_DELETED)
        ? prepareStarMilestoneStatements(this.db, {
            deliveryId: input.deliveryId,
            event,
            acceptedAt,
          })
        : null;
    statements.push(...(milestone?.beforeHistory ?? []));
    const historyIndex =
      statements.push(
        prepareEventHistoryInsert(this.db, {
          deliveryId: input.deliveryId,
          repository: input.repository,
          event,
          receivedAt: event.activityAt ?? acceptedAt,
          ...(input.rememberSenderId !== undefined
            ? { rememberSenderId: input.rememberSenderId }
            : {}),
        })
      ) - 1;
    statements.push(...(milestone?.afterHistory ?? []));
    // Without these additions the history stores exactly the JSON the row was inserted
    // with. With them, only a row this batch inserted can differ from the stored event:
    // nothing rewrites a stored event after its acceptance.
    if (deliveryIndex !== null && (input.rememberSenderId !== undefined || milestone !== null)) {
      statements.push(
        this.db
          .prepare(
            `UPDATE deliveries
             SET normalized_event_json = (SELECT event_json FROM events WHERE delivery_id = ?)
             WHERE delivery_id = ? AND accepted_at = ?`
          )
          .bind(input.deliveryId, input.deliveryId, acceptedAt)
      );
    }
    const isConversation =
      event.type === REPO_EVENT_TYPES.COMMENT_CREATED ||
      event.type === REPO_EVENT_TYPES.REVIEW_SUBMITTED;
    if (isConversation && event.occurredAt !== undefined) {
      statements.push(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO feature_activations (feature, activated_at, delivery_id)
             SELECT ?, ?, delivery_id
             FROM events
             WHERE delivery_id = ? AND event_type IN ('comment.created', 'review.submitted')`
          )
          .bind(THREAD_ACTIVATION, event.occurredAt, input.deliveryId)
      );
    }
    const results = await this.db.batch(statements);

    if (deliveryIndex !== null && (results[deliveryIndex]?.meta.changes ?? 0) > 0) {
      return { outcome: 'accepted' };
    }
    return (results[historyIndex]?.meta.changes ?? 0) > 0
      ? { outcome: 'recorded' }
      : { outcome: 'duplicate' };
  }

  async claimNextPendingDelivery(
    now: Date,
    leaseMs: number
  ): Promise<DeliveryForProcessing | null> {
    const availableAt = now.toISOString();
    const startedAt = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();

    const row = await this.db
      .prepare(
        `WITH next_delivery AS (
           SELECT delivery_id
           FROM deliveries INDEXED BY idx_deliveries_due
           WHERE status = 'pending'
             AND next_attempt_at IS NOT NULL
             AND next_attempt_at <= ?
             AND processing_attempts < max_attempts
           ORDER BY next_attempt_at ASC, accepted_at ASC
           LIMIT 1
         )
         UPDATE deliveries
         SET status = ?,
             next_attempt_at = NULL,
             processing_attempts = processing_attempts + 1,
             processing_started_at = ?,
             processing_finished_at = NULL,
             lease_expires_at = ?
         WHERE delivery_id = (SELECT delivery_id FROM next_delivery)
           AND status = ?
           AND next_attempt_at IS NOT NULL
           AND next_attempt_at <= ?
         RETURNING
           delivery_id AS deliveryId,
           repository,
           normalized_event_json AS eventJson,
           processing_attempts AS processingAttempts,
           max_attempts AS maxAttempts`
      )
      .bind(
        availableAt,
        DELIVERY_STATUSES.PROCESSING,
        startedAt,
        leaseExpiresAt,
        DELIVERY_STATUSES.PENDING,
        availableAt
      )
      .first<{
        deliveryId: string;
        repository: string;
        eventJson: string;
        processingAttempts: number;
        maxAttempts: number;
      }>();

    if (!row) {
      return null;
    }

    return {
      deliveryId: row.deliveryId,
      repository: row.repository,
      event: deserializeRepoEvent(row.eventJson),
      processingAttempt: row.processingAttempts,
      maxAttempts: row.maxAttempts,
    };
  }

  async recordProviderAttempts(
    deliveryId: string,
    deliveryAttempt: number,
    attempts: readonly ProviderAttempt[]
  ): Promise<void> {
    if (attempts.length !== 0) {
      await this.db.batch(this.providerAttemptStatements(deliveryId, deliveryAttempt, attempts));
    }
  }

  private providerAttemptStatements(
    deliveryId: string,
    deliveryAttempt: number,
    attempts: readonly ProviderAttempt[],
    fenced = false
  ): D1PreparedStatementLike[] {
    return attempts.map((attempt) =>
      this.db
        .prepare(
          `INSERT INTO provider_attempts (
             delivery_id,
             delivery_attempt,
             provider_name,
             attempted_at,
             success,
             error_message
           ) SELECT ?, ?, ?, ?, ?, ?${
             fenced
               ? `
           WHERE EXISTS (SELECT 1 FROM deliveries
             WHERE delivery_id = ? AND status = 'processing' AND processing_attempts = ?)
           AND NOT EXISTS (SELECT 1 FROM provider_attempts
             WHERE delivery_id = ? AND provider_name = ? AND success = ? AND delivery_attempt = ?)`
               : ''
           }`
        )
        .bind(
          deliveryId,
          deliveryAttempt,
          attempt.provider,
          attempt.attemptedAt.toISOString(),
          attempt.success ? 1 : 0,
          attempt.error ?? null,
          ...(fenced
            ? [
                deliveryId,
                deliveryAttempt,
                deliveryId,
                attempt.provider,
                attempt.success ? 1 : 0,
                deliveryAttempt,
              ]
            : [])
        )
    );
  }

  /** Commit the evidence and outcome together. A retry after a lost D1 reply is a no-op. */
  async recordDeliveryOutcome(
    delivery: ClaimedDelivery,
    attempts: readonly ProviderAttempt[],
    outcome: DeliveryOutcome
  ): Promise<void> {
    const { deliveryId, processingAttempt } = delivery;
    await this.db.batch([
      ...this.providerAttemptStatements(deliveryId, processingAttempt, attempts, true),
      this.deliveryOutcomeStatement(deliveryId, processingAttempt, outcome),
    ]);
  }

  async listSucceededProviders(
    deliveryId: string,
    providers: readonly string[]
  ): Promise<Set<string>> {
    const rows = await this.db
      .prepare(
        `SELECT provider.value AS provider FROM json_each(?) AS provider
         WHERE EXISTS (SELECT 1 FROM provider_attempts
           WHERE delivery_id = ? AND provider_name = provider.value AND success = 1)`
      )
      .bind(JSON.stringify(providers), deliveryId)
      .all<{ provider: string }>();

    return new Set(rows.results.map((row) => row.provider));
  }

  async markDeliverySucceeded(
    deliveryId: string,
    finishedAt: Date,
    processingAttempt: number
  ): Promise<void> {
    await this.deliveryOutcomeStatement(deliveryId, processingAttempt, {
      status: 'succeeded',
      at: finishedAt,
    }).run();
  }

  async markDeliveryFailed(
    deliveryId: string,
    finishedAt: Date,
    lastError: string,
    failureClassification: FailureClassification,
    processingAttempt: number
  ): Promise<void> {
    await this.deliveryOutcomeStatement(deliveryId, processingAttempt, {
      status: 'failed',
      at: finishedAt,
      error: lastError,
      classification: failureClassification,
    }).run();
  }

  async rescheduleDelivery(
    deliveryId: string,
    nextAttemptAt: Date,
    lastError: string,
    failureClassification: FailureClassification,
    processingAttempt: number
  ): Promise<void> {
    await this.deliveryOutcomeStatement(deliveryId, processingAttempt, {
      status: 'pending',
      at: nextAttemptAt,
      error: lastError,
      classification: failureClassification,
    }).run();
  }

  private deliveryOutcomeStatement(
    deliveryId: string,
    processingAttempt: number,
    outcome: DeliveryOutcome
  ): D1PreparedStatementLike {
    return this.db
      .prepare(
        `UPDATE deliveries
         SET status = ?,
             next_attempt_at = ?,
             processing_started_at = CASE WHEN ? = 'pending' THEN NULL ELSE processing_started_at END,
             processing_finished_at = ?,
             lease_expires_at = CASE WHEN ? = 'processing' THEN MAX(lease_expires_at, ?) END,
             last_error = ?,
             last_failure_classification = ?
         WHERE delivery_id = ? AND status = 'processing' AND processing_attempts = ?`
      )
      .bind(
        outcome.status,
        outcome.status === 'pending' ? outcome.at.toISOString() : null,
        outcome.status,
        outcome.status === 'pending' || outcome.status === 'processing'
          ? null
          : outcome.at.toISOString(),
        outcome.status,
        outcome.at.toISOString(),
        outcome.status === 'succeeded' ? null : outcome.error,
        outcome.status === 'succeeded' ? null : outcome.classification,
        deliveryId,
        processingAttempt
      );
  }

  async requeueExpiredProcessingDeliveries(
    now: Date,
    providers: readonly string[] = []
  ): Promise<number> {
    const nextAttemptAt = now.toISOString();
    const [, result] = await this.db.batch([
      // Move over pages even if none of the legacy rows has complete receipts.
      this.db
        .prepare(`UPDATE delivery_maintenance SET
        started_after = COALESCE(scanned_through, ''),
        scanned_through = (SELECT MAX(delivery_id) FROM (
          SELECT delivery_id FROM deliveries INDEXED BY idx_deliveries_attempted_pending
          WHERE ${ATTEMPTED_PENDING} AND delivery_id > COALESCE(delivery_maintenance.scanned_through, '')
          ORDER BY delivery_id LIMIT ?))
        WHERE singleton = 1 AND (scanned_through IS NOT NULL OR EXISTS (
          SELECT 1 FROM deliveries INDEXED BY idx_deliveries_attempted_pending
          WHERE ${ATTEMPTED_PENDING} AND delivery_id > ''))`)
        .bind(SWEEP_LIMIT),
      this.db
        .prepare(`WITH
        args(providers, now, cap, interruption) AS (VALUES (?, ?, ?, ?)),
        expired AS MATERIALIZED (
          SELECT delivery_id, processing_attempts >= max_attempts AS exhausted, 0 AS legacy
          FROM deliveries INDEXED BY idx_deliveries_status_lease_expires_at
          WHERE status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= (SELECT now FROM args)
          ORDER BY lease_expires_at LIMIT (SELECT cap FROM args)
        ), exhausted AS MATERIALIZED (
          SELECT delivery_id, 1 AS exhausted, 0 AS legacy FROM deliveries INDEXED BY idx_deliveries_exhausted_pending
          WHERE status = 'pending' AND processing_attempts >= max_attempts AND delivery_id >= ''
          ORDER BY delivery_id LIMIT (SELECT cap FROM args)
        ), legacy AS MATERIALIZED (
          SELECT delivery_id, 0 AS exhausted, 1 AS legacy FROM deliveries INDEXED BY idx_deliveries_attempted_pending
          WHERE ${ATTEMPTED_PENDING} AND delivery_id > (SELECT started_after FROM delivery_maintenance WHERE singleton = 1)
          ORDER BY delivery_id LIMIT (SELECT cap FROM args)
        ), candidates AS (
          SELECT * FROM expired UNION ALL SELECT * FROM exhausted UNION ALL SELECT * FROM legacy
        ), interrupted AS MATERIALIZED (
          SELECT delivery_id, CASE
            WHEN ${HAS_ALL_RECEIPTS} THEN 'succeeded'
            WHEN exhausted THEN 'failed'
            WHEN NOT legacy THEN 'pending'
          END AS outcome FROM candidates CROSS JOIN args
        )
        UPDATE deliveries
        SET (status, next_attempt_at, processing_started_at, processing_finished_at, lease_expires_at,
          last_error, last_failure_classification) = (
          SELECT outcome, CASE WHEN outcome = 'pending' THEN now END,
            NULL, CASE WHEN outcome != 'pending' THEN now END, NULL,
            CASE WHEN outcome != 'succeeded' THEN COALESCE(deliveries.last_error, interruption) END,
            CASE WHEN outcome != 'succeeded' THEN 'transient' END
          FROM interrupted CROSS JOIN args WHERE interrupted.delivery_id = deliveries.delivery_id
        )
        WHERE delivery_id IN (SELECT delivery_id FROM interrupted WHERE outcome IS NOT NULL)`)
        .bind(
          JSON.stringify(providers),
          nextAttemptAt,
          SWEEP_LIMIT,
          'Processing interrupted before completion'
        ),
    ]);
    return result?.meta.changes ?? 0;
  }

  async listDeliveries(
    statuses: readonly DeliveryStatus[] = [],
    limit = 50
  ): Promise<DeliverySummary[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    const whereClause =
      statuses.length === 0
        ? ''
        : `WHERE deliveries.status IN (${statuses.map(() => '?').join(', ')})`;
    const rows = await this.db
      .prepare(
        `SELECT
           deliveries.delivery_id AS deliveryId,
           deliveries.source_event_type AS sourceEventType,
           deliveries.normalized_event_type AS eventType,
           deliveries.repository,
           deliveries.status,
           deliveries.accepted_at AS acceptedAt,
           deliveries.next_attempt_at AS nextAttemptAt,
           deliveries.processing_started_at AS processingStartedAt,
           deliveries.processing_finished_at AS processingFinishedAt,
           deliveries.processing_attempts AS processingAttempts,
           deliveries.max_attempts AS maxAttempts,
           deliveries.last_error AS lastError,
           deliveries.last_failure_classification AS lastFailureClassification,
           (SELECT COUNT(*) FROM provider_attempts
            WHERE provider_attempts.delivery_id = deliveries.delivery_id) AS providerAttemptCount
         FROM deliveries
         ${whereClause}
         ORDER BY deliveries.accepted_at DESC, deliveries.delivery_id DESC
         LIMIT ?`
      )
      .bind(...statuses, boundedLimit)
      .all<DeliveryRow>();

    return rows.results.map((row) => summarizeDeliveryRow(row));
  }

  async getDelivery(deliveryId: string): Promise<DeliveryDetails | null> {
    const deliveryRow = await this.db
      .prepare(
        `SELECT
           deliveries.delivery_id AS deliveryId,
           deliveries.source_event_type AS sourceEventType,
           deliveries.normalized_event_type AS eventType,
           deliveries.repository,
           deliveries.normalized_event_json AS eventJson,
           deliveries.status,
           deliveries.accepted_at AS acceptedAt,
           deliveries.next_attempt_at AS nextAttemptAt,
           deliveries.processing_started_at AS processingStartedAt,
           deliveries.processing_finished_at AS processingFinishedAt,
           deliveries.processing_attempts AS processingAttempts,
           deliveries.max_attempts AS maxAttempts,
           deliveries.last_error AS lastError,
           deliveries.last_failure_classification AS lastFailureClassification,
           COUNT(provider_attempts.id) AS providerAttemptCount
         FROM deliveries
         LEFT JOIN provider_attempts ON provider_attempts.delivery_id = deliveries.delivery_id
         WHERE deliveries.delivery_id = ?
         GROUP BY deliveries.delivery_id`
      )
      .bind(deliveryId)
      .first<DeliveryDetailRow>();

    if (!deliveryRow) {
      return null;
    }

    const attempts = await this.db
      .prepare(
        `SELECT
           id,
           delivery_attempt AS deliveryAttempt,
           provider_name AS provider,
           attempted_at AS attemptedAt,
           success,
           error_message AS error
         FROM provider_attempts
         WHERE delivery_id = ?
         ORDER BY id ASC`
      )
      .bind(deliveryId)
      .all<ProviderAttemptRow>();

    return {
      ...summarizeDeliveryRow(deliveryRow),
      event: deserializeRepoEvent(deliveryRow.eventJson),
      attempts: attempts.results.map((row) => mapProviderAttemptRow(row)),
    };
  }

  async retryFailedDelivery(deliveryId: string, retryBudget: number): Promise<RetryDeliveryResult> {
    if (!Number.isSafeInteger(retryBudget) || retryBudget < 1) {
      throw new Error('retryBudget must be a positive safe integer');
    }

    const queued = await this.db
      .prepare(
        `UPDATE deliveries
         SET status = ?,
             next_attempt_at = ?,
             max_attempts = processing_attempts + ?,
             processing_started_at = NULL,
             processing_finished_at = NULL,
             lease_expires_at = NULL,
             last_error = NULL,
             last_failure_classification = NULL
         WHERE delivery_id = ? AND status = ?
         RETURNING delivery_id`
      )
      .bind(
        DELIVERY_STATUSES.PENDING,
        new Date().toISOString(),
        retryBudget,
        deliveryId,
        DELIVERY_STATUSES.FAILED
      )
      .first<{ delivery_id: string }>();

    if (queued) {
      return { outcome: 'retry_queued' };
    }

    const existing = await this.db
      .prepare('SELECT status FROM deliveries WHERE delivery_id = ?')
      .bind(deliveryId)
      .first<{ status: DeliveryStatus }>();
    return existing
      ? { outcome: 'not_retryable', status: existing.status }
      : { outcome: 'not_found' };
  }

  async pruneSucceededDeliveries(olderThan: Date): Promise<number> {
    const cutoff = olderThan.toISOString();
    // Admin retries can leave arbitrarily many child rows on one delivery. Delete a
    // bounded set first; only childless rows can be deleted from the parent table.
    const [, result] = await this.db.batch([
      this.db
        .prepare(`WITH expired AS MATERIALIZED (${EXPIRED_SUCCEEDED})
        DELETE FROM provider_attempts WHERE id IN (
          SELECT attempt.id FROM expired CROSS JOIN provider_attempts AS attempt
          ON attempt.delivery_id = expired.delivery_id LIMIT ?)`)
        .bind(cutoff, PRUNE_DELIVERY_LIMIT, PRUNE_RECEIPT_LIMIT),
      this.db
        .prepare(`WITH expired AS MATERIALIZED (${EXPIRED_SUCCEEDED})
        DELETE FROM deliveries WHERE delivery_id IN (
          SELECT expired.delivery_id FROM expired WHERE NOT EXISTS (
            SELECT 1 FROM provider_attempts AS attempt WHERE attempt.delivery_id = expired.delivery_id
          ))`)
        .bind(cutoff, PRUNE_DELIVERY_LIMIT),
    ]);
    return result?.meta.changes ?? 0;
  }

  async getStats(): Promise<DeliveryStats> {
    const rows = await this.db
      .prepare('SELECT status, COUNT(*) AS count FROM deliveries GROUP BY status')
      .all<{ status: DeliveryStatus; count: number }>();

    const stats: DeliveryStats = {
      total: 0,
      pending: 0,
      processing: 0,
      failed: 0,
      succeeded: 0,
    };

    for (const row of rows.results) {
      stats.total += row.count;

      switch (row.status) {
        case DELIVERY_STATUSES.PENDING:
          stats.pending = row.count;
          break;
        case DELIVERY_STATUSES.PROCESSING:
          stats.processing = row.count;
          break;
        case DELIVERY_STATUSES.FAILED:
          stats.failed = row.count;
          break;
        case DELIVERY_STATUSES.SUCCEEDED:
          stats.succeeded = row.count;
          break;
      }
    }

    return stats;
  }
}
