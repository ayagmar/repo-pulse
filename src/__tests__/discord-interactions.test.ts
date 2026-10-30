import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { GitHubAppConfig } from '../config/env.js';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
  serializeRepoEvent,
} from '../core/models/repo-event.js';
import { Redactor } from '../core/security/redact.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../core/services/d1-types.js';
import { GitHubAppAuth, READ_TOKEN } from '../providers/github/app-auth.js';
import {
  createExecutionContext,
  createTempDatabasePath,
  createTestEnv,
  createTestRepoEvent,
} from './test-helpers.js';

const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});

// Fixture ids: Discord snowflakes and a GitHub delivery GUID, none of them real.
const APPLICATION_ID = '100000000000000001';
const OWNER_ID = '100000000000000002';
const STRANGER_ID = '100000000000000003';
const MESSAGE_ID = '100000000000000004';
const ISSUE_DELIVERY = '0b5a3a0e-1f6b-4c49-9d3c-6f2b0a1d2e3f';
const STAR_DELIVERY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const PRIVATE_DELIVERY = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const WEBHOOK_URL = 'https://discord.com/api/webhooks/0/test-only';
const INTERACTION_TOKEN = 'test-interaction-token-SENTINEL';

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const issueEvent = createRepoEvent(REPO_EVENT_TYPES.ISSUE_OPENED, {
  action: REPO_EVENT_ACTIONS.OPENED,
  repository: createTestRepoEvent().repository,
  sender: createTestRepoEvent().sender,
  issue: {
    number: 12,
    title: 'Crash on start',
    url: 'https://github.com/myorg/repo/issues/12',
    state: 'open',
    body: 'It crashes.',
    labels: [],
  },
});

interface Call {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

/**
 * GitHub and Discord. Each token request mints a new token; GitHub's issue writes and
 * Discord's message edits answer with `github` and `edit`, which a test may replace.
 */
function fakeUpstreams(): {
  calls: Call[];
  github: { current: () => Response | Promise<Response> };
  lookup: { current: () => Response | Promise<Response> };
  edit: { current: () => Response | Promise<Response> };
  receipt: { current: () => Response | Promise<Response> };
  mint: { current: (count: number) => Response | Promise<Response> };
} {
  const calls: Call[] = [];
  const github = { current: (): Response => Response.json({}) };
  // The public lookup of the test repository: public, not a fork, the stored id.
  const lookup = { current: (): Response => Response.json({ id: 1, private: false, fork: false }) };
  const edit = { current: (): Response => Response.json({}) };
  const receipt = { current: (): Response => Response.json({}) };
  const mint = {
    current: (count: number): Response =>
      Response.json(
        {
          token: `installation-token-${String(count)}`,
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        },
        { status: 201 }
      ),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      const call: Call = {
        method: init.method ?? 'GET',
        url,
        authorization: new Headers(init.headers).get('Authorization'),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      if (url.endsWith('/access_tokens')) {
        return Promise.resolve(
          mint.current(calls.filter((entry) => entry.url.endsWith('/access_tokens')).length)
        );
      }
      if (url === 'https://api.github.com/repos/myorg/repo' && call.method === 'GET') {
        return Promise.resolve(lookup.current());
      }
      if (url.startsWith('https://api.github.com/repos/')) {
        return Promise.resolve(github.current());
      }
      if (url.startsWith(`https://discord.com/api/v10/webhooks/${APPLICATION_ID}/`)) {
        return Promise.resolve(receipt.current());
      }
      if (url.startsWith(`${WEBHOOK_URL}/messages/`)) {
        return Promise.resolve(edit.current());
      }
      return Promise.reject(new Error(`Unexpected request to ${url}`));
    })
  );
  return { calls, github, lookup, edit, receipt, mint };
}

const writes = (calls: Call[]): Call[] =>
  calls.filter(
    (call) => call.url.startsWith('https://api.github.com/repos/') && call.method !== 'GET'
  );
const lookups = (calls: Call[]): Call[] =>
  calls.filter(
    (call) => call.url.startsWith('https://api.github.com/repos/') && call.method === 'GET'
  );
const receipts = (calls: Call[]): string[] =>
  calls
    .filter((call) => call.url.startsWith('https://discord.com/api/v10/'))
    .map((call) => (call.body as { content: string }).content);
const edits = (calls: Call[]): Call[] =>
  calls.filter((call) => call.url.startsWith(`${WEBHOOK_URL}/messages/`));

/** Everything the logger wrote; setup.ts replaces the console with mocks. */
function loggedText(): string {
  return [console.debug, console.info, console.warn, console.error]
    .flatMap((method) => vi.mocked(method).mock.calls.flat() as unknown[])
    .map((value) => String(value))
    .join('\n');
}

describe('Discord interactions', () => {
  let keys: CryptoKeyPair;
  let publicKey: string;
  // The token cache lives as long as the isolate, so each test uses its own installation.
  let installationId = 5000;
  let interactionCount = 0;
  const cleanups: (() => void)[] = [];

  beforeAll(async () => {
    keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    publicKey = hex(await crypto.subtle.exportKey('raw', keys.publicKey));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    installationId += 1;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  async function setup(overrides: Record<string, string | undefined> = {}): Promise<{
    env: ReturnType<typeof createTestEnv>;
    app: GitHubAppConfig;
  }> {
    const tempDatabase = createTempDatabasePath();
    const env = createTestEnv(tempDatabase.databasePath, {
      DISCORD_WEBHOOK_URL: WEBHOOK_URL,
      DISCORD_ACTIONS: 'on',
      DISCORD_APPLICATION_ID: APPLICATION_ID,
      DISCORD_PUBLIC_KEY: publicKey,
      DISCORD_ALLOWED_USER_IDS: OWNER_ID,
      GITHUB_APP_ID: String(77),
      GITHUB_APP_INSTALLATION_ID: String(installationId),
      GITHUB_APP_PRIVATE_KEY: appKey,
      ...overrides,
    });
    cleanups.push(() => {
      env.DB.close();
      tempDatabase.cleanup();
    });
    for (const [deliveryId, event] of [
      [ISSUE_DELIVERY, issueEvent],
      [STAR_DELIVERY, createTestRepoEvent()],
      [
        PRIVATE_DELIVERY,
        { ...issueEvent, repository: { ...issueEvent.repository, private: true } },
      ],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO events (delivery_id, event_type, repository, received_at, event_json)
         VALUES (?, ?, 'myorg/repo', '2026-10-30T12:00:00.000Z', ?)`
      )
        .bind(deliveryId, event.type, serializeRepoEvent(event))
        .run();
    }
    return { env, app: { appId: 77, installationId, privateKey: appKey } };
  }

  async function signedRequest(
    body: string,
    options: { timestamp?: string; headers?: Record<string, string> } = {}
  ): Promise<Request> {
    const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
    const signature = hex(
      await crypto.subtle.sign(
        { name: 'Ed25519' },
        keys.privateKey,
        new TextEncoder().encode(timestamp + body)
      )
    );
    return new Request('https://example.com/discord/interactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature-Ed25519': signature,
        'X-Signature-Timestamp': timestamp,
        ...options.headers,
      },
      body,
    });
  }

  function interaction(fields: Record<string, unknown>): string {
    interactionCount += 1;
    return JSON.stringify({
      id: String(200000000000000000n + BigInt(interactionCount)),
      application_id: APPLICATION_ID,
      token: INTERACTION_TOKEN,
      member: { user: { id: OWNER_ID } },
      message: { id: MESSAGE_ID },
      ...fields,
    });
  }

  const click = (customId: string, fields: Record<string, unknown> = {}): string =>
    interaction({ type: 3, data: { custom_id: customId, component_type: 2 }, ...fields });
  const submitLabels = (value: string, deliveryId = ISSUE_DELIVERY): string =>
    interaction({
      type: 5,
      data: {
        custom_id: `v1:labels:${deliveryId}`,
        components: [{ type: 1, components: [{ type: 4, custom_id: 'labels', value }] }],
      },
    });

  /** Sends one request and waits for its background work. */
  async function send(
    env: ReturnType<typeof createTestEnv>,
    request: Request | Promise<Request>
  ): Promise<Response> {
    const { executionCtx, waitForBackground } = createExecutionContext();
    const response = await createApp().fetch(await request, env, executionCtx);
    await waitForBackground();
    return response;
  }

  describe('verification', () => {
    it('answers a signed PING', async () => {
      const { env } = await setup();
      const response = await send(
        env,
        signedRequest(
          JSON.stringify({ type: 1, id: '1', application_id: APPLICATION_ID, token: 'ping' })
        )
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ type: 1 });
    });

    it('is not found while DISCORD_ACTIONS is off', async () => {
      const { env } = await setup({ DISCORD_ACTIONS: undefined });
      const limit = vi.spyOn(env.DISCORD_RATE_LIMIT, 'limit');
      const response = await send(env, signedRequest(JSON.stringify({ type: 1 })));
      expect(response.status).toBe(404);
      expect(limit).not.toHaveBeenCalled();
    });

    it('refuses every request Discord did not sign recently, with one answer', async () => {
      const { env } = await setup();
      const ping = JSON.stringify({
        type: 1,
        id: '1',
        application_id: APPLICATION_ID,
        token: 'ping',
      });
      const now = Math.floor(Date.now() / 1000);
      const valid = await signedRequest(ping);
      const tampered = new Request(valid, { body: ping.replace('"type":1', '"type":2') });
      const unsigned = new Request('https://example.com/discord/interactions', {
        method: 'POST',
        body: ping,
      });
      const refused = [
        tampered,
        unsigned,
        await signedRequest(ping, { headers: { 'X-Signature-Ed25519': 'zz' } }),
        await signedRequest(ping, { headers: { 'X-Signature-Ed25519': '0'.repeat(128) } }),
        await signedRequest(ping, { timestamp: String(now - 6 * 60) }),
        await signedRequest(ping, { timestamp: String(now + 6 * 60) }),
        await signedRequest(ping, { timestamp: `${String(now)}.5` }),
        await signedRequest(ping, { timestamp: 'yesterday' }),
      ];

      for (const request of refused) {
        const response = await send(env, request);
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({ error: 'invalid_request' });
      }
    });

    it('refuses a body over 64 KiB before reading its signature', async () => {
      const { env } = await setup();
      const response = await send(
        env,
        signedRequest(JSON.stringify({ type: 1, padding: 'x'.repeat(64 * 1024) }))
      );
      expect(response.status).toBe(413);
    });

    it('rate limits before any signature work', async () => {
      const { env } = await setup();
      vi.spyOn(env.DISCORD_RATE_LIMIT, 'limit').mockResolvedValue({ success: false });
      const verify = vi.spyOn(crypto.subtle, 'verify');
      const response = await send(env, signedRequest(JSON.stringify({ type: 1 })));
      expect(response.status).toBe(429);
      expect(verify).not.toHaveBeenCalled();
    });

    it('refuses an interaction for another application', async () => {
      const { env } = await setup();
      const { calls } = fakeUpstreams();
      const response = await send(
        env,
        signedRequest(click(`v1:close:${ISSUE_DELIVERY}`, { application_id: '100000000000000009' }))
      );
      expect(response.status).toBe(401);
      expect(calls).toEqual([]);
    });
  });

  describe('authorization and immediate responses', () => {
    it('tells a user off the allow list no, without D1 or any request', async () => {
      const { env } = await setup();
      const { calls } = fakeUpstreams();
      const prepare = vi.spyOn(env.DB, 'prepare');
      for (const body of [
        click(`v1:close:${ISSUE_DELIVERY}`, { member: { user: { id: STRANGER_ID } } }),
        click(`v1:close:${ISSUE_DELIVERY}`, { member: undefined, user: { id: STRANGER_ID } }),
      ]) {
        const response = await send(env, signedRequest(body));
        await expect(response.json()).resolves.toEqual({
          type: 4,
          data: {
            content: 'You are not allowed to act on these alerts.',
            flags: 64,
            allowed_mentions: { parse: [] },
          },
        });
      }
      expect(calls).toEqual([]);
      expect(prepare).not.toHaveBeenCalled();
    });

    it('answers at once while D1 and GitHub hang', async () => {
      const { env } = await setup();
      const hanging = new Promise<never>(() => undefined);
      const statement: D1PreparedStatementLike = {
        bind: () => statement,
        first: () => hanging,
        all: () => hanging,
        run: () => hanging,
      };
      const db: D1DatabaseLike = {
        prepare: () => statement,
        batch: () => hanging,
        exec: () => hanging,
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(() => hanging)
      );
      const answer = async (body: string): Promise<unknown> => {
        const { executionCtx } = createExecutionContext();
        const response = await Promise.race([
          createApp().fetch(await signedRequest(body), { ...env, DB: db }, executionCtx),
          new Promise<never>((_, reject) =>
            setTimeout(() => {
              reject(new Error('no answer within Discord’s 3 seconds'));
            }, 2_900)
          ),
        ]);
        return response.json();
      };

      await expect(answer(click(`v1:close:${ISSUE_DELIVERY}`))).resolves.toEqual({ type: 6 });
      await expect(answer(click(`v1:label:${ISSUE_DELIVERY}`))).resolves.toMatchObject({
        type: 9,
        data: {
          custom_id: `v1:labels:${ISSUE_DELIVERY}`,
          components: [{ type: 1, components: [{ type: 4, custom_id: 'labels' }] }],
        },
      });
      await expect(answer(submitLabels('bug'))).resolves.toEqual({ type: 6 });
    });

    it('answers an unknown button or empty labels with an ephemeral error and does nothing', async () => {
      const { env } = await setup();
      const { calls } = fakeUpstreams();
      for (const body of [
        click('v1:close:not-a-delivery'),
        click(`v1:close:${ISSUE_DELIVERY}${'0'.repeat(56)}`),
        click(`v2:close:${ISSUE_DELIVERY}`),
        click(`v1:labels:${ISSUE_DELIVERY}`),
        submitLabels(' , '),
        submitLabels('x'.repeat(51)),
      ]) {
        const response = await send(env, signedRequest(body));
        await expect(response.json()).resolves.toMatchObject({ type: 4, data: { flags: 64 } });
      }
      expect(calls).toEqual([]);
    });
  });

  describe('actions', () => {
    it('closes the stored issue with a write token for its repository alone', async () => {
      const { env } = await setup();
      const { calls } = fakeUpstreams();

      const response = await send(env, signedRequest(click(`v1:close:${ISSUE_DELIVERY}`)));

      expect(response.status).toBe(200);
      const mints = calls.filter((call) => call.url.endsWith('/access_tokens'));
      expect(mints.map((call) => call.body)).toEqual([
        { permissions: { issues: 'write' }, repositories: ['repo'] },
      ]);
      expect(writes(calls)).toEqual([
        {
          method: 'PATCH',
          url: 'https://api.github.com/repos/myorg/repo/issues/12',
          authorization: 'Bearer installation-token-1',
          body: { state: 'closed' },
        },
      ]);
      expect(receipts(calls)).toEqual(['✅ Closed issue #12']);
      await expect(
        env.DB.prepare(
          'SELECT action, outcome, detail, discord_user_id AS userId FROM discord_actions'
        ).all()
      ).resolves.toMatchObject({
        results: [{ action: 'close', outcome: 'succeeded', detail: '', userId: OWNER_ID }],
      });
    });

    it('mints a write token even with a read token cached in the isolate', async () => {
      const { env, app } = await setup();
      const { calls } = fakeUpstreams();
      await new GitHubAppAuth(app, new Redactor([])).installationToken(READ_TOKEN);

      await send(env, signedRequest(click(`v1:close:${ISSUE_DELIVERY}`)));

      expect(calls.filter((call) => call.url.endsWith('/access_tokens'))).toHaveLength(2);
      expect(writes(calls).map((call) => call.authorization)).toEqual([
        'Bearer installation-token-2',
      ]);
    });

    it('acts once on an interaction delivered twice', async () => {
      const { env } = await setup();
      const { calls } = fakeUpstreams();
      const body = click(`v1:close:${ISSUE_DELIVERY}`);

      await send(env, signedRequest(body));
      const replay = await send(env, signedRequest(body));

      expect(replay.status).toBe(200);
      expect(writes(calls)).toHaveLength(1);
      expect(receipts(calls)).toHaveLength(1);
    });

    it('closes again on a second click, leaving the same state', async () => {
      const { env } = await setup();
      const { calls } = fakeUpstreams();

      await send(env, signedRequest(click(`v1:close:${ISSUE_DELIVERY}`)));
      await send(env, signedRequest(click(`v1:close:${ISSUE_DELIVERY}`)));

      expect(writes(calls).map((call) => [call.method, call.body])).toEqual([
        ['PATCH', { state: 'closed' }],
        ['PATCH', { state: 'closed' }],
      ]);
      await expect(
        env.DB.prepare('SELECT action, outcome FROM discord_actions').all()
      ).resolves.toMatchObject({ results: [{ action: 'close', outcome: 'succeeded' }] });
    });

    it('adds the labels typed in the modal', async () => {
      const { env } = await setup();
      const { calls } = fakeUpstreams();

      await send(env, signedRequest(submitLabels(' bug, ui ,bug')));

      expect(writes(calls)).toMatchObject([
        {
          method: 'POST',
          url: 'https://api.github.com/repos/myorg/repo/issues/12/labels',
          body: { labels: ['bug', 'ui'] },
        },
      ]);
      expect(receipts(calls)).toEqual(['🏷️ Labeled issue #12: bug, ui']);
    });

    it('does nothing on GitHub for a delivery that is not an issue alert', async () => {
      const { env } = await setup();
      const { calls } = fakeUpstreams();

      await send(env, signedRequest(click(`v1:close:${STAR_DELIVERY}`)));
      await send(
        env,
        signedRequest(click(`v1:close:${'f'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`))
      );

      expect(writes(calls)).toEqual([]);
      expect(calls.filter((call) => call.url.endsWith('/access_tokens'))).toEqual([]);
      expect(receipts(calls)).toEqual([
        'Nothing done: this is not an issue alert.',
        'Nothing done: this is not an issue alert.',
      ]);
    });

    it.each([
      [403, 'Resource not accessible by integration'],
      [404, 'Not Found'],
      [422, 'Validation Failed'],
    ])('reports GitHub %i with its message and records the failure', async (status, message) => {
      const { env } = await setup();
      const upstream = fakeUpstreams();
      upstream.github.current = (): Response => Response.json({ message }, { status });

      await send(env, signedRequest(click(`v1:close:${ISSUE_DELIVERY}`)));

      const error = `GitHub request failed with ${String(status)}: ${message}`;
      expect(receipts(upstream.calls)).toEqual([`❌ Could not close issue #12: ${error}`]);
      await expect(
        env.DB.prepare('SELECT outcome, detail FROM discord_actions').all()
      ).resolves.toMatchObject({ results: [{ outcome: 'failed', detail: error }] });
    });

    it('reports a failed token request without calling GitHub', async () => {
      const { env } = await setup();
      const upstream = fakeUpstreams();
      upstream.mint.current = (): Response =>
        Response.json({ message: 'Bad credentials' }, { status: 401 });

      await send(env, signedRequest(click(`v1:close:${ISSUE_DELIVERY}`)));

      expect(writes(upstream.calls)).toEqual([]);
      expect(receipts(upstream.calls)).toEqual([
        '❌ Could not close issue #12: GitHub App token request failed with 401: Bad credentials',
      ]);
    });

    it('says nothing changed when D1 fails before GitHub is asked', async () => {
      const { env } = await setup();
      const { calls } = fakeUpstreams();
      await env.DB.exec('DROP TABLE discord_interactions');

      await send(env, signedRequest(click(`v1:close:${ISSUE_DELIVERY}`)));

      expect(writes(calls)).toEqual([]);
      expect(receipts(calls)).toEqual([
        '❌ Something went wrong before GitHub was asked; nothing changed.',
      ]);
    });

    it('still sends the receipt when the outcome cannot be recorded, and skips the edit', async () => {
      const { env } = await setup();
      const { calls } = fakeUpstreams();
      await env.DB.exec('DROP TABLE discord_actions');

      await send(env, signedRequest(click(`v1:close:${ISSUE_DELIVERY}`)));

      expect(writes(calls)).toHaveLength(1);
      expect(receipts(calls)).toEqual(['✅ Closed issue #12']);
      expect(edits(calls)).toEqual([]);
    });
  });

  describe('repository eligibility', () => {
    const notEligible =
      'Nothing done: GitHub does not confirm myorg/repo is public and not a fork right now.';

    it('asks GitHub with the public-only token, before any write token, whether the repository is public', async () => {
      const { env } = await setup({ GITHUB_PUBLIC_TOKEN: 'test-public-token' });
      const { calls } = fakeUpstreams();

      await send(env, signedRequest(click(`v1:close:${ISSUE_DELIVERY}`)));

      expect(lookups(calls).map((call) => call.authorization)).toEqual([
        'Bearer test-public-token',
      ]);
      expect(calls.findIndex((call) => call.method === 'GET')).toBeLessThan(
        calls.findIndex((call) => call.url.endsWith('/access_tokens'))
      );
      expect(writes(calls)).toHaveLength(1);
    });

    it('refuses an event recorded as private without asking GitHub', async () => {
      const { env } = await setup();
      const { calls } = fakeUpstreams();

      await send(env, signedRequest(click(`v1:close:${PRIVATE_DELIVERY}`)));

      expect(calls.filter((call) => call.url.startsWith('https://api.github.com/'))).toEqual([]);
      expect(receipts(calls)).toEqual([notEligible]);
    });

    it.each([
      ['a fork', (): Response => Response.json({ id: 1, private: false, fork: true })],
      [
        'made private since (404 to a public-only lookup)',
        (): Response => new Response(null, { status: 404 }),
      ],
      ['private', (): Response => Response.json({ id: 1, private: true, fork: false })],
      [
        'replaced by another repository',
        (): Response => Response.json({ id: 2, private: false, fork: false }),
      ],
      ['missing its fork flag', (): Response => Response.json({ id: 1, private: false })],
      ['unavailable', (): Response => new Response(null, { status: 503 })],
      [
        'not answering',
        (): Response => {
          throw new Error('network down');
        },
      ],
    ])('writes nothing to a repository that is %s', async (_case, answer) => {
      const { env } = await setup();
      const upstream = fakeUpstreams();
      upstream.lookup.current = answer;

      await send(env, signedRequest(submitLabels('bug')));

      expect(lookups(upstream.calls)).toHaveLength(1);
      expect(upstream.calls.filter((call) => call.url.endsWith('/access_tokens'))).toEqual([]);
      expect(writes(upstream.calls)).toEqual([]);
      expect(receipts(upstream.calls)).toEqual([notEligible]);
      await expect(env.DB.prepare('SELECT * FROM discord_actions').all()).resolves.toMatchObject({
        results: [],
      });
    });
  });

  describe('alert message', () => {
    it('shows every action taken and disables Close once the issue is closed', async () => {
      const { env } = await setup();
      const { calls } = fakeUpstreams();

      await send(env, signedRequest(click(`v1:close:${ISSUE_DELIVERY}`)));
      await send(env, signedRequest(submitLabels('bug, ui')));

      const last = edits(calls).at(-1);
      expect(last?.method).toBe('PATCH');
      expect(last?.url).toBe(`${WEBHOOK_URL}/messages/${MESSAGE_ID}?with_components=true`);
      expect(last?.body).toMatchObject({
        embeds: [
          {
            title: '🐛 Opened issue #12: Crash on start',
            fields: [
              {
                name: 'Actions',
                value: `✅ Closed by <@${OWNER_ID}>\n🏷️ Labeled bug, ui by <@${OWNER_ID}>`,
              },
            ],
          },
        ],
        components: [
          {
            type: 1,
            components: [
              { label: 'Close', custom_id: `v1:close:${ISSUE_DELIVERY}`, disabled: true },
              { label: 'Label…', custom_id: `v1:label:${ISSUE_DELIVERY}` },
            ],
          },
        ],
      });
    });

    it('logs a failed edit and keeps the receipt and the outcome', async () => {
      const { env } = await setup({ LOG_LEVEL: 'warn' });
      const upstream = fakeUpstreams();
      upstream.edit.current = (): Response =>
        Response.json({ message: 'You are being rate limited.' }, { status: 429 });

      await send(env, signedRequest(click(`v1:close:${ISSUE_DELIVERY}`)));

      expect(edits(upstream.calls)).toHaveLength(1);
      expect(receipts(upstream.calls)).toEqual(['✅ Closed issue #12']);
      expect(loggedText()).toContain('discord_action.edit_failed');
      expect(loggedText()).toContain('Discord message edit failed with 429');
      await expect(
        env.DB.prepare('SELECT outcome FROM discord_actions').all()
      ).resolves.toMatchObject({ results: [{ outcome: 'succeeded' }] });
    });
  });

  it('keeps credentials out of logs, receipts, stored outcomes and responses', async () => {
    const { env } = await setup({ LOG_LEVEL: 'debug' });
    const upstream = fakeUpstreams();
    const sentinels = [INTERACTION_TOKEN, WEBHOOK_URL, 'installation-token-1'];
    const leaky = `${INTERACTION_TOKEN} ${WEBHOOK_URL} installation-token-1`;
    upstream.github.current = (): Response =>
      Response.json({ message: `Denied: ${leaky}` }, { status: 403 });
    upstream.receipt.current = (): Response => {
      throw new Error(
        `fetch to https://discord.com/api/v10/webhooks/${APPLICATION_ID}/${INTERACTION_TOKEN} failed`
      );
    };
    upstream.edit.current = (): Response =>
      Response.json({ message: `No: ${leaky}` }, { status: 400 });

    const bodies: string[] = [];
    for (const body of [
      JSON.stringify({ type: 1, id: '1', application_id: APPLICATION_ID, token: 'ping' }),
      click(`v1:close:${ISSUE_DELIVERY}`),
      click(`v1:close:${ISSUE_DELIVERY}`, { member: { user: { id: STRANGER_ID } } }),
      click('v1:close:unknown'),
      click(`v1:label:${ISSUE_DELIVERY}`),
      submitLabels('bug'),
    ]) {
      bodies.push(await (await send(env, signedRequest(body))).text());
    }
    const unsigned = await send(
      env,
      new Request('https://example.com/discord/interactions', { method: 'POST', body: click('x') })
    );
    bodies.push(await unsigned.text());

    const stored = JSON.stringify(
      (await env.DB.prepare('SELECT * FROM discord_actions').all()).results
    );
    const sent = JSON.stringify(upstream.calls.map((call) => call.body));
    expect(stored).toContain('[redacted]');
    expect(loggedText()).toContain('discord_action.receipt_failed');
    expect(loggedText()).toContain('discord_action.edit_failed');
    for (const sentinel of sentinels) {
      expect(loggedText()).not.toContain(sentinel);
      expect(stored).not.toContain(sentinel);
      expect(sent).not.toContain(sentinel);
      expect(bodies.join('\n')).not.toContain(sentinel);
    }
  });
});
