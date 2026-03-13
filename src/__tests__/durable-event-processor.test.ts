import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotificationResult, Notifier } from '../core/interfaces/notifier.js';
import { FAILURE_CLASSIFICATIONS } from '../core/models/failure-classification.js';
import { D1DeliveryLedger } from '../core/services/d1-delivery-ledger.js';
import { DurableEventProcessor } from '../core/services/durable-event-processor.js';
import { NotificationDispatcher } from '../core/services/notification-dispatcher.js';
import {
  createTempDatabasePath,
  createTestD1Database,
  createTestRepoEvent,
} from './test-helpers.js';

function createNotifier(notify: Notifier['notify']): Notifier {
  return {
    name: 'discord',
    isConfigured: () => true,
    notify,
  };
}

describe('DurableEventProcessor', () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it('retries transient failures and eventually succeeds when a later attempt works', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const database = createTestD1Database(tempDatabase.databasePath);
    cleanups.push(() => {
      database.close();
    });

    const dispatcher = new NotificationDispatcher();
    const notify = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        provider: 'discord',
        error: 'Discord returned 500',
        failureClassification: FAILURE_CLASSIFICATIONS.TRANSIENT,
      } satisfies NotificationResult)
      .mockResolvedValueOnce({
        success: true,
        provider: 'discord',
      } satisfies NotificationResult);
    dispatcher.add(createNotifier(notify));

    const ledger = new D1DeliveryLedger(database);
    const processor = new DurableEventProcessor(ledger, dispatcher, {
      maxAttempts: 3,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
    });
    const event = createTestRepoEvent();

    await processor.enqueue(event, {
      deliveryId: 'delivery-auto-retry',
      repository: event.repository.fullName,
      sourceEventType: 'star',
    });
    await processor.drainDueDeliveries();

    expect(notify).toHaveBeenCalledTimes(2);
    await expect(ledger.getDelivery('delivery-auto-retry')).resolves.toMatchObject({
      status: 'succeeded',
      processingAttempts: 2,
      attempts: [
        expect.objectContaining({ success: false, deliveryAttempt: 1 }),
        expect.objectContaining({ success: true, deliveryAttempt: 2 }),
      ],
    });
  });

  it('marks repeated transient failures as terminal after the retry budget is exhausted', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const database = createTestD1Database(tempDatabase.databasePath);
    cleanups.push(() => {
      database.close();
    });

    const dispatcher = new NotificationDispatcher();
    const notify = vi.fn().mockResolvedValue({
      success: false,
      provider: 'discord',
      error: 'Discord returned 503',
      failureClassification: FAILURE_CLASSIFICATIONS.TRANSIENT,
    } satisfies NotificationResult);
    dispatcher.add(createNotifier(notify));

    const ledger = new D1DeliveryLedger(database);
    const processor = new DurableEventProcessor(ledger, dispatcher, {
      maxAttempts: 2,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
    });
    const event = createTestRepoEvent();

    await processor.enqueue(event, {
      deliveryId: 'delivery-max-attempts',
      repository: event.repository.fullName,
      sourceEventType: 'star',
    });
    await processor.drainDueDeliveries();

    expect(notify).toHaveBeenCalledTimes(2);
    await expect(ledger.getDelivery('delivery-max-attempts')).resolves.toMatchObject({
      status: 'failed',
      processingAttempts: 2,
      lastFailureClassification: FAILURE_CLASSIFICATIONS.TRANSIENT,
    });
  });

  it('prunes succeeded deliveries older than the retention window during a drain pass', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const database = createTestD1Database(tempDatabase.databasePath);
    cleanups.push(() => {
      database.close();
    });

    const ledger = new D1DeliveryLedger(database);
    const event = createTestRepoEvent();

    await ledger.persistAcceptedDelivery({
      deliveryId: 'delivery-old-succeeded',
      sourceEventType: 'star',
      repository: event.repository.fullName,
      event,
      maxAttempts: 5,
    });
    await ledger.markDeliverySucceeded(
      'delivery-old-succeeded',
      new Date('2026-02-01T00:00:00.000Z')
    );

    await ledger.persistAcceptedDelivery({
      deliveryId: 'delivery-recent-succeeded',
      sourceEventType: 'star',
      repository: event.repository.fullName,
      event,
      maxAttempts: 5,
    });
    await ledger.markDeliverySucceeded('delivery-recent-succeeded', new Date());

    const dispatcher = new NotificationDispatcher();
    dispatcher.add(
      createNotifier(
        vi
          .fn()
          .mockResolvedValue({ success: true, provider: 'discord' } satisfies NotificationResult)
      )
    );

    const processor = new DurableEventProcessor(ledger, dispatcher, {
      succeededRetentionDays: 7,
    });

    await processor.drainDueDeliveries({ pruneSucceededDeliveries: true });

    await expect(ledger.getDelivery('delivery-old-succeeded')).resolves.toBeNull();
    await expect(ledger.getDelivery('delivery-recent-succeeded')).resolves.not.toBeNull();
  });

  it('does not prune succeeded deliveries during the webhook drain path', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const database = createTestD1Database(tempDatabase.databasePath);
    cleanups.push(() => {
      database.close();
    });

    const ledger = new D1DeliveryLedger(database);
    const event = createTestRepoEvent();

    await ledger.persistAcceptedDelivery({
      deliveryId: 'delivery-old-succeeded',
      sourceEventType: 'star',
      repository: event.repository.fullName,
      event,
      maxAttempts: 5,
    });
    await ledger.markDeliverySucceeded(
      'delivery-old-succeeded',
      new Date('2026-02-01T00:00:00.000Z')
    );

    const dispatcher = new NotificationDispatcher();
    dispatcher.add(
      createNotifier(
        vi
          .fn()
          .mockResolvedValue({ success: true, provider: 'discord' } satisfies NotificationResult)
      )
    );

    const processor = new DurableEventProcessor(ledger, dispatcher, {
      succeededRetentionDays: 7,
    });

    await processor.drainDueDeliveries();

    await expect(ledger.getDelivery('delivery-old-succeeded')).resolves.not.toBeNull();
  });
});
