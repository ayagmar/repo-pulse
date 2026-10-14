import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAILURE_CLASSIFICATIONS } from '../core/models/failure-classification.js';
import { D1DeliveryLedger } from '../core/services/d1-delivery-ledger.js';
import { DurableEventProcessor } from '../core/services/durable-event-processor.js';
import { NotificationDispatcher } from '../core/services/notification-dispatcher.js';
import {
  createTempDatabasePath,
  createTestD1Database,
  createTestRepoEvent,
} from './test-helpers.js';

describe('delivery recovery and ownership', () => {
  let temporary: ReturnType<typeof createTempDatabasePath>;
  let db: ReturnType<typeof createTestD1Database>;
  let ledger: D1DeliveryLedger;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-10T00:00:00Z'));
    temporary = createTempDatabasePath();
    db = createTestD1Database(temporary.databasePath);
    ledger = new D1DeliveryLedger(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    db.close();
    temporary.cleanup();
  });

  async function enqueue(deliveryId = 'recovery', maxAttempts = 5): Promise<void> {
    const event = createTestRepoEvent();
    await ledger.persistAcceptedDelivery({
      deliveryId,
      sourceEventType: 'star',
      repository: event.repository.fullName,
      event,
      maxAttempts,
    });
  }

  it.each(['success', 'failure', 'retry'] as const)(
    'ignores a stale processor reporting %s after a newer attempt has claimed the delivery',
    async (outcome) => {
      await enqueue();
      await ledger.claimNextPendingDelivery(new Date(), 1000);
      vi.setSystemTime(Date.now() + 1001);
      await ledger.requeueExpiredProcessingDeliveries(new Date());
      await ledger.claimNextPendingDelivery(new Date(), 1000);
      if (outcome === 'success') {
        await ledger.markDeliverySucceeded('recovery', new Date(), 1);
      } else if (outcome === 'failure') {
        await ledger.markDeliveryFailed(
          'recovery',
          new Date(),
          'stale',
          FAILURE_CLASSIFICATIONS.PERMANENT,
          1
        );
      } else {
        await ledger.rescheduleDelivery(
          'recovery',
          new Date(),
          'stale',
          FAILURE_CLASSIFICATIONS.TRANSIENT,
          1
        );
      }
      await expect(ledger.getDelivery('recovery')).resolves.toMatchObject({
        status: 'processing',
        processingAttempts: 2,
      });
      await ledger.markDeliverySucceeded('recovery', new Date(), 2);
      await expect(ledger.getDelivery('recovery')).resolves.toMatchObject({ status: 'succeeded' });
    }
  );

  it('stops expired leases at the retry budget, but allows an explicit admin retry', async () => {
    await enqueue('recovery', 1);
    await ledger.claimNextPendingDelivery(new Date(), 1000);
    vi.setSystemTime(Date.now() + 1001);
    await ledger.requeueExpiredProcessingDeliveries(new Date());
    await expect(ledger.claimNextPendingDelivery(new Date(), 1000)).resolves.toBeNull();
    await expect(ledger.getDelivery('recovery')).resolves.toMatchObject({
      status: 'failed',
      processingAttempts: 1,
      nextAttemptAt: null,
      lastFailureClassification: FAILURE_CLASSIFICATIONS.TRANSIENT,
    });
    await expect(ledger.retryFailedDelivery('recovery', 2)).resolves.toEqual({
      outcome: 'retry_queued',
    });
    await expect(ledger.claimNextPendingDelivery(new Date(), 1000)).resolves.toMatchObject({
      processingAttempt: 2,
      maxAttempts: 3,
    });
  });

  it('finalizes exhausted pending rows left by the previous lease recovery behavior', async () => {
    await enqueue('legacy', 1);
    await db.exec("UPDATE deliveries SET processing_attempts = 1 WHERE delivery_id = 'legacy'");
    await ledger.requeueExpiredProcessingDeliveries(new Date());
    await expect(ledger.getDelivery('legacy')).resolves.toMatchObject({
      status: 'failed',
      nextAttemptAt: null,
    });
    await expect(ledger.claimNextPendingDelivery(new Date(), 1000)).resolves.toBeNull();
  });

  it('queues one admin retry when two requests race, without resetting a live attempt', async () => {
    await enqueue();
    await ledger.claimNextPendingDelivery(new Date(), 1000);
    await ledger.markDeliveryFailed(
      'recovery',
      new Date(),
      'failed',
      FAILURE_CLASSIFICATIONS.PERMANENT,
      1
    );
    const results = await Promise.all([
      ledger.retryFailedDelivery('recovery', 5),
      ledger.retryFailedDelivery('recovery', 5),
    ]);
    expect(results.filter((result) => result.outcome === 'retry_queued')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'not_retryable')).toHaveLength(1);
    await ledger.claimNextPendingDelivery(new Date(), 1000);
    await expect(ledger.retryFailedDelivery('recovery', 5)).resolves.toEqual({
      outcome: 'not_retryable',
      status: 'processing',
    });
    await expect(ledger.getDelivery('recovery')).resolves.toMatchObject({
      status: 'processing',
      processingAttempts: 2,
      maxAttempts: 6,
    });
  });

  it('recovers after a D1 outcome-write failure instead of making a delivery permanently failed', async () => {
    await enqueue();
    const dispatcher = new NotificationDispatcher();
    dispatcher.add({
      name: 'discord',
      isConfigured: () => true,
      notify: () => Promise.resolve({ success: true, provider: 'discord' }),
      notifyDigest: () => Promise.reject(new Error('Not used in this test')),
      notifyAlert: () => Promise.reject(new Error('Not used in this test')),
    });
    const processor = new DurableEventProcessor(ledger, dispatcher, { processingLeaseMs: 1000 });
    vi.spyOn(db, 'batch').mockRejectedValueOnce(new Error('D1 unavailable'));
    await expect(processor.drainDueDeliveries()).rejects.toThrow('D1 unavailable');
    await expect(ledger.getDelivery('recovery')).resolves.toMatchObject({ status: 'processing' });
    vi.setSystemTime(Date.now() + 1001);
    await processor.drainDueDeliveries();
    await expect(ledger.getDelivery('recovery')).resolves.toMatchObject({
      status: 'succeeded',
      processingAttempts: 2,
    });
  });

  it('lists newest deliveries deterministically with per-delivery counts and multiple status filters', async () => {
    for (const id of ['a', 'b', 'c']) await enqueue(id);
    await db.exec("UPDATE deliveries SET status = 'failed' WHERE delivery_id IN ('a', 'c')");
    await ledger.recordProviderAttempts('c', 1, [
      { provider: 'discord', success: true, attemptedAt: new Date() },
      { provider: 'discord', success: false, attemptedAt: new Date(), error: 'failed' },
    ]);
    const rows = await ledger.listDeliveries(['pending', 'failed'], 2);
    expect(rows.map((row) => [row.deliveryId, row.providerAttemptCount])).toEqual([
      ['c', 2],
      ['b', 0],
    ]);
    expect((await ledger.listDeliveries(['pending'])).map((row) => row.deliveryId)).toEqual(['b']);
    expect(await ledger.listDeliveries(['succeeded'])).toEqual([]);
  });
});
