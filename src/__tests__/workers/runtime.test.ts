import {
  applyD1Migrations,
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
  serializeRepoEvent,
} from '../../core/models/repo-event.js';
import { Redactor } from '../../core/security/redact.js';
import { D1DeliveryLedger } from '../../core/services/d1-delivery-ledger.js';
import { D1EventHistory } from '../../core/services/d1-event-history.js';
import { dueDigestWindow } from '../../core/services/digest.js';
import { DurableEventProcessor } from '../../core/services/durable-event-processor.js';
import { NotificationDispatcher } from '../../core/services/notification-dispatcher.js';
import worker from '../../index.js';
import { signAppJwt } from '../../providers/github/app-auth.js';

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
      private: false,
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
    await env.DB.prepare('DELETE FROM events').run();
    await env.DB.prepare('DELETE FROM digest_sends').run();
  });
  afterEach(() => {
    vi.restoreAllMocks();
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

  it('records an accepted delivery in the event history in the same D1 batch', async () => {
    await expect(
      ledger.persistAcceptedDelivery({
        deliveryId: 'recorded',
        sourceEventType: 'star',
        repository: event.repository.fullName,
        event,
        maxAttempts: 5,
      })
    ).resolves.toEqual({ outcome: 'accepted' });
    await expect(
      ledger.persistAcceptedDelivery({
        deliveryId: 'recorded',
        sourceEventType: 'star',
        repository: event.repository.fullName,
        event,
        maxAttempts: 5,
      })
    ).resolves.toEqual({ outcome: 'duplicate' });

    await expect(new D1EventHistory(env.DB).listRecentEvents()).resolves.toMatchObject([
      { deliveryId: 'recorded', event: { type: 'star.created' } },
    ]);
  });

  it('persists notification outcomes using real D1 batch and RETURNING semantics', async () => {
    const dispatcher = new NotificationDispatcher(new Redactor([]));
    dispatcher.add({
      name: 'test',
      isConfigured: () => true,
      notify: () => Promise.resolve({ success: true, provider: 'test' }),
      notifyDigest: () => Promise.reject(new Error('Not used in this test')),
      notifyAlert: () => Promise.reject(new Error('Not used in this test')),
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

  it("follows Morocco's clock changes with the runtime's time zone data", () => {
    // 09:00 in Morocco was 08:00 UTC in June 2026 (UTC+1) and is 09:00 UTC since the
    // move to UTC+0 on 20 September 2026.
    expect(
      dueDigestWindow(new Date('2026-06-15T08:00:00.000Z'), 'Africa/Casablanca', 9)
    ).toMatchObject({
      date: '2026-06-15',
    });
    expect(
      dueDigestWindow(new Date('2026-10-15T08:00:00.000Z'), 'Africa/Casablanca', 9)
    ).toBeNull();
    expect(dueDigestWindow(new Date('2026-10-15T09:00:00.000Z'), 'Africa/Casablanca', 9)).toEqual({
      period: 'daily',
      date: '2026-10-15',
      start: new Date('2026-10-14T09:00:00.000Z'),
      end: new Date('2026-10-15T09:00:00.000Z'),
    });
  });

  it('posts the daily digest from the scheduled handler at the configured local hour', async () => {
    // A stubbed Discord: this suite makes no outbound requests.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    await env.DB.prepare(
      `INSERT INTO events (delivery_id, event_type, repository, received_at, event_json)
       VALUES ('digest-star', 'star.created', 'myorg/repo', '2026-10-14T12:00:00.000Z', ?)`
    )
      .bind(serializeRepoEvent(event))
      .run();

    // wrangler.jsonc sets the digest to 09:00 Africa/Casablanca, which is UTC+0 since
    // 20 September 2026.
    const context = createExecutionContext();
    worker.scheduled(
      createScheduledController({
        scheduledTime: new Date('2026-10-15T09:00:00.000Z'),
        cron: '* * * * *',
      }),
      { ...env, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/0/test-only' } as typeof env,
      context
    );
    await waitOnExecutionContext(context);

    expect(fetchSpy).toHaveBeenCalledOnce();
    await expect(
      env.DB.prepare(
        'SELECT digest_id AS digestId, sent_at IS NOT NULL AS sent FROM digest_sends'
      ).all()
    ).resolves.toMatchObject({ results: [{ digestId: 'daily:2026-10-15', sent: 1 }] });
  });

  it('serves the public feed from cached D1 material and checks visibility on every response', async () => {
    // A stubbed GitHub: this suite makes no outbound requests.
    let repositoryIsPublic = true;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(
          repositoryIsPublic
            ? Response.json({ private: false })
            : Response.json({ message: 'Not Found' }, { status: 404 })
        )
      );
    // Today, so the stars stay inside the feed's 90-day window whenever this runs.
    const today = new Date().toISOString().slice(0, 10);
    for (const [deliveryId, receivedAt, count] of [
      ['star-1', `${today}T00:00:00.000Z`, 1],
      ['star-2', `${today}T00:00:00.001Z`, 2],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO events (delivery_id, event_type, repository, received_at, event_json)
         VALUES (?, 'star.created', 'myorg/repo', ?, ?)`
      )
        .bind(deliveryId, receivedAt, serializeRepoEvent({ ...event, star: { count } }))
        .run();
    }
    const getFeed = async (): Promise<Response> => {
      const context = createExecutionContext();
      const response = await worker.fetch(
        new Request('https://example.com/public/feed?limit=7'),
        env,
        context
      );
      await waitOnExecutionContext(context);
      return response;
    };

    const first = await getFeed();
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      events: [{ star: { count: 2 } }, { star: { count: 1 } }],
      starHistory: [{ repo: 'myorg/repo', points: [{ date: today, stars: 2 }] }],
    });

    // The material is cached: the next response is built without D1.
    await env.DB.prepare('DELETE FROM events').run();
    const cached = await getFeed();
    await expect(cached.json()).resolves.toMatchObject({ events: [{}, {}] });
    expect(cached.headers.get('Cache-Control')).toBe('no-store');
    expect(fetchSpy).toHaveBeenCalledOnce();

    repositoryIsPublic = false;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    await expect((await getFeed()).json()).resolves.toMatchObject({
      events: [],
      starHistory: [],
    });
  });

  it('signs a GitHub App JWT with a PKCS#8 key inside workerd', async () => {
    // A key generated for this test only: no real App key is involved.
    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify']
    );
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
    const base64 = btoa(String.fromCharCode(...pkcs8));
    const pem = `-----BEGIN PRIVATE KEY-----\n${base64.replace(/.{64}/g, '$&\n')}\n-----END PRIVATE KEY-----\n`;

    const jwt = await signAppJwt(77, pem, 1_800_000_000);

    const [header = '', payload = '', signature = ''] = jwt.split('.');
    const fromBase64Url = (part: string): Uint8Array<ArrayBuffer> =>
      Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (character) =>
        character.charCodeAt(0)
      );
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(payload)))).toEqual({
      iat: 1_800_000_000 - 60,
      exp: 1_800_000_000 + 540,
      iss: 77,
    });
    await expect(
      crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        keyPair.publicKey,
        fromBase64Url(signature),
        new TextEncoder().encode(`${header}.${payload}`)
      )
    ).resolves.toBe(true);
  });
});
