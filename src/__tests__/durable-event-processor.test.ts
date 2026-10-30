import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotificationResult, Notifier } from '../core/interfaces/notifier.js';
import { FAILURE_CLASSIFICATIONS } from '../core/models/failure-classification.js';
import type { RepoEvent } from '../core/models/repo-event.js';
import { Redactor } from '../core/security/redact.js';
import { D1DeliveryLedger } from '../core/services/d1-delivery-ledger.js';
import { D1EventHistory } from '../core/services/d1-event-history.js';
import type { D1DatabaseLike } from '../core/services/d1-types.js';
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
    notifyDigest: () => Promise.reject(new Error('Not used in this test')),
    notifyAlert: () => Promise.reject(new Error('Not used in this test')),
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

    const dispatcher = new NotificationDispatcher(new Redactor([]));
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

  it('retries only the providers that failed, without reposting to the ones that succeeded', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const database = createTestD1Database(tempDatabase.databasePath);
    cleanups.push(() => {
      database.close();
    });

    const discordNotify = vi
      .fn()
      .mockResolvedValue({ success: true, provider: 'discord' } satisfies NotificationResult);
    const slackNotify = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        provider: 'slack',
        error: 'Slack returned 503',
        failureClassification: FAILURE_CLASSIFICATIONS.TRANSIENT,
      } satisfies NotificationResult)
      .mockResolvedValueOnce({ success: true, provider: 'slack' } satisfies NotificationResult);
    const dispatcher = new NotificationDispatcher(new Redactor([]));
    dispatcher.add({
      name: 'discord',
      isConfigured: () => true,
      notify: discordNotify,
      notifyDigest: () => Promise.reject(new Error('Not used in this test')),
      notifyAlert: () => Promise.reject(new Error('Not used in this test')),
    });
    dispatcher.add({
      name: 'slack',
      isConfigured: () => true,
      notify: slackNotify,
      notifyDigest: () => Promise.reject(new Error('Not used in this test')),
      notifyAlert: () => Promise.reject(new Error('Not used in this test')),
    });

    const ledger = new D1DeliveryLedger(database);
    const processor = new DurableEventProcessor(ledger, dispatcher, {
      maxAttempts: 3,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
    });
    const event = createTestRepoEvent();

    await processor.enqueue(event, {
      deliveryId: 'delivery-partial-failure',
      repository: event.repository.fullName,
      sourceEventType: 'star',
    });
    await processor.drainDueDeliveries();

    expect(discordNotify).toHaveBeenCalledTimes(1);
    expect(slackNotify).toHaveBeenCalledTimes(2);
    await expect(ledger.getDelivery('delivery-partial-failure')).resolves.toMatchObject({
      status: 'succeeded',
      processingAttempts: 2,
    });
  });

  it('completes an interrupted delivery without reposting when every provider already succeeded', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const database = createTestD1Database(tempDatabase.databasePath);
    cleanups.push(() => {
      database.close();
    });

    const ledger = new D1DeliveryLedger(database);
    const event = createTestRepoEvent();
    await ledger.persistAcceptedDelivery({
      deliveryId: 'delivery-interrupted',
      sourceEventType: 'star',
      repository: event.repository.fullName,
      event,
      maxAttempts: 5,
    });
    // The Worker posted and recorded the attempt, then stopped before marking success.
    await ledger.claimNextPendingDelivery(new Date(), 0);
    await ledger.recordProviderAttempts('delivery-interrupted', 1, [
      { provider: 'discord', success: true, attemptedAt: new Date() },
    ]);

    const notify = vi.fn();
    const dispatcher = new NotificationDispatcher(new Redactor([]));
    dispatcher.add(createNotifier(notify));
    await new DurableEventProcessor(ledger, dispatcher).drainDueDeliveries();

    expect(notify).not.toHaveBeenCalled();
    await expect(ledger.getDelivery('delivery-interrupted')).resolves.toMatchObject({
      status: 'succeeded',
    });
  });

  it('marks repeated transient failures as terminal after the retry budget is exhausted', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const database = createTestD1Database(tempDatabase.databasePath);
    cleanups.push(() => {
      database.close();
    });

    const dispatcher = new NotificationDispatcher(new Redactor([]));
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
    await ledger.claimNextPendingDelivery(new Date(), 300_000);
    await ledger.markDeliverySucceeded(
      'delivery-old-succeeded',
      new Date('2026-02-01T00:00:00.000Z'),
      1
    );

    await ledger.persistAcceptedDelivery({
      deliveryId: 'delivery-recent-succeeded',
      sourceEventType: 'star',
      repository: event.repository.fullName,
      event,
      maxAttempts: 5,
    });
    await ledger.claimNextPendingDelivery(new Date(), 300_000);
    await ledger.markDeliverySucceeded('delivery-recent-succeeded', new Date(), 1);

    const dispatcher = new NotificationDispatcher(new Redactor([]));
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
    await ledger.claimNextPendingDelivery(new Date(), 300_000);
    await ledger.markDeliverySucceeded(
      'delivery-old-succeeded',
      new Date('2026-02-01T00:00:00.000Z'),
      1
    );

    const dispatcher = new NotificationDispatcher(new Redactor([]));
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

describe('DurableEventProcessor sender history', () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  function createProcessor(database: D1DatabaseLike): {
    processor: DurableEventProcessor;
    history: D1EventHistory;
  } {
    const history = new D1EventHistory(database);
    const dispatcher = new NotificationDispatcher(new Redactor([]));
    dispatcher.add(createNotifier(() => Promise.resolve({ success: true, provider: 'discord' })));
    return {
      processor: new DurableEventProcessor(
        new D1DeliveryLedger(database),
        dispatcher,
        {},
        {
          history,
          ignoredLogins: new Set(['owner-alt']),
        }
      ),
      history,
    };
  }

  function createDatabase(): ReturnType<typeof createTestD1Database> {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);
    const database = createTestD1Database(tempDatabase.databasePath);
    cleanups.push(() => {
      database.close();
    });
    return database;
  }

  function starBy(login: string, id = 1): RepoEvent {
    const event = createTestRepoEvent();
    return { ...event, sender: { ...event.sender, id, login } };
  }

  function enqueue(
    processor: DurableEventProcessor,
    deliveryId: string,
    event: RepoEvent
  ): ReturnType<DurableEventProcessor['enqueue']> {
    return processor.enqueue(event, {
      deliveryId,
      repository: event.repository.fullName,
      sourceEventType: 'star',
    });
  }

  async function storedHistory(history: D1EventHistory): Promise<Record<string, unknown>> {
    const events = await history.listRecentEvents();
    return Object.fromEntries(events.map((entry) => [entry.deliveryId, entry.event.senderHistory]));
  }

  it('records an outside person’s earlier events, and nothing for the owner or bots', async () => {
    const { processor, history } = createProcessor(createDatabase());

    await enqueue(processor, 'first', starBy('alice'));
    await enqueue(processor, 'second', starBy('alice'));
    // The repository owner, an ignored login in another case, a bot, and no user id.
    await enqueue(processor, 'owner', starBy('MyOrg', 2));
    await enqueue(processor, 'ignored', starBy('Owner-Alt', 3));
    await enqueue(processor, 'bot', starBy('dependabot[bot]', 4));
    await enqueue(processor, 'no-id', {
      ...starBy('ghost'),
      sender: { ...starBy('ghost').sender, id: null as unknown as number },
    });

    const stored = await storedHistory(history);
    expect(stored).toEqual({
      first: { firstSeenAt: null, priorEvents: 0, priorRepositories: 0, priorInRepository: 0 },
      second: {
        firstSeenAt: expect.any(String) as unknown,
        priorEvents: 1,
        priorRepositories: 1,
        priorInRepository: 1,
      },
      owner: undefined,
      ignored: undefined,
      bot: undefined,
      'no-id': undefined,
    });
  });

  it('accepts the event without history when the history cannot be read', async () => {
    const { processor, history } = createProcessor(createDatabase());
    vi.spyOn(history, 'readSenderHistory').mockRejectedValue(new Error('D1 unavailable'));

    await expect(enqueue(processor, 'first', starBy('alice'))).resolves.toEqual({
      outcome: 'accepted',
    });
    await expect(storedHistory(history)).resolves.toEqual({ first: undefined });
  });

  it('still fails the request when the event cannot be persisted', async () => {
    const database = createDatabase();
    const { processor } = createProcessor({
      ...database,
      batch: () => Promise.reject(new Error('D1 unavailable')),
    });

    await expect(enqueue(processor, 'first', starBy('alice'))).rejects.toThrow('D1 unavailable');
  });
});
