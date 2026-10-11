import { applyD1Migrations } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
} from '../../core/models/repo-event.js';
import { D1DeliveryLedger } from '../../core/services/d1-delivery-ledger.js';
import { DurableEventProcessor } from '../../core/services/durable-event-processor.js';
import { NotificationDispatcher } from '../../core/services/notification-dispatcher.js';

// Local workerd/D1 integration only: no remote bindings, secrets or outbound requests.
describe('Workers runtime integration', () => {
  const ledger = new D1DeliveryLedger(env.DB);
  const event = createRepoEvent(REPO_EVENT_TYPES.STAR_CREATED, {
    action: REPO_EVENT_ACTIONS.CREATED,
    repository: {
      id: 1,
      name: 'repo',
      fullName: 'myorg/repo',
      owner: 'myorg',
      url: 'https://github.com/myorg/repo',
      description: null,
      stars: 1,
      forks: 0,
      language: 'TypeScript',
    },
    sender: {
      id: 1,
      login: 'octocat',
      avatarUrl: 'https://example.com/avatar',
      url: 'https://github.com/octocat',
    },
    star: { count: 1 },
  });

  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM deliveries').run();
  });

  it('protects the admin surface through the exported Worker', async () => {
    const denied = await exports.default.fetch(new Request('https://example.com/admin/status'));
    expect(denied.status).toBe(401);
    const allowed = await exports.default.fetch(
      new Request('https://example.com/admin/status', {
        headers: { Authorization: 'Bearer admin-token' },
      })
    );
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ deliveryLedger: { total: 0 } });
  });

  it('verifies original webhook bytes before decoding JSON, including a UTF-8 BOM', async () => {
    const text = JSON.stringify({ repository: { full_name: 'myorg/repo' }, sender: {} });
    const encoded = new TextEncoder().encode(text);
    const body = new Uint8Array(encoded.length + 3);
    body.set([0xef, 0xbb, 0xbf]);
    body.set(encoded, 3);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('test-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
    const signature = `sha256=${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const headers = {
      'X-GitHub-Event': 'ping',
      'X-GitHub-Delivery': 'bom',
      'X-Hub-Signature-256': signature,
    };
    const valid = await exports.default.fetch(
      new Request('https://example.com/webhook', {
        method: 'POST',
        headers,
        body,
      })
    );
    expect(valid.status).toBe(200);
    const changed = await exports.default.fetch(
      new Request('https://example.com/webhook', {
        method: 'POST',
        headers,
        body: encoded,
      })
    );
    expect(changed.status).toBe(401);
  });

  it('rejects oversized streamed bodies even when Content-Length understates their size', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array(524_288));
        controller.enqueue(new Uint8Array(524_289));
        controller.close();
      },
    });
    const response = await exports.default.fetch(
      new Request('https://example.com/webhook', {
        method: 'POST',
        headers: { 'Content-Length': '10' },
        body,
      })
    );
    expect(response.status).toBe(413);
    await expect(ledger.getStats()).resolves.toMatchObject({ total: 0 });
  });

  it('claims a persisted delivery only once when two D1 consumers race', async () => {
    await ledger.persistAcceptedDelivery({
      deliveryId: 'race',
      sourceEventType: 'star',
      repository: event.repository.fullName,
      event,
      maxAttempts: 5,
    });
    const claims = await Promise.all([
      ledger.claimNextPendingDelivery(new Date(), 1000),
      ledger.claimNextPendingDelivery(new Date(), 1000),
    ]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    await expect(ledger.getDelivery('race')).resolves.toMatchObject({ processingAttempts: 1 });
  });

  it('persists notification outcomes using real D1 batch and RETURNING semantics', async () => {
    const dispatcher = new NotificationDispatcher();
    dispatcher.add({
      name: 'test',
      isConfigured: () => true,
      notify: () => Promise.resolve({ success: true, provider: 'test' }),
    });
    const processor = new DurableEventProcessor(ledger, dispatcher);
    await processor.enqueue(event, {
      deliveryId: 'complete',
      sourceEventType: 'star',
      repository: event.repository.fullName,
    });
    await processor.drainDueDeliveries();
    await expect(ledger.getDelivery('complete')).resolves.toMatchObject({
      status: 'succeeded',
      processingAttempts: 1,
      providerAttemptCount: 1,
    });
  });
});
