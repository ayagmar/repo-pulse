import { DELIVERY_DEFAULTS } from '../../config/delivery-policy.js';
import type { NotificationFailureResult } from '../interfaces/notifier.js';
import { FAILURE_CLASSIFICATIONS } from '../models/failure-classification.js';
import type { RepoEvent } from '../models/repo-event.js';
import type { ClaimedDelivery, D1DeliveryLedger } from './d1-delivery-ledger.js';
import type { D1EventHistory } from './d1-event-history.js';
import { logger } from './logger.js';
import type { NotificationDispatcher } from './notification-dispatcher.js';
import { isOutsidePerson } from './people.js';

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

/** Where an outside sender's earlier events are read from when an event is accepted. */
interface PeopleOptions {
  history: D1EventHistory;
  ignoredLogins: ReadonlySet<string>;
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
    options: DurableEventProcessorOptions = {},
    private readonly people: PeopleOptions | null = null
  ) {
    this.maxAttempts = options.maxAttempts ?? DELIVERY_DEFAULTS.maxAttempts;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DELIVERY_DEFAULTS.retryBaseDelayMs;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DELIVERY_DEFAULTS.retryMaxDelayMs;
    this.succeededRetentionDays =
      options.succeededRetentionDays ?? DELIVERY_DEFAULTS.succeededRetentionDays;
    this.processingLeaseMs = options.processingLeaseMs ?? 5 * 60_000;
    this.drainBatchSize = options.drainBatchSize ?? DELIVERY_DEFAULTS.drainBatchSize;
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
      event: await this.withSenderHistory(event, context),
      maxAttempts: this.maxAttempts,
    });
  }

  /**
   * The event to persist: as first recorded when this delivery id was accepted before,
   * else with the sender's history attached for an outside person. The history is
   * optional, so a failed read persists the event without it.
   */
  private async withSenderHistory(
    event: RepoEvent,
    context: EventProcessingContext
  ): Promise<RepoEvent> {
    if (
      this.people === null ||
      !isOutsidePerson(event.sender, event.repository.owner, this.people.ignoredLogins)
    ) {
      return event;
    }

    try {
      const read = await this.people.history.readSenderHistory(
        context.deliveryId,
        event.sender.id,
        context.repository
      );
      return 'storedEvent' in read
        ? read.storedEvent
        : { ...event, senderHistory: read.senderHistory };
    } catch (error) {
      logger.warn('people.history_read_failed', {
        component: 'event_processor',
        deliveryId: context.deliveryId,
        repository: context.repository,
        error: error instanceof Error ? error.message : String(error),
      });
      return event;
    }
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
      logger.warn('event_processor.interrupted_deliveries_recovered', {
        component: 'event_processor',
        recoveredCount,
      });
    }

    if (options.pruneSucceededDeliveries === true) {
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
      // A retry resends only to the providers that have not accepted this delivery yet.
      const deliveredProviders = await this.ledger.listSucceededProviders(delivery.deliveryId);
      const attemptedAt = new Date();
      const results = await this.dispatcher.dispatch(delivery.event, {
        deliveryId: delivery.deliveryId,
        skipProviders: deliveredProviders,
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
        await this.ledger.markDeliverySucceeded(
          delivery.deliveryId,
          new Date(),
          delivery.processingAttempt
        );
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
          FAILURE_CLASSIFICATIONS.TRANSIENT,
          delivery.processingAttempt
        );
        return;
      }

      await this.ledger.markDeliveryFailed(
        delivery.deliveryId,
        new Date(),
        lastError,
        allFailuresTransient
          ? FAILURE_CLASSIFICATIONS.TRANSIENT
          : FAILURE_CLASSIFICATIONS.PERMANENT,
        delivery.processingAttempt
      );
    } catch (error) {
      // Keep the lease recoverable when persisting an outcome fails. A D1 outage
      // is not a permanent provider failure; cron will recover this attempt.
      logger.error('event_processor.delivery_interrupted', {
        component: 'event_processor',
        deliveryId: delivery.deliveryId,
        repository: delivery.repository,
        error,
      });
      throw error;
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
