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
import type { D1DatabaseLike } from './d1-types.js';

interface PersistDeliveryInput {
  deliveryId: string;
  sourceEventType: string;
  repository: string;
  event: RepoEvent;
  maxAttempts: number;
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

interface PersistDeliveryDuplicate {
  outcome: 'duplicate';
}

export type ClaimedDelivery = DeliveryForProcessing;
type RetryDeliveryResult = RetryQueuedResult | RetryNotFoundResult | RetryRejectedResult;
type PersistDeliveryResult = PersistDeliveryAccepted | PersistDeliveryDuplicate;

function serializeRepoEvent(event: RepoEvent): string {
  return JSON.stringify({
    ...event,
    timestamp: event.timestamp.toISOString(),
  });
}

function deserializeRepoEvent(value: string): RepoEvent {
  const parsed = JSON.parse(value) as RepoEvent & { timestamp: string };
  return {
    ...parsed,
    timestamp: new Date(parsed.timestamp),
  };
}

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

  async persistAcceptedDelivery(input: PersistDeliveryInput): Promise<PersistDeliveryResult> {
    const acceptedAt = new Date().toISOString();
    const result = await this.db
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, NULL)`
      )
      .bind(
        input.deliveryId,
        input.sourceEventType,
        input.event.type,
        input.repository,
        serializeRepoEvent(input.event),
        acceptedAt,
        DELIVERY_STATUSES.PENDING,
        acceptedAt,
        input.maxAttempts
      )
      .run();

    return result.meta.changes === 0 ? { outcome: 'duplicate' } : { outcome: 'accepted' };
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
           FROM deliveries
           WHERE status = ?
             AND next_attempt_at IS NOT NULL
             AND next_attempt_at <= ?
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
        DELIVERY_STATUSES.PENDING,
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
    attempts: readonly {
      provider: string;
      success: boolean;
      error?: string;
      attemptedAt: Date;
    }[]
  ): Promise<void> {
    if (attempts.length === 0) {
      return;
    }

    const statements = attempts.map((attempt) =>
      this.db
        .prepare(
          `INSERT INTO provider_attempts (
             delivery_id,
             delivery_attempt,
             provider_name,
             attempted_at,
             success,
             error_message
           ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          deliveryId,
          deliveryAttempt,
          attempt.provider,
          attempt.attemptedAt.toISOString(),
          attempt.success ? 1 : 0,
          attempt.error ?? null
        )
    );

    await this.db.batch(statements);
  }

  async markDeliverySucceeded(deliveryId: string, finishedAt: Date): Promise<void> {
    await this.db
      .prepare(
        `UPDATE deliveries
         SET status = ?,
             next_attempt_at = NULL,
             processing_finished_at = ?,
             lease_expires_at = NULL,
             last_error = NULL,
             last_failure_classification = NULL
         WHERE delivery_id = ?`
      )
      .bind(DELIVERY_STATUSES.SUCCEEDED, finishedAt.toISOString(), deliveryId)
      .run();
  }

  async markDeliveryFailed(
    deliveryId: string,
    finishedAt: Date,
    lastError: string,
    failureClassification: FailureClassification
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE deliveries
         SET status = ?,
             next_attempt_at = NULL,
             processing_finished_at = ?,
             lease_expires_at = NULL,
             last_error = ?,
             last_failure_classification = ?
         WHERE delivery_id = ?`
      )
      .bind(
        DELIVERY_STATUSES.FAILED,
        finishedAt.toISOString(),
        lastError,
        failureClassification,
        deliveryId
      )
      .run();
  }

  async rescheduleDelivery(
    deliveryId: string,
    nextAttemptAt: Date,
    lastError: string,
    failureClassification: FailureClassification
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE deliveries
         SET status = ?,
             next_attempt_at = ?,
             processing_started_at = NULL,
             processing_finished_at = NULL,
             lease_expires_at = NULL,
             last_error = ?,
             last_failure_classification = ?
         WHERE delivery_id = ?`
      )
      .bind(
        DELIVERY_STATUSES.PENDING,
        nextAttemptAt.toISOString(),
        lastError,
        failureClassification,
        deliveryId
      )
      .run();
  }

  async requeueExpiredProcessingDeliveries(now: Date): Promise<number> {
    const nextAttemptAt = now.toISOString();
    const result = await this.db
      .prepare(
        `UPDATE deliveries
         SET status = ?,
             next_attempt_at = ?,
             processing_started_at = NULL,
             processing_finished_at = NULL,
             lease_expires_at = NULL,
             last_error = COALESCE(last_error, ?),
             last_failure_classification = NULL
         WHERE status = ?
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?`
      )
      .bind(
        DELIVERY_STATUSES.PENDING,
        nextAttemptAt,
        'Processing interrupted before completion',
        DELIVERY_STATUSES.PROCESSING,
        nextAttemptAt
      )
      .run();

    return result.meta.changes;
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
           COUNT(provider_attempts.id) AS providerAttemptCount
         FROM deliveries
         LEFT JOIN provider_attempts ON provider_attempts.delivery_id = deliveries.delivery_id
         ${whereClause}
         GROUP BY deliveries.delivery_id
         ORDER BY deliveries.accepted_at DESC
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
    if (retryBudget < 1) {
      throw new Error('retryBudget must be at least 1');
    }

    const existing = await this.db
      .prepare(
        `SELECT
           status,
           processing_attempts AS processingAttempts
         FROM deliveries
         WHERE delivery_id = ?`
      )
      .bind(deliveryId)
      .first<{ status: DeliveryStatus; processingAttempts: number }>();

    if (!existing) {
      return { outcome: 'not_found' };
    }

    if (existing.status !== DELIVERY_STATUSES.FAILED) {
      return { outcome: 'not_retryable', status: existing.status };
    }

    await this.db
      .prepare(
        `UPDATE deliveries
         SET status = ?,
             next_attempt_at = ?,
             max_attempts = ?,
             processing_started_at = NULL,
             processing_finished_at = NULL,
             lease_expires_at = NULL,
             last_error = NULL,
             last_failure_classification = NULL
         WHERE delivery_id = ?`
      )
      .bind(
        DELIVERY_STATUSES.PENDING,
        new Date().toISOString(),
        existing.processingAttempts + retryBudget,
        deliveryId
      )
      .run();

    return { outcome: 'retry_queued' };
  }

  async pruneSucceededDeliveries(olderThan: Date): Promise<number> {
    const result = await this.db
      .prepare(
        `DELETE FROM deliveries
         WHERE status = ?
           AND processing_finished_at IS NOT NULL
           AND processing_finished_at < ?`
      )
      .bind(DELIVERY_STATUSES.SUCCEEDED, olderThan.toISOString())
      .run();

    return result.meta.changes;
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
