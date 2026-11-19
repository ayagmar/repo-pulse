import { DELIVERY_DEFAULTS } from '../../config/delivery-policy.js';
import type { NotificationFailureResult } from '../interfaces/notifier.js';
import { FAILURE_CLASSIFICATIONS } from '../models/failure-classification.js';
import type { RepoEvent } from '../models/repo-event.js';
import { REPO_EVENT_TYPES } from '../models/repo-event.js';
import type { ClaimedDelivery, D1DeliveryLedger } from './d1-delivery-ledger.js';
import { logger } from './logger.js';
import type { NotificationDispatcher } from './notification-dispatcher.js';
import { isOutsidePerson } from './people.js';
import { isSilentAlert, shouldAlert } from './thread-activity.js';

interface EventProcessingContext {
  deliveryId: string;
  repository: string;
  sourceEventType: string;
}

type EventProcessorEnqueueResult =
  | { outcome: 'accepted' }
  | { outcome: 'recorded' }
  | { outcome: 'duplicate' };

interface DurableEventProcessorOptions {
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  succeededRetentionDays?: number;
  processingLeaseMs?: number;
  drainBatchSize?: number;
}

/** Who is never remembered, besides repository owners and bots. */
interface PeopleOptions {
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

  /**
   * Persist an accepted event. Whether it alerts, and whether the alert is silent, is
   * decided here, once, and stored with it: a history-only event is recorded and never
   * queued. Two optional enrichments are
   * decided in the same batch: for an outside person, an alerting event records what
   * was seen from them before, and a star event records its repository's milestones and
   * the one it celebrates, if any. If persisting with them fails, nothing of them was
   * written, and the event is persisted without them, as a plain alert; only that
   * failure fails the request.
   */
  async enqueue(
    event: RepoEvent,
    context: EventProcessingContext
  ): Promise<EventProcessorEnqueueResult> {
    const ignoredLogins = this.people?.ignoredLogins ?? new Set<string>();
    const alert = shouldAlert(event, ignoredLogins);
    const input = {
      deliveryId: context.deliveryId,
      sourceEventType: context.sourceEventType,
      repository: context.repository,
      event: !alert
        ? { ...event, alert: false as const }
        : isSilentAlert(event, ignoredLogins)
          ? { ...event, silent: true as const }
          : event,
      maxAttempts: this.maxAttempts,
    };
    const senderHistory =
      this.people !== null &&
      alert &&
      isOutsidePerson(event.sender, event.repository.owner, ignoredLogins);
    const starMilestone =
      event.type === REPO_EVENT_TYPES.STAR_CREATED || event.type === REPO_EVENT_TYPES.STAR_DELETED;
    if (!(senderHistory || starMilestone)) {
      return this.ledger.persistAcceptedDelivery(input);
    }

    try {
      return await this.ledger.persistAcceptedDelivery({
        ...input,
        ...(senderHistory ? { rememberSenderId: event.sender.id } : {}),
        ...(starMilestone ? { recordStarMilestone: true } : {}),
      });
    } catch {
      // No exception text: D1 errors can quote bound values.
      logger.warn('event_processor.enrichment_failed', {
        component: 'event_processor',
        deliveryId: context.deliveryId,
        repository: context.repository,
        senderHistory,
        starMilestone,
      });
      return this.ledger.persistAcceptedDelivery(input);
    }
  }

  retryDelivery(deliveryId: string): ReturnType<D1DeliveryLedger['retryFailedDelivery']> {
    return this.ledger.retryFailedDelivery(deliveryId, this.maxAttempts);
  }

  async drainDueDeliveries(options: DrainDueDeliveriesOptions = {}): Promise<void> {
    if (!this.dispatcher.hasNotifiers()) {
      return;
    }

    const recoveredCount = await this.ledger.requeueExpiredProcessingDeliveries(
      new Date(),
      this.dispatcher.getNotifiers().map((notifier) => notifier.name)
    );
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

      if (await this.processDelivery(delivery)) {
        // Bound the extra write to one per drain and leave other work for the next run.
        return;
      }
    }
  }

  /** Returns true when an outcome write needed a retry. */
  private async processDelivery(delivery: ClaimedDelivery): Promise<boolean> {
    try {
      // A retry resends only to the providers that have not accepted this delivery yet.
      const deliveredProviders = await this.ledger.listSucceededProviders(delivery.deliveryId);
      const attemptedAt = new Date();
      const results = await this.dispatcher.dispatch(delivery.event, {
        deliveryId: delivery.deliveryId,
        skipProviders: deliveredProviders,
      });

      const attempts = results.map((result) => ({
        provider: result.provider,
        success: result.success,
        attemptedAt,
        ...(!result.success ? { error: result.error } : {}),
      }));
      const failures = results.filter((result) => !result.success);
      const transient = failures.every(
        (failure) => failure.failureClassification === FAILURE_CLASSIFICATIONS.TRANSIENT
      );
      const retry = transient && delivery.processingAttempt < delivery.maxAttempts;
      const outcome =
        failures.length === 0
          ? { status: 'succeeded' as const, at: new Date() }
          : {
              status: retry ? ('pending' as const) : ('failed' as const),
              at: retry
                ? new Date(
                    Date.now() +
                      calculateRetryDelayMs(
                        delivery.processingAttempt,
                        failures,
                        this.retryBaseDelayMs,
                        this.retryMaxDelayMs
                      )
                  )
                : new Date(),
              error: summarizeFailures(failures),
              classification: transient
                ? FAILURE_CLASSIFICATIONS.TRANSIENT
                : FAILURE_CLASSIFICATIONS.PERMANENT,
            };
      try {
        await this.ledger.recordDeliveryOutcome(delivery, attempts, outcome);
        return false;
      } catch {
        await this.ledger.recordDeliveryOutcome(delivery, attempts, outcome);
        return true;
      }
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
