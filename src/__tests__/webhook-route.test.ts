import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { D1DeliveryLedger } from '../core/services/d1-delivery-ledger.js';
import { createExecutionContext, createTempDatabasePath, createTestEnv } from './test-helpers.js';

function createSignature(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function createWebhookPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'created',
    repository: {
      id: 1,
      name: 'repo',
      full_name: 'myorg/repo',
      owner: { login: 'myorg' },
      html_url: 'https://github.com/myorg/repo',
      description: null,
      stargazers_count: 1,
      forks_count: 0,
      language: 'TypeScript',
    },
    sender: {
      id: 1,
      login: 'octocat',
      avatar_url: 'https://avatars.githubusercontent.com/u/1',
      html_url: 'https://github.com/octocat',
    },
    ...overrides,
  });
}

describe('webhook route', () => {
  const secret = 'test-secret';
  const cleanups: (() => void)[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
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

  it('returns 400 when a supported event payload is missing required fields', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const env = createTestEnv(tempDatabase.databasePath);
    cleanups.push(() => {
      env.DB.close();
    });

    const payload = JSON.stringify({
      action: 'opened',
      repository: {
        full_name: 'otherorg/repo',
      },
    });
    const execution = createExecutionContext();

    const response = await createApp(env).fetch(
      new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'issues',
          'X-GitHub-Delivery': 'delivery-invalid-payload',
          'X-Hub-Signature-256': createSignature(payload, secret),
        },
        body: payload,
      }),
      env,
      execution.executionCtx
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: 'invalid_event_payload',
      message: 'Missing required fields: repository or sender',
    });
  });

  it('rejects oversized webhook payloads before parsing', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const env = createTestEnv(tempDatabase.databasePath, {
      WEBHOOK_MAX_BODY_BYTES: '10',
    });
    cleanups.push(() => {
      env.DB.close();
    });

    const payload = createWebhookPayload();
    const execution = createExecutionContext();

    const response = await createApp(env).fetch(
      new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'star',
          'X-GitHub-Delivery': 'delivery-oversized',
          'X-Hub-Signature-256': createSignature(payload, secret),
        },
        body: payload,
      }),
      env,
      execution.executionCtx
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: 'invalid_webhook_request',
    });
  });

  it('returns 500 when no notification providers are configured', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const env = createTestEnv(tempDatabase.databasePath, {
      DISCORD_WEBHOOK_URL: undefined,
    });
    cleanups.push(() => {
      env.DB.close();
    });

    const payload = createWebhookPayload();
    const execution = createExecutionContext();

    const response = await createApp(env).fetch(
      new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'star',
          'X-GitHub-Delivery': 'delivery-no-providers',
          'X-Hub-Signature-256': createSignature(payload, secret),
        },
        body: payload,
      }),
      env,
      execution.executionCtx
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: 'notification_providers_unavailable',
    });
  });

  it('persists accepted deliveries before returning success and defers Discord delivery to waitUntil', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const env = createTestEnv(tempDatabase.databasePath);
    cleanups.push(() => {
      env.DB.close();
    });

    let resolveFetch: (() => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = (): void => {
              resolve(
                new Response(null, {
                  status: 204,
                })
              );
            };
          })
      )
    );

    const app = createApp(env);
    const payload = createWebhookPayload();
    const execution = createExecutionContext();
    const response = await app.fetch(
      new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'star',
          'X-GitHub-Delivery': 'delivery-persisted',
          'X-Hub-Signature-256': createSignature(payload, secret),
        },
        body: payload,
      }),
      env,
      execution.executionCtx
    );

    expect(response.status).toBe(202);
    const ledger = new D1DeliveryLedger(env.DB);
    await expect(ledger.getDelivery('delivery-persisted')).resolves.toMatchObject({
      deliveryId: 'delivery-persisted',
      sourceEventType: 'star',
      status: 'processing',
    });

    resolveFetch?.();
    await execution.waitForBackground();

    await expect(ledger.getDelivery('delivery-persisted')).resolves.toMatchObject({
      status: 'succeeded',
    });
  });

  it('acknowledges duplicate deliveries without resending notifications', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);

    const firstEnv = createTestEnv(tempDatabase.databasePath);
    const secondEnv = createTestEnv(tempDatabase.databasePath);
    cleanups.push(() => {
      firstEnv.DB.close();
      secondEnv.DB.close();
    });

    const payload = createWebhookPayload();
    const firstExecution = createExecutionContext();
    const secondExecution = createExecutionContext();

    const firstResponse = await createApp(firstEnv).fetch(
      new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'star',
          'X-GitHub-Delivery': 'delivery-duplicate',
          'X-Hub-Signature-256': createSignature(payload, secret),
        },
        body: payload,
      }),
      firstEnv,
      firstExecution.executionCtx
    );
    await firstExecution.waitForBackground();

    const secondResponse = await createApp(secondEnv).fetch(
      new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'star',
          'X-GitHub-Delivery': 'delivery-duplicate',
          'X-Hub-Signature-256': createSignature(payload, secret),
        },
        body: payload,
      }),
      secondEnv,
      secondExecution.executionCtx
    );
    await secondExecution.waitForBackground();

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toMatchObject({
      success: true,
      duplicate: true,
      message: 'Duplicate delivery acknowledged',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
