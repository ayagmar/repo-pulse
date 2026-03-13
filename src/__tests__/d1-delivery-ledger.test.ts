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
      FAILURE_CLASSIFICATIONS.PERMANENT
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
