import { createHmac, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, InvocationInsights, sendDueDigests } from '../app.js';
import { Redactor } from '../core/security/redact.js';
import { D1DeliveryLedger } from '../core/services/d1-delivery-ledger.js';
import { NotificationDispatcher } from '../core/services/notification-dispatcher.js';
import { GitHubAppAuth, READ_TOKEN } from '../providers/github/app-auth.js';
import {
  createExecutionContext,
  createTempDatabasePath,
  createTestEnv,
  createTestRepoEvent,
} from './test-helpers.js';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});
/** A line from the middle of the key: a fragment of it must not leak either. */
const keyLine = privateKey.split('\n')[5] ?? '';

const sentinel = {
  webhookUrl: 'https://discord.com/api/webhooks/0/test-only',
  adminToken: 'test-admin-sentinel-4f1c9a7e',
  // Shaped like a real installation token, and assembled so this file holds none.
  installationToken: ['ghs', 'Sentinel0123456789abcdefghijklmnopq'].join('_'),
  keyLine,
};

/** Everything logged so far, as one string. */
function logged(): string {
  return [console.debug, console.info, console.warn, console.error, console.log]
    .flatMap((method) => vi.mocked(method).mock.calls)
    .map((args) => args.map(String).join(' '))
    .join('\n');
}

function expectNoSentinel(text: string, jwt?: string): void {
  for (const [name, value] of Object.entries(sentinel)) {
    expect(text, name).not.toContain(value);
  }
  if (jwt !== undefined) {
    expect(text, 'jwt').not.toContain(jwt);
  }
  // The webhook token even without the rest of the URL.
  expect(text).not.toContain('webhooks/0/test-only');
}

/** An exception whose message, and so its stack, quotes every sentinel. */
function leakyError(jwt = ''): Error {
  const error = new TypeError(
    `fetch to ${sentinel.webhookUrl} failed: Authorization: Bearer ${sentinel.installationToken} ${jwt} admin=${sentinel.adminToken} key=${sentinel.keyLine}`
  );
  error.name = 'TypeError';
  return error;
}

function leakyBody(jwt = ''): string {
  return JSON.stringify({
    message: `Bad credentials ${jwt} ${sentinel.installationToken} ${sentinel.adminToken} ${sentinel.keyLine} ${sentinel.webhookUrl}`,
  });
}

describe('secrets in failures', () => {
  const cleanups: (() => void)[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  function createEnv(
    overrides: Parameters<typeof createTestEnv>[1] = {}
  ): ReturnType<typeof createTestEnv> {
    const database = createTempDatabasePath();
    cleanups.push(database.cleanup);
    // The App is configured, so its key is among the secrets to redact.
    const env = createTestEnv(database.databasePath, {
      GITHUB_APP_INSTALLATION_ID: String(1),
      LOG_LEVEL: 'debug',
      ADMIN_API_TOKEN: sentinel.adminToken,
      DISCORD_WEBHOOK_URL: sentinel.webhookUrl,
      DIGEST_TIME_ZONE: 'UTC',
      DIGEST_HOUR: '9',
      GITHUB_APP_ID: String(1),
      GITHUB_APP_PRIVATE_KEY: privateKey,
      ...overrides,
    });
    cleanups.push(() => {
      env.DB.close();
    });
    return env;
  }

  async function storedErrors(env: ReturnType<typeof createTestEnv>): Promise<string> {
    const deliveries = await env.DB.prepare('SELECT last_error FROM deliveries').all<{
      last_error: string | null;
    }>();
    const attempts = await env.DB.prepare('SELECT error_message FROM provider_attempts').all<{
      error_message: string | null;
    }>();
    return [
      ...deliveries.results.map((row) => row.last_error),
      ...attempts.results.map((row) => row.error_message),
    ].join('\n');
  }

  it('keeps them out of logs and stored outcomes when Discord fails', async () => {
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
    const env = createEnv();
    const app = createApp();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(leakyError())
      .mockResolvedValueOnce(new Response(leakyBody(), { status: 500 }))
      .mockResolvedValueOnce(new Response(leakyBody(), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    for (const deliveryId of ['thrown', 'server-error', 'rejected']) {
      const payload = JSON.stringify({
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
      });
      const execution = createExecutionContext();
      const response = await app.fetch(
        new Request('https://example.com/webhook', {
          method: 'POST',
          headers: {
            'X-GitHub-Event': 'star',
            'X-GitHub-Delivery': deliveryId,
            'X-Hub-Signature-256': `sha256=${createHmac('sha256', 'test-secret').update(payload).digest('hex')}`,
          },
          body: payload,
        }),
        env,
        execution.executionCtx
      );
      expect(response.status).toBe(202);
      expectNoSentinel(await response.text());
      await execution.waitForBackground();
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const stored = await storedErrors(env);
    expect(stored).toContain('Discord request failed: network error');
    expect(stored).toContain('Discord request failed with 500: Bad credentials');
    expect(stored).toContain('[redacted]');
    expectNoSentinel(stored);
    expectNoSentinel(logged());

    // The admin API serves the stored outcomes.
    const admin = await app.fetch(
      new Request('https://example.com/admin/deliveries/rejected', {
        headers: { Authorization: `Bearer ${sentinel.adminToken}` },
      }),
      env
    );
    expect(admin.status).toBe(200);
    expectNoSentinel(await admin.text());
  });

  it('keeps them out of a thrown notifier error', async () => {
    const dispatcher = new NotificationDispatcher(
      new Redactor([sentinel.adminToken, sentinel.webhookUrl, privateKey])
    );
    dispatcher.add({
      name: 'throws',
      isConfigured: () => true,
      notify: () => Promise.reject(leakyError()),
      notifyDigest: () => Promise.reject(leakyError()),
      notifyAlert: () => Promise.reject(leakyError()),
    });

    const [result] = await dispatcher.dispatch(createTestRepoEvent(), { deliveryId: 'thrown' });

    expect(result?.success).toBe(false);
    expect(result && !result.success ? result.error : '').toMatch(
      /^TypeError: fetch to \[redacted\] failed/
    );
    expectNoSentinel(JSON.stringify(result));
    expectNoSentinel(logged());
  });

  describe('when reading GitHub as the App', () => {
    let installationId = 7000;
    let env: ReturnType<typeof createTestEnv>;

    beforeEach(async () => {
      // A new installation each time, so no token is cached from an earlier test.
      installationId += 1;
      env = createEnv({ GITHUB_APP_INSTALLATION_ID: String(installationId) });
      vi.setSystemTime(new Date('2026-10-30T08:00:00Z'));
      const event = createTestRepoEvent();
      await new D1DeliveryLedger(env.DB).persistAcceptedDelivery({
        deliveryId: 'yesterday',
        sourceEventType: 'star',
        repository: event.repository.fullName,
        event,
        maxAttempts: 5,
      });
      vi.setSystemTime(new Date('2026-10-30T09:00:00Z'));
    });

    /** GitHub and Discord, with `github` answering every GitHub request. */
    function stubFetch(github: (url: string, jwt: string) => Promise<Response>): {
      jwts: string[];
      discordPosts: () => number;
    } {
      const jwts: string[] = [];
      let discordPosts = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init: RequestInit) => {
          if (!url.startsWith('https://api.github.com/')) {
            discordPosts += 1;
            return Promise.resolve(new Response(null, { status: 204 }));
          }
          const bearer = (new Headers(init.headers).get('Authorization') ?? '').slice(7);
          if (url.endsWith('/access_tokens')) {
            jwts.push(bearer);
          }
          return github(url, bearer);
        })
      );
      return { jwts, discordPosts: () => discordPosts };
    }

    it('keeps them out when the token request throws', async () => {
      const github = stubFetch((_, jwt) => Promise.reject(leakyError(jwt)));

      await sendDueDigests(env, new Date('2026-10-30T09:00:00Z'), new InvocationInsights());

      expect(github.discordPosts()).toBe(1);
      expect(logged()).toContain('GitHub App token request failed: network error');
      expectNoSentinel(logged(), github.jwts[0]);
    });

    it('keeps them out when GitHub refuses the token request', async () => {
      const github = stubFetch((_, jwt) =>
        Promise.resolve(new Response(leakyBody(jwt), { status: 401 }))
      );
      const auth = new GitHubAppAuth(
        { appId: 1, installationId, privateKey },
        new Redactor([privateKey, sentinel.adminToken, sentinel.webhookUrl])
      );

      const failure = await auth.installationToken(READ_TOKEN).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toMatch(
        /^GitHub App token request failed with 401: Bad credentials \[redacted\]/
      );
      expectNoSentinel(`${message}\n${(failure as Error).stack ?? ''}`, github.jwts[0]);
    });

    it('keeps them out when a GitHub read fails, and never logs a minted token', async () => {
      const github = stubFetch((url) =>
        Promise.resolve(
          url.endsWith('/access_tokens')
            ? Response.json(
                { token: sentinel.installationToken, expires_at: '2026-10-30T10:00:00Z' },
                { status: 201 }
              )
            : new Response(leakyBody(), { status: 502 })
        )
      );

      await sendDueDigests(env, new Date('2026-10-30T09:00:00Z'), new InvocationInsights());

      expect(github.discordPosts()).toBe(1);
      expect(logged()).toContain('GitHub /graphql failed with 502: Bad credentials  [redacted]');
      expectNoSentinel(logged(), github.jwts[0]);
    });

    it('keeps them out when a GitHub read throws', async () => {
      const github = stubFetch((url) =>
        url.endsWith('/access_tokens')
          ? Promise.resolve(
              Response.json(
                { token: sentinel.installationToken, expires_at: '2026-10-30T10:00:00Z' },
                { status: 201 }
              )
            )
          : Promise.reject(leakyError())
      );

      await sendDueDigests(env, new Date('2026-10-30T09:00:00Z'), new InvocationInsights());

      expect(github.discordPosts()).toBe(1);
      expect(logged()).toContain('GitHub /graphql failed: network error');
      expectNoSentinel(logged(), github.jwts[0]);
    });
  });
});
