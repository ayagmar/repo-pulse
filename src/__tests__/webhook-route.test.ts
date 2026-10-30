import { createHmac, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
      private: false,
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

    const response = await createApp().fetch(
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

    const response = await createApp().fetch(
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

    const response = await createApp().fetch(
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

    const app = createApp();
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

  it('uses rotated webhook secrets and body limits with shared routes', async () => {
    const database = createTempDatabasePath();
    cleanups.push(database.cleanup);
    const env = createTestEnv(database.databasePath);
    cleanups.push(() => {
      env.DB.close();
    });
    const app = createApp();
    const payload = createWebhookPayload();
    const request = (signingSecret: string): Request =>
      new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'X-GitHub-Event': 'ping',
          'X-GitHub-Delivery': 'rotated-secret',
          'X-Hub-Signature-256': createSignature(payload, signingSecret),
        },
        body: payload,
      });
    expect((await app.fetch(request(secret), env)).status).toBe(200);
    env.GITHUB_WEBHOOK_SECRET = 'test-rotated-secret';
    expect((await app.fetch(request(secret), env)).status).toBe(401);
    expect((await app.fetch(request('test-rotated-secret'), env)).status).toBe(200);
    env.WEBHOOK_MAX_BODY_BYTES = '10';
    expect((await app.fetch(request('test-rotated-secret'), env)).status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
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

    const firstResponse = await createApp().fetch(
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

    const secondResponse = await createApp().fetch(
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

describe('webhook sources', () => {
  const secret = 'test-secret';
  const installationId = 4242;
  let privateKey: string;
  let database: ReturnType<typeof createTempDatabasePath>;
  let env: ReturnType<typeof createTestEnv>;
  let deliveryCount = 0;

  beforeAll(() => {
    privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    });
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    database = createTempDatabasePath();
    env = createTestEnv(database.databasePath, {
      LOG_LEVEL: 'info',
      GITHUB_APP_ID: String(1),
      GITHUB_APP_INSTALLATION_ID: String(installationId),
      GITHUB_APP_PRIVATE_KEY: privateKey,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    env.DB.close();
    database.cleanup();
  });

  /** A star from a repository webhook: no `installation`, and no `fork` either. */
  function repositoryStar(): Record<string, unknown> {
    return JSON.parse(createWebhookPayload()) as Record<string, unknown>;
  }

  function appStar(
    repositoryOverrides: Record<string, unknown> = {},
    installation: unknown = { id: installationId }
  ): Record<string, unknown> {
    const payload = repositoryStar();
    return {
      ...payload,
      installation,
      repository: {
        ...(payload.repository as Record<string, unknown>),
        fork: false,
        ...repositoryOverrides,
      },
    };
  }

  async function deliver(
    eventType: string,
    payload: unknown,
    options: { signingSecret?: string; deliveryId?: string } = {}
  ): Promise<{ status: number; body: { message?: string } }> {
    deliveryCount += 1;
    const text = JSON.stringify(payload);
    const execution = createExecutionContext();
    const response = await createApp().fetch(
      new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'X-GitHub-Event': eventType,
          'X-GitHub-Delivery': options.deliveryId ?? `delivery-${String(deliveryCount)}`,
          'X-Hub-Signature-256': createSignature(text, options.signingSecret ?? secret),
        },
        body: text,
      }),
      env,
      execution.executionCtx
    );
    await execution.waitForBackground();
    return { status: response.status, body: await response.json<{ message?: string }>() };
  }

  async function recordedDeliveries(): Promise<number> {
    return (await new D1DeliveryLedger(env.DB).getStats()).total;
  }

  it('acknowledges ping and installation events once signed, with or without a repository', async () => {
    await expect(deliver('ping', { zen: 'Keep it logically awesome.' })).resolves.toMatchObject({
      status: 200,
    });
    await expect(deliver('ping', repositoryStar())).resolves.toMatchObject({ status: 200 });
    await expect(
      deliver('ping', { zen: 'unsigned' }, { signingSecret: 'wrong-secret' })
    ).resolves.toMatchObject({ status: 401 });

    const info = vi.mocked(console.info);
    info.mockClear();
    await expect(
      deliver('installation_repositories', {
        action: 'added',
        installation: { id: installationId },
        repositories_added: [{ full_name: 'myorg/new-repo' }],
        repositories_removed: [{ full_name: 'myorg/old-repo' }],
      })
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      deliver('installation', { action: 'created', installation: { id: installationId } })
    ).resolves.toMatchObject({ status: 200 });

    expect(await recordedDeliveries()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    const logged = info.mock.calls.map(([entry]) => JSON.parse(String(entry)) as unknown);
    expect(logged).toContainEqual(
      expect.objectContaining({
        message: 'webhook.installation_changed',
        eventType: 'installation_repositories',
        added: ['myorg/new-repo'],
        removed: ['myorg/old-repo'],
      })
    );
  });

  it('admits only repository webhooks by default', async () => {
    await expect(deliver('star', appStar())).resolves.toMatchObject({
      status: 200,
      body: { message: "Event 'star' ignored: app deliveries are not admitted" },
    });
    await expect(deliver('star', repositoryStar())).resolves.toMatchObject({ status: 202 });
    expect(await recordedDeliveries()).toBe(1);
  });

  it('admits App deliveries only from the configured installation and public, non-fork repositories', async () => {
    env.GITHUB_WEBHOOK_SOURCES = 'app';
    const info = vi.mocked(console.info);
    info.mockClear();

    await expect(deliver('star', repositoryStar())).resolves.toMatchObject({ status: 200 });
    // Not admitted, so not refused for lacking a repository either.
    await expect(deliver('star', { sender: {} })).resolves.toMatchObject({ status: 200 });
    for (const rejected of [
      appStar({}, { id: installationId + 1 }),
      appStar({}, { id: String(installationId) }),
      appStar({}, null),
      appStar({ fork: true }),
      appStar({ fork: undefined }),
      appStar({ fork: null }),
      appStar({ private: true }),
      appStar({ private: undefined }),
      appStar({ private: 'false' }),
    ]) {
      await expect(deliver('star', rejected), JSON.stringify(rejected)).resolves.toMatchObject({
        status: 200,
      });
    }
    expect(await recordedDeliveries()).toBe(0);
    expect(
      info.mock.calls.filter(([entry]) => String(entry).includes('webhook.app_delivery_rejected'))
    ).toHaveLength(9);

    await expect(deliver('star', appStar())).resolves.toMatchObject({ status: 202 });
    expect(await recordedDeliveries()).toBe(1);
  });

  it('admits both sources during an overlap, as two deliveries', async () => {
    env.GITHUB_WEBHOOK_SOURCES = 'repository,app';

    await expect(deliver('star', repositoryStar())).resolves.toMatchObject({ status: 202 });
    await expect(deliver('star', appStar())).resolves.toMatchObject({ status: 202 });
    expect(await recordedDeliveries()).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('loses no occurrence across source changes that add before they remove', async () => {
    const overlapMs = 10 * 60_000;
    type Sources = 'repository' | 'app' | 'repository,app';
    const other = { repository: 'app', app: 'repository' } as const;

    for (let seed = 1; seed <= 8; seed += 1) {
      // Park-Miller: every product stays an exact integer.
      let state = seed;
      const random = (bound: number): number => {
        state = (state * 48_271) % 2_147_483_647;
        return state % bound;
      };

      // A cutover or rollback: add the other source at S, remove the first at R >= S + overlap.
      const initial = random(2) === 0 ? 'repository' : 'app';
      let single: 'repository' | 'app' = initial;
      const changes: { at: number; sources: Sources }[] = [{ at: 0, sources: initial }];
      let now = 0;
      for (let switches = 0; switches < 3; switches += 1) {
        now += random(30) * 60_000;
        changes.push({ at: now, sources: 'repository,app' });
        now += overlapMs + random(20) * 60_000;
        single = other[single];
        changes.push({ at: now, sources: single });
      }
      const sourcesAt = (time: number): Sources =>
        changes.filter((change) => change.at <= time).at(-1)?.sources ?? initial;

      // Each occurrence is sent by both sources, the two copies less than the overlap apart.
      for (let occurrence = 0; occurrence < 12; occurrence += 1) {
        const repositoryArrival = random(now + overlapMs);
        const appArrival = repositoryArrival + random(2 * overlapMs - 1) - (overlapMs - 1);
        const label = `seed ${String(seed)}, occurrence ${String(occurrence)}`;
        const statuses: number[] = [];
        for (const [payload, arrival] of [
          [repositoryStar(), repositoryArrival],
          [appStar(), appArrival],
        ] as const) {
          env.GITHUB_WEBHOOK_SOURCES = sourcesAt(arrival);
          statuses.push((await deliver('star', payload)).status);
        }
        expect(statuses, label).toContain(202);
      }
    }
  });

  it('drops an occurrence whose copies arrive further apart than the overlap (documented residual)', async () => {
    // Cutover: repository until S, both until R, then app. The App copy arrives before S
    // and the repository copy after R.
    env.GITHUB_WEBHOOK_SOURCES = 'repository';
    await expect(deliver('star', appStar())).resolves.toMatchObject({ status: 200 });
    env.GITHUB_WEBHOOK_SOURCES = 'app';
    await expect(deliver('star', repositoryStar())).resolves.toMatchObject({ status: 200 });
    expect(await recordedDeliveries()).toBe(0);
  });
});

describe('webhook gates before the body', () => {
  const secret = 'test-secret';
  let database: ReturnType<typeof createTempDatabasePath>;
  let env: ReturnType<typeof createTestEnv>;
  let bodyReads: number;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    database = createTempDatabasePath();
    env = createTestEnv(database.databasePath);
    bodyReads = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    env.DB.close();
    database.cleanup();
  });

  /** A body that counts every read, so a refused request can show it was never read. */
  function countedBody(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream(
      {
        pull(controller): void {
          bodyReads += 1;
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      },
      // Nothing is pulled until someone reads.
      { highWaterMark: 0 }
    );
  }

  async function post(
    headers: Record<string, string>,
    body: string = createWebhookPayload()
  ): Promise<{ status: number; body: unknown }> {
    const execution = createExecutionContext();
    const response = await createApp().fetch(
      new Request('https://example.com/webhook', {
        method: 'POST',
        headers,
        body: countedBody(body),
        duplex: 'half',
      } as RequestInit),
      env,
      execution.executionCtx
    );
    await execution.waitForBackground();
    return { status: response.status, body: await response.json() };
  }

  function signed(payload: string, eventType = 'star'): Record<string, string> {
    return {
      'X-GitHub-Event': eventType,
      'X-GitHub-Delivery': 'delivery-gated',
      'X-Hub-Signature-256': createSignature(payload, secret),
    };
  }

  it('refuses missing or malformed headers without reading the body, D1 or providers', async () => {
    const prepare = vi.spyOn(env.DB, 'prepare');
    const payload = createWebhookPayload();
    const valid = signed(payload);
    const hex = createSignature(payload, secret).slice('sha256='.length);
    const without = (name: string): Record<string, string> =>
      Object.fromEntries(Object.entries(valid).filter(([key]) => key !== name));
    const missingEvent = {
      status: 400,
      body: { code: 'invalid_webhook_request', message: 'Missing X-GitHub-Event header' },
    };
    const missingDelivery = {
      status: 400,
      body: { code: 'invalid_webhook_request', message: 'Missing X-GitHub-Delivery header' },
    };
    const badSignature = {
      status: 401,
      body: { code: 'invalid_webhook_signature', message: 'Invalid signature' },
    };

    for (const [headers, expected] of [
      [without('X-GitHub-Event'), missingEvent],
      [{ ...valid, 'X-GitHub-Event': '' }, missingEvent],
      [without('X-GitHub-Delivery'), missingDelivery],
      [{ ...valid, 'X-GitHub-Delivery': '' }, missingDelivery],
      [without('X-Hub-Signature-256'), badSignature],
      [{ ...valid, 'X-Hub-Signature-256': '' }, badSignature],
      [{ ...valid, 'X-Hub-Signature-256': hex }, badSignature],
      [{ ...valid, 'X-Hub-Signature-256': `sha1=${hex}` }, badSignature],
      [{ ...valid, 'X-Hub-Signature-256': `sha256=${hex.slice(1)}` }, badSignature],
      [{ ...valid, 'X-Hub-Signature-256': `sha256=${hex}00` }, badSignature],
      [{ ...valid, 'X-Hub-Signature-256': `sha256=${'z'.repeat(64)}` }, badSignature],
    ] as const) {
      await expect(post(headers, payload), JSON.stringify(headers)).resolves.toMatchObject(
        expected
      );
    }

    expect(bodyReads).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks the signature over the body once the headers pass', async () => {
    const payload = createWebhookPayload();
    const ping = JSON.stringify({ zen: 'Keep it logically awesome.' });
    const forged = { ...signed(payload), 'X-Hub-Signature-256': createSignature(payload, 'x') };

    await expect(post(forged, payload)).resolves.toMatchObject({ status: 401 });
    await expect(post(signed(ping, 'ping'), ping)).resolves.toMatchObject({ status: 200 });
    await expect(post(signed(payload), payload)).resolves.toMatchObject({ status: 202 });
    env.WEBHOOK_MAX_BODY_BYTES = '10';
    await expect(post(signed(payload), payload)).resolves.toMatchObject({ status: 413 });

    expect(bodyReads).toBe(4);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
