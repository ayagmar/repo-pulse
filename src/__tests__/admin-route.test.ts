import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { FAILURE_CLASSIFICATIONS } from '../core/models/failure-classification.js';
import { D1DeliveryLedger } from '../core/services/d1-delivery-ledger.js';
import {
  createExecutionContext,
  createTempDatabasePath,
  createTestEnv,
  createTestRepoEvent,
} from './test-helpers.js';

describe('admin routes', () => {
  const cleanups: (() => void)[] = [];

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 204,
        })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it('rejects unauthenticated health requests', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const env = createTestEnv(tempDatabase.databasePath);
    cleanups.push(() => {
      env.DB.close();
    });

    const response = await createApp(env).fetch(
      new Request('https://example.com/admin/health'),
      env,
      createExecutionContext().executionCtx
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="repo-pulse-admin"');
  });

  it('returns authenticated admin health details', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const env = createTestEnv(tempDatabase.databasePath);
    cleanups.push(() => {
      env.DB.close();
    });

    const response = await createApp(env).fetch(
      new Request('https://example.com/admin/health', {
        headers: {
          Authorization: 'Bearer admin-token',
        },
      }),
      env,
      createExecutionContext().executionCtx
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      status: 'ok',
      trackedDeliveries: 0,
    });
  });

  it('returns authenticated admin status details', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const env = createTestEnv(tempDatabase.databasePath);
    cleanups.push(() => {
      env.DB.close();
    });

    const response = await createApp(env).fetch(
      new Request('https://example.com/admin/status', {
        headers: {
          Authorization: 'Bearer admin-token',
        },
      }),
      env,
      createExecutionContext().executionCtx
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      name: 'repo-pulse',
      version: '1.0.0',
      status: 'running',
      deliveryLedger: {
        total: 0,
      },
    });
  });

  it('lists deliveries with status filters and returns delivery details', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const env = createTestEnv(tempDatabase.databasePath);
    cleanups.push(() => {
      env.DB.close();
    });

    const ledger = new D1DeliveryLedger(env.DB);
    const event = createTestRepoEvent();
    await ledger.persistAcceptedDelivery({
      deliveryId: 'delivery-failed',
      sourceEventType: 'star',
      repository: event.repository.fullName,
      event,
      maxAttempts: 5,
    });
    await ledger.recordProviderAttempts('delivery-failed', 1, [
      {
        provider: 'discord',
        success: false,
        error: 'Webhook failed',
        attemptedAt: new Date('2026-03-09T10:00:00.000Z'),
      },
    ]);
    await ledger.markDeliveryFailed(
      'delivery-failed',
      new Date(),
      'discord: Webhook failed',
      FAILURE_CLASSIFICATIONS.PERMANENT
    );

    const app = createApp(env);
    const execution = createExecutionContext();
    const listResponse = await app.fetch(
      new Request('https://example.com/admin/deliveries?status=failed', {
        headers: {
          Authorization: 'Bearer admin-token',
        },
      }),
      env,
      execution.executionCtx
    );

    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({
      deliveries: [
        expect.objectContaining({
          deliveryId: 'delivery-failed',
          status: 'failed',
        }),
      ],
    });

    const detailResponse = await app.fetch(
      new Request('https://example.com/admin/deliveries/delivery-failed', {
        headers: {
          Authorization: 'Bearer admin-token',
        },
      }),
      env,
      execution.executionCtx
    );

    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      deliveryId: 'delivery-failed',
      attempts: [
        expect.objectContaining({
          provider: 'discord',
          success: false,
          error: 'Webhook failed',
        }),
      ],
    });
  });

  it('serves authenticated OpenAPI and Swagger docs', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const env = createTestEnv(tempDatabase.databasePath);
    cleanups.push(() => {
      env.DB.close();
    });

    const app = createApp(env);
    const execution = createExecutionContext();

    const openApiResponse = await app.fetch(
      new Request('https://example.com/admin/openapi.json', {
        headers: {
          Authorization: 'Bearer admin-token',
        },
      }),
      env,
      execution.executionCtx
    );

    expect(openApiResponse.status).toBe(200);
    await expect(openApiResponse.json()).resolves.toMatchObject({
      openapi: '3.0.3',
      info: {
        title: 'Repo Pulse API',
      },
    });

    const docsResponse = await app.fetch(
      new Request('https://example.com/admin/docs', {
        headers: {
          Authorization: 'Bearer admin-token',
        },
      }),
      env,
      execution.executionCtx
    );

    expect(docsResponse.status).toBe(200);
    await expect(docsResponse.text()).resolves.toContain('SwaggerUIBundle');
  });

  it('retries failed deliveries through the admin endpoint without losing attempt history', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const env = createTestEnv(tempDatabase.databasePath);
    cleanups.push(() => {
      env.DB.close();
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 204,
        })
      )
    );

    const app = createApp(env);
    const ledger = new D1DeliveryLedger(env.DB);
    const event = createTestRepoEvent();
    await ledger.persistAcceptedDelivery({
      deliveryId: 'delivery-retry',
      sourceEventType: 'star',
      repository: event.repository.fullName,
      event,
      maxAttempts: 5,
    });
    await ledger.recordProviderAttempts('delivery-retry', 1, [
      {
        provider: 'discord',
        success: false,
        error: 'Discord unavailable',
        attemptedAt: new Date('2026-03-09T10:00:00.000Z'),
      },
    ]);
    await ledger.markDeliveryFailed(
      'delivery-retry',
      new Date('2026-03-09T10:00:01.000Z'),
      'discord: Discord unavailable',
      FAILURE_CLASSIFICATIONS.PERMANENT
    );

    const retryExecution = createExecutionContext();
    const retryResponse = await app.fetch(
      new Request('https://example.com/admin/deliveries/delivery-retry/retry', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
        },
      }),
      env,
      retryExecution.executionCtx
    );

    expect(retryResponse.status).toBe(202);
    await retryExecution.waitForBackground();

    await expect(ledger.getDelivery('delivery-retry')).resolves.toMatchObject({
      status: 'succeeded',
      attempts: [
        expect.objectContaining({ success: false, deliveryAttempt: 1 }),
        expect.objectContaining({ success: true, deliveryAttempt: 1 }),
      ],
    });
  });
});
