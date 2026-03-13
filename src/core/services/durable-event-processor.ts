import { DELIVERY_DEFAULTS } from '../../config/delivery-policy.js';
import type { NotificationFailureResult } from '../interfaces/notifier.js';
import { FAILURE_CLASSIFICATIONS } from '../models/failure-classification.js';
import type { RepoEvent } from '../models/repo-event.js';
import type { ClaimedDelivery, D1DeliveryLedger } from './d1-delivery-ledger.js';
import { logger } from './logger.js';
import type { NotificationDispatcher } from './notification-dispatcher.js';

interface EventProcessingContext {
  deliveryId: string;
  repository: string;
  sourceEventType: string;
}

type EventProcessorEnqueueResult = { outcome: 'accepted' } | { outcome: 'duplicate' };

interface DurableEventProcessorOptions {
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  succeededRetentionDays?: number;
  processingLeaseMs?: number;
  drainBatchSize?: number;
}

interface DrainDueDeliveriesOptions {
  pruneSucceededDeliveries?: boolean;
}

function summarizeFailures(failures: readonly NotificationFailureResult[]): string {
  return failures.map((failure) => `${failure.provider}: ${failure.error}`).join('; ');
}

function calculateRetryDelayMs(
  processingAttempt: number,
  failures: readonly NotificationFailureResult[],
  retryBaseDelayMs: number,
  retryMaxDelayMs: number
): number {
  const exponentialDelayMs = Math.min(
    retryMaxDelayMs,
    retryBaseDelayMs * 2 ** Math.max(0, processingAttempt - 1)
  );

  const providerDelayMs = failures.reduce<number>((maxDelay, failure) => {
    if (failure.retryAfterMs === undefined) {
      return maxDelay;
    }

    return Math.max(maxDelay, failure.retryAfterMs);
  }, 0);

  return Math.max(exponentialDelayMs, providerDelayMs);
}

function subtractDays(date: Date, days: number): Date {
  return new Date(date.getTime() - days * 24 * 60 * 60_000);
}

export class DurableEventProcessor {
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly succeededRetentionDays: number;
  private readonly processingLeaseMs: number;
  private readonly drainBatchSize: number;

  constructor(
    private readonly ledger: D1DeliveryLedger,
    private readonly dispatcher: NotificationDispatcher,
    options: DurableEventProcessorOptions = {}
  ) {
    this.maxAttempts = options.maxAttempts ?? DELIVERY_DEFAULTS.maxAttempts;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DELIVERY_DEFAULTS.retryBaseDelayMs;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DELIVERY_DEFAULTS.retryMaxDelayMs;
    this.succeededRetentionDays =
      options.succeededRetentionDays ?? DELIVERY_DEFAULTS.succeededRetentionDays;
    this.processingLeaseMs = options.processingLeaseMs ?? 5 * 60_000;
    this.drainBatchSize = options.drainBatchSize ?? 25;
  }

  hasHandlers(): boolean {
    return this.dispatcher.hasNotifiers();
  }

  async enqueue(
    event: RepoEvent,
    context: EventProcessingContext
  ): Promise<EventProcessorEnqueueResult> {
    return this.ledger.persistAcceptedDelivery({
      deliveryId: context.deliveryId,
      sourceEventType: context.sourceEventType,
      repository: context.repository,
      event,
      maxAttempts: this.maxAttempts,
    });
  }

  retryDelivery(deliveryId: string): ReturnType<D1DeliveryLedger['retryFailedDelivery']> {
    return this.ledger.retryFailedDelivery(deliveryId, this.maxAttempts);
  }

  async drainDueDeliveries(options: DrainDueDeliveriesOptions = {}): Promise<void> {
    if (!this.dispatcher.hasNotifiers()) {
      return;
    }

    const recoveredCount = await this.ledger.requeueExpiredProcessingDeliveries(new Date());
    if (recoveredCount > 0) {
      logger.warn('event_processor.interrupted_deliveries_requeued', {
        component: 'event_processor',
        recoveredCount,
      });
    }

    if (options.pruneSucceededDeliveries) {
      await this.pruneSucceededDeliveries();
    }

    for (let index = 0; index < this.drainBatchSize; index += 1) {
      const delivery = await this.ledger.claimNextPendingDelivery(
        new Date(),
        this.processingLeaseMs
      );
      if (!delivery) {
        return;
      }

      await this.processDelivery(delivery);
    }
  }

  private async processDelivery(delivery: ClaimedDelivery): Promise<void> {
    try {
      const attemptedAt = new Date();
      const results = await this.dispatcher.dispatch(delivery.event, {
        deliveryId: delivery.deliveryId,
      });

      await this.ledger.recordProviderAttempts(
        delivery.deliveryId,
        delivery.processingAttempt,
        results.map((result) =>
          result.success
            ? {
                provider: result.provider,
                success: true,
                attemptedAt,
              }
            : {
                provider: result.provider,
                success: false,
                error: result.error,
                attemptedAt,
              }
        )
      );

      const failures = results.filter((result) => !result.success);
      if (failures.length === 0) {
        await this.ledger.markDeliverySucceeded(delivery.deliveryId, new Date());
        return;
      }

      const lastError = summarizeFailures(failures);
      const allFailuresTransient = failures.every(
        (failure) => failure.failureClassification === FAILURE_CLASSIFICATIONS.TRANSIENT
      );

      if (allFailuresTransient && delivery.processingAttempt < delivery.maxAttempts) {
        const delayMs = calculateRetryDelayMs(
          delivery.processingAttempt,
          failures,
          this.retryBaseDelayMs,
          this.retryMaxDelayMs
        );
        const nextAttemptAt = new Date(Date.now() + delayMs);

        await this.ledger.rescheduleDelivery(
          delivery.deliveryId,
          nextAttemptAt,
          lastError,
          FAILURE_CLASSIFICATIONS.TRANSIENT
        );
        return;
      }

      await this.ledger.markDeliveryFailed(
        delivery.deliveryId,
        new Date(),
        lastError,
        allFailuresTransient ? FAILURE_CLASSIFICATIONS.TRANSIENT : FAILURE_CLASSIFICATIONS.PERMANENT
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? (error.stack ?? error.message) : String(error);

      await this.ledger.markDeliveryFailed(
        delivery.deliveryId,
        new Date(),
        errorMessage,
        FAILURE_CLASSIFICATIONS.PERMANENT
      );
      logger.error('event_processor.delivery_failed', {
        component: 'event_processor',
        deliveryId: delivery.deliveryId,
        repository: delivery.repository,
        error,
      });
    }
  }

  private async pruneSucceededDeliveries(): Promise<void> {
    const prunedCount = await this.ledger.pruneSucceededDeliveries(
      subtractDays(new Date(), this.succeededRetentionDays)
    );

    if (prunedCount > 0) {
      logger.info('event_processor.succeeded_deliveries_pruned', {
        component: 'event_processor',
        prunedCount,
        retentionDays: this.succeededRetentionDays,
      });
    }
  }
}
