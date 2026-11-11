import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAILURE_CLASSIFICATIONS } from '../core/models/failure-classification.js';
import { D1DeliveryLedger } from '../core/services/d1-delivery-ledger.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../core/services/d1-types.js';
import {
  createTempDatabasePath,
  createTestD1Database,
  createTestRepoEvent,
} from './test-helpers.js';

describe('D1DeliveryLedger', () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it('persists accepted deliveries and deduplicates by delivery id', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const database = createTestD1Database(tempDatabase.databasePath);
    cleanups.push(() => {
      database.close();
    });

    const ledger = new D1DeliveryLedger(database);
    const event = createTestRepoEvent();

    await expect(
      ledger.persistAcceptedDelivery({
        deliveryId: 'delivery-1',
        sourceEventType: 'star',
        repository: event.repository.fullName,
        event,
        maxAttempts: 5,
      })
    ).resolves.toEqual({ outcome: 'accepted' });

    await expect(
      ledger.persistAcceptedDelivery({
        deliveryId: 'delivery-1',
        sourceEventType: 'star',
        repository: event.repository.fullName,
        event,
        maxAttempts: 5,
      })
    ).resolves.toEqual({ outcome: 'duplicate' });
  });

  it('queues each delivery id at most once, with its first event, across prunes and crashes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    cleanups.push(() => {
      vi.useRealTimers();
    });
    for (let seed = 1; seed <= 8; seed += 1) {
      const tempDatabase = createTempDatabasePath();
      cleanups.push(tempDatabase.cleanup);
      const database = createTestD1Database(tempDatabase.databasePath);
      cleanups.push(() => {
        database.close();
      });
      // Every delivery row ever created, whatever pruned it since.
      await database.exec(`
        CREATE TABLE queued_log (delivery_id TEXT NOT NULL);
        CREATE TRIGGER log_queued AFTER INSERT ON deliveries
        BEGIN INSERT INTO queued_log VALUES (NEW.delivery_id); END;
      `);
      let crash: 'none' | 'before_commit' | 'after_commit' = 'none';
      const crashing: D1DatabaseLike = {
        prepare: (query) => database.prepare(query),
        exec: (sql) => database.exec(sql),
        batch: async (statements) => {
          if (crash === 'before_commit') {
            // The Worker stops inside the batch: D1 rolls the whole batch back.
            return database.batch([
              ...statements,
              database.prepare('INSERT INTO deliveries (delivery_id) VALUES (NULL)'),
            ]);
          }
          const results = await database.batch(statements);
          if (crash === 'after_commit') {
            // The batch committed, but the Worker stopped before it could answer.
            throw new Error('Network connection lost');
          }
          return results;
        },
      };
      const ledger = new D1DeliveryLedger(crashing);

      let state = seed;
      const random = (bound: number): number => {
        state = (state * 48_271) % 2_147_483_647;
        return state % bound;
      };
      /** The star count of the event first committed under each delivery id. */
      const firstCommitted = new Map<string, number>();
      vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));

      for (let step = 0; step < 80; step += 1) {
        vi.setSystemTime(new Date(Date.now() + 1000));
        const action = random(10);
        if (action < 6) {
          // A delivery, or GitHub redelivering one, maybe normalized differently now.
          const deliveryId = `delivery-${String(random(4))}`;
          const count = random(1000);
          const event = { ...createTestRepoEvent(), star: { count } };
          const roll = random(6);
          crash = roll === 0 ? 'before_commit' : roll === 1 ? 'after_commit' : 'none';
          const isNew = !firstCommitted.has(deliveryId);
          const result = await ledger
            .persistAcceptedDelivery({
              deliveryId,
              sourceEventType: 'star',
              repository: event.repository.fullName,
              event,
              maxAttempts: 5,
            })
            .catch(() => 'crashed' as const);
          const crashed = crash;
          crash = 'none';
          if (isNew && crashed !== 'before_commit') {
            firstCommitted.set(deliveryId, count);
          }
          if (result !== 'crashed') {
            expect(result, `seed ${String(seed)}, step ${String(step)}`).toEqual({
              outcome: isNew ? 'accepted' : 'duplicate',
            });
          }
        } else if (action < 8) {
          // Cron sends whatever is due.
          for (;;) {
            const claimed = await ledger.claimNextPendingDelivery(new Date(), 300_000);
            if (!claimed) {
              break;
            }
            await ledger.markDeliverySucceeded(
              claimed.deliveryId,
              new Date(),
              claimed.processingAttempt
            );
          }
        } else {
          // Retention prunes every succeeded delivery.
          await ledger.pruneSucceededDeliveries(new Date(Date.now() + 1));
        }

        const queued = await database
          .prepare(
            'SELECT delivery_id AS id, COUNT(*) AS times FROM queued_log GROUP BY delivery_id'
          )
          .all<{ id: string; times: number }>();
        expect(
          queued.results.filter((row) => row.times > 1),
          `seed ${String(seed)}, step ${String(step)}`
        ).toEqual([]);
        expect(queued.results.map((row) => row.id).sort()).toEqual(
          [...firstCommitted.keys()].sort()
        );
        const stored = await database
          .prepare(
            "SELECT delivery_id AS id, json_extract(event_json, '$.star.count') AS count FROM events"
          )
          .all<{ id: string; count: number }>();
        expect(new Map(stored.results.map((row) => [row.id, row.count]))).toEqual(firstCommitted);
      }
    }
  });

  it('returns delivery details including persisted provider attempts', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const database = createTestD1Database(tempDatabase.databasePath);
    cleanups.push(() => {
      database.close();
    });

    const ledger = new D1DeliveryLedger(database);
    const event = createTestRepoEvent();

    await ledger.persistAcceptedDelivery({
      deliveryId: 'delivery-details',
      sourceEventType: 'star',
      repository: event.repository.fullName,
      event,
      maxAttempts: 5,
    });
    await ledger.claimNextPendingDelivery(new Date(), 300_000);
    await ledger.recordProviderAttempts('delivery-details', 1, [
      {
        provider: 'discord',
        success: false,
        error: 'Webhook failed',
        attemptedAt: new Date('2026-03-09T10:00:00.000Z'),
      },
    ]);
    await ledger.markDeliveryFailed(
      'delivery-details',
      new Date('2026-03-09T10:00:01.000Z'),
      'discord: Webhook failed',
      FAILURE_CLASSIFICATIONS.PERMANENT,
      1
    );

    await expect(ledger.getDelivery('delivery-details')).resolves.toMatchObject({
      deliveryId: 'delivery-details',
      status: 'failed',
      attempts: [
        expect.objectContaining({
          provider: 'discord',
          success: false,
          error: 'Webhook failed',
          deliveryAttempt: 1,
        }),
      ],
    });
  });

  it('requeues processing rows whose lease has expired', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const database = createTestD1Database(tempDatabase.databasePath);
    cleanups.push(() => {
      database.close();
    });

    const ledger = new D1DeliveryLedger(database);
    const event = createTestRepoEvent();

    await ledger.persistAcceptedDelivery({
      deliveryId: 'delivery-stale',
      sourceEventType: 'star',
      repository: event.repository.fullName,
      event,
      maxAttempts: 5,
    });

    await database.exec(`
      UPDATE deliveries
      SET status = 'processing',
          next_attempt_at = NULL,
          processing_started_at = '2026-03-09T10:00:00.000Z',
          lease_expires_at = '2026-03-09T10:00:01.000Z'
      WHERE delivery_id = 'delivery-stale'
    `);

    await expect(
      ledger.requeueExpiredProcessingDeliveries(new Date('2026-03-09T10:00:02.000Z'))
    ).resolves.toBe(1);

    await expect(ledger.getDelivery('delivery-stale')).resolves.toMatchObject({
      deliveryId: 'delivery-stale',
      status: 'pending',
      lastError: 'Processing interrupted before completion',
    });
  });

  it('batches provider attempt inserts into a single D1 round-trip', async () => {
    class FakePreparedStatement implements D1PreparedStatementLike {
      bind(..._values: unknown[]): D1PreparedStatementLike {
        return this;
      }

      first<Row>(): Promise<Row | null> {
        return Promise.resolve(null);
      }

      // The fake statement mirrors the generic D1 API contract used by the ledger.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
      all<Row>(): Promise<{ results: Row[]; success: boolean; meta: { changes: number } }> {
        return Promise.resolve({
          results: [],
          success: true,
          meta: { changes: 0 },
        });
      }

      run(): Promise<{ success: boolean; meta: { changes: number; last_row_id?: number } }> {
        return Promise.resolve({
          success: true,
          meta: { changes: 1 },
        });
      }
    }

    const batch = vi.fn().mockResolvedValue([
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 1 } },
    ]);
    const prepare = vi.fn(() => new FakePreparedStatement());
    const db: D1DatabaseLike = {
      prepare,
      batch,
      exec: () => Promise.resolve(undefined),
    };

    const ledger = new D1DeliveryLedger(db);

    await ledger.recordProviderAttempts('delivery-batched', 2, [
      {
        provider: 'discord',
        success: false,
        error: 'Webhook failed',
        attemptedAt: new Date('2026-03-09T10:00:00.000Z'),
      },
      {
        provider: 'telegram',
        success: true,
        attemptedAt: new Date('2026-03-09T10:00:01.000Z'),
      },
    ]);

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledWith(expect.arrayContaining([expect.any(FakePreparedStatement)]));
  });
});
