import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D1DeliveryLedger } from '../core/services/d1-delivery-ledger.js';
import worker from '../index.js';
import type { GitHubWebhookPayload } from '../providers/github/types.js';
import {
  createExecutionContext,
  createTempDatabasePath,
  createTestEnv,
  mintingApp,
} from './test-helpers.js';

const LIST = 'https://api.github.com/app/hook/deliveries';
const app = mintingApp();

function delivery(
  id: number,
  guid: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    guid,
    delivered_at: '2026-11-19T12:00:00Z',
    redelivery: false,
    status: 'failed',
    status_code: 500,
    ...overrides,
  };
}

function star(count: number, starredAt?: string): GitHubWebhookPayload {
  return {
    action: 'created',
    ...(starredAt === undefined ? {} : { starred_at: starredAt }),
    installation: { id: Number(app.GITHUB_APP_INSTALLATION_ID) },
    repository: {
      id: 60,
      name: 'cli',
      full_name: 'myorg/cli',
      owner: { login: 'myorg' },
      html_url: 'https://github.com/myorg/cli',
      private: false,
      fork: false,
      stargazers_count: count,
      forks_count: 0,
      description: null,
      language: null,
    },
    sender: {
      id: count,
      login: `user-${String(count)}`,
      avatar_url: 'https://avatars.githubusercontent.com/1',
      html_url: `https://github.com/user-${String(count)}`,
    },
  };
}

describe('scheduled webhook recovery', () => {
  let temp: ReturnType<typeof createTempDatabasePath>;
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    temp = createTempDatabasePath();
    env = createTestEnv(temp.databasePath, { ...app, DIGEST_TIME_ZONE: 'UTC', DIGEST_HOUR: '9' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    env.DB.close();
    temp.cleanup();
  });

  async function cron(at: string): Promise<PromiseSettledResult<unknown>[]> {
    const scheduledTime = Date.parse(at);
    vi.setSystemTime(scheduledTime);
    const execution = createExecutionContext();
    worker.scheduled(
      { scheduledTime, cron: '* * * * *', noRetry: () => undefined },
      env as unknown as Env,
      execution.executionCtx
    );
    return execution.waitForBackground();
  }

  async function webhook(
    guid: string,
    payload: GitHubWebhookPayload,
    event = 'star'
  ): Promise<number> {
    const body = JSON.stringify(payload);
    const execution = createExecutionContext();
    const response = await worker.fetch(
      new Request('https://example.test/webhook', {
        method: 'POST',
        body,
        headers: {
          'X-GitHub-Event': event,
          'X-GitHub-Delivery': guid,
          'X-Hub-Signature-256': `sha256=${createHmac('sha256', env.GITHUB_WEBHOOK_SECRET ?? '')
            .update(body)
            .digest('hex')}`,
        },
      }),
      env as unknown as Env,
      execution.executionCtx
    );
    await execution.waitForBackground();
    return response.status;
  }

  // A day of write refusal lost unaccepted deliveries. A naive sweep either asked for them while
  // D1 was down or replayed pruned, leased, acknowledged and already re-requested GUIDs.
  it('waits for writes, walks pages across invocations, and does not immediately retry a GUID', async () => {
    vi.setSystemTime(Date.parse('2026-11-18T22:00:00Z'));
    const posts: string[] = [];
    const lists: (string | null)[] = [];
    const fetchMock = vi.fn((address: string, init: RequestInit) => {
      if (address.startsWith('https://discord.com/'))
        return Promise.resolve(new Response(null, { status: 204 }));
      const url = new URL(address);
      expect(address.startsWith(LIST)).toBe(true);
      expect(new Headers(init.headers).get('Authorization')).toMatch(
        /^Bearer [^.]+\.[^.]+\.[^.]+$/
      );
      if (init.method === 'POST') {
        posts.push(url.pathname);
        // An ambiguous timeout must not cause a second request before the wait has elapsed.
        if (url.pathname.endsWith('/6/attempts'))
          return Promise.reject(new DOMException('timeout', 'TimeoutError'));
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      expect(url.searchParams.get('per_page')).toBe('100');
      const cursor = url.searchParams.get('cursor');
      lists.push(cursor);
      if (cursor === 'p2') {
        return Promise.resolve(
          Response.json([delivery(6, 'missing'), delivery(7, 'manual'), delivery(8, 'another')])
        );
      }
      return Promise.resolve(
        Response.json(
          [
            delivery(10, 'manual', { redelivery: true, status: 'OK', status_code: 200 }),
            delivery(9, 'ignored', { event: 'repository', status: 'OK', status_code: 200 }),
            delivery(4, 'pruned'),
            delivery(3, 'leased'),
            delivery(2, 'old', { delivered_at: '2026-11-16T12:00:00Z' }),
          ],
          { headers: { Link: `<${LIST}?per_page=100&cursor=p2>; rel="next"` } }
        )
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await webhook('pruned', star(97))).toBe(202);
    await new D1DeliveryLedger(env.DB).pruneSucceededDeliveries(new Date(Date.now() + 1000));
    await expect(new D1DeliveryLedger(env.DB).getDelivery('pruned')).resolves.toBeNull();
    // Use a live lease that survives the outage; recovery must never enqueue it again.
    expect(await webhook('leased', star(98))).toBe(202);
    await env.DB.prepare(
      "UPDATE deliveries SET status = 'processing', lease_expires_at = '2026-11-21T00:00:00.000Z' WHERE delivery_id = 'leased'"
    ).run();

    const prepare = env.DB.prepare.bind(env.DB);
    const batch = vi.spyOn(env.DB, 'batch').mockRejectedValue(new Error('row write limit'));
    const refusing = vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      if (/^(INSERT|UPDATE|DELETE|WITH)/i.test(query.trimStart()))
        throw new Error('row write limit');
      return prepare(query);
    });
    await cron('2026-11-19T02:20:00Z');
    vi.setSystemTime(Date.parse('2026-11-19T12:00:00Z'));
    expect(await webhook('missing', star(100))).toBe(500);
    expect(await webhook('ignored', star(101), 'repository')).toBe(200);
    await cron('2026-11-19T12:10:00Z');
    await cron('2026-11-19T23:50:00Z');
    expect(lists).toEqual([]);
    batch.mockRestore();
    refusing.mockRestore();
    await Promise.all([cron('2026-11-20T00:00:00Z'), cron('2026-11-20T00:00:00Z')]);
    await cron('2026-11-20T00:10:00Z');
    await cron('2026-11-20T00:20:00Z');
    await cron('2026-11-20T00:30:00Z');
    await cron('2026-11-20T00:40:00Z');
    expect(lists).toEqual([null, 'p2', 'p2', null, 'p2']);
    expect(posts).toEqual(['/app/hook/deliveries/6/attempts', '/app/hook/deliveries/8/attempts']);
  });

  // GitHub's header-bearing throttle must stop requests across runs, without losing the delivery.
  it('honors Retry-After and retries the missing delivery after an hour', async () => {
    let lists = 0;
    let posts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((address: string, init: RequestInit) => {
        if (!address.startsWith(LIST)) throw new Error('Unexpected external request');
        if (init.method === 'GET') {
          lists += 1;
          return Promise.resolve(Response.json(lists < 4 ? [delivery(1, 'rate-limited')] : []));
        }
        posts += 1;
        return Promise.resolve(
          posts === 1
            ? new Response(null, { status: 429, headers: { 'Retry-After': '660' } })
            : new Response(null, { status: 202 })
        );
      })
    );
    await cron('2026-11-20T00:00:00Z');
    await cron('2026-11-20T00:10:00Z');
    expect([lists, posts]).toEqual([1, 1]);
    await cron('2026-11-20T00:20:00Z');
    expect([lists, posts]).toEqual([2, 1]);
    await cron('2026-11-20T01:00:00Z');
    await cron('2026-11-20T01:10:00Z');
    expect([lists, posts]).toEqual([4, 2]);
  });

  // A lost reservation reply or a 202 followed by a failed callback used to lose the event permanently.
  it('retries unresolved reservations at most three times, preserving the first activity time', async () => {
    let postCount = 0;
    let listCount = 0;
    const timeout = new DOMException('timeout', 'TimeoutError');
    vi.stubGlobal(
      'fetch',
      vi.fn((address: string, init: RequestInit) => {
        if (address.startsWith('https://discord.com/'))
          return Promise.resolve(new Response(null, { status: 204 }));
        if (init.method === 'GET' && address.startsWith(LIST)) {
          listCount += 1;
          return Promise.resolve(
            Response.json([
              delivery(
                1,
                'lost-reply',
                listCount > 1 ? { delivered_at: '2026-11-19T13:00:00Z' } : {}
              ),
              delivery(2, 'lost-reply', { redelivery: true, delivered_at: '2026-11-20T01:01:00Z' }),
            ])
          );
        }
        if (!address.endsWith('/1/attempts')) throw new Error('Unexpected external request');
        postCount += 1;
        return postCount === 1
          ? Promise.resolve(new Response(null, { status: 202 }))
          : Promise.reject(timeout);
      })
    );
    const prepare = env.DB.prepare.bind(env.DB);
    const lostReply = vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      const statement = prepare(query);
      if (query.includes('request_count = webhook_recovery_attempts.request_count + 1')) {
        const bind = statement.bind.bind(statement);
        vi.spyOn(statement, 'bind').mockImplementation((...values) => {
          const bound = bind(...values);
          const first = bound.first.bind(bound);
          vi.spyOn(bound, 'first').mockImplementation(async () => {
            await first();
            throw timeout;
          });
          return bound;
        });
      }
      return statement;
    });
    await cron('2026-11-20T00:00:00Z');
    expect(postCount).toBe(0);
    lostReply.mockRestore();
    await cron('2026-11-20T00:50:00Z');
    expect(postCount).toBe(0);
    await cron('2026-11-20T01:00:00Z');
    expect(postCount).toBe(1);
    const failedCallback = vi
      .spyOn(env.DB, 'batch')
      .mockRejectedValue(new Error('D1 now refuses writes'));
    expect(await webhook('lost-reply', star(100))).toBe(500);
    failedCallback.mockRestore();
    await cron('2026-11-20T01:50:00Z');
    expect(postCount).toBe(1);
    await cron('2026-11-20T02:00:00Z');
    await cron('2026-11-20T03:00:00Z');
    expect(postCount).toBe(2);
    expect(await webhook('lost-reply', star(100))).toBe(202);
    expect(await webhook('lost-reply', star(100))).toBe(200);
    await expect(new D1DeliveryLedger(env.DB).getDelivery('lost-reply')).resolves.toMatchObject({
      event: { activityAt: '2026-11-19T12:00:00.000Z' },
    });
  });

  // A headerless secondary limit on either endpoint must stop the scan rather than spending the batch.
  it('stops on headerless GitHub throttles and preserves the per-GUID retry interval', async () => {
    const limited = (): Response =>
      Response.json(
        { message: 'You have exceeded a secondary rate limit.' },
        { status: 403, headers: { 'X-RateLimit-Remaining': '42' } }
      );
    const posts: string[] = [];
    let listCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((address: string, init: RequestInit) => {
        if (init.method === 'GET') {
          listCount += 1;
          return Promise.resolve(
            listCount === 1
              ? limited()
              : Response.json([delivery(1, 'limited'), delivery(2, 'next')])
          );
        }
        posts.push(address);
        return Promise.resolve(
          posts.length === 1 ? limited() : new Response(null, { status: 202 })
        );
      })
    );
    await cron('2026-11-20T00:00:00Z');
    expect(posts).toEqual([]);
    await cron('2026-11-20T00:10:00Z');
    expect(posts).toEqual([`${LIST}/1/attempts`]);
    await cron('2026-11-20T00:20:00Z');
    expect(posts).toEqual([`${LIST}/1/attempts`, `${LIST}/2/attempts`]);
    await cron('2026-11-20T01:10:00Z');
    expect(posts).toEqual([`${LIST}/1/attempts`, `${LIST}/2/attempts`, `${LIST}/1/attempts`]);
  });

  // A burst of old star payloads with high historical counts used to look like a current spike,
  // claim a milestone and move the stars into yesterday's wrong digest bucket.
  it('posts recovered stars plainly, with their original activity time', async () => {
    const embeds: { title: string; description: string; timestamp: string }[] = [];
    const fetchMock = vi.fn((address: string, init: RequestInit) => {
      if (address.startsWith('https://discord.com/')) {
        embeds.push(...(JSON.parse(init.body as string) as { embeds: typeof embeds }).embeds);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (init.method === 'GET' && address.startsWith(LIST)) {
        return Promise.resolve(
          Response.json(
            Array.from({ length: 5 }, (_, index) => delivery(index + 1, `star-${String(index)}`))
          )
        );
      }
      if (address.startsWith(LIST)) return Promise.resolve(new Response(null, { status: 202 }));
      if (address.endsWith('/access_tokens'))
        return Promise.resolve(new Response(null, { status: 503 }));
      throw new Error('Unexpected external request');
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.setSystemTime(Date.parse('2026-11-18T08:00:00Z'));
    expect(await webhook('baseline', star(99))).toBe(202);
    embeds.length = 0;
    await cron('2026-11-20T08:00:00Z');
    for (let index = 0; index < 5; index += 1) {
      // First payload was before the previous day's 09:00 boundary; last has no action time.
      const at =
        index === 0 ? '2026-11-19T08:59:00Z' : index === 4 ? undefined : '2026-11-19T11:59:00Z';
      expect(await webhook(`star-${String(index)}`, star(100 + index, at))).toBe(202);
    }
    expect(embeds.map(({ title, timestamp }) => [title, timestamp])).toEqual([
      ['⭐ New star · 100 total', '2026-11-19T08:59:00.000Z'],
      ...[101, 102, 103].map((count) => [
        `⭐ New star · ${String(count)} total`,
        '2026-11-19T11:59:00.000Z',
      ]),
      ['⭐ New star · 104 total', '2026-11-19T12:00:00.000Z'],
    ]);
    await cron('2026-11-20T08:05:00Z');
    expect(embeds).toHaveLength(5);
    await cron('2026-11-20T09:01:00Z');
    expect(embeds.slice(5)).toMatchObject([
      {
        title: '📊 Daily pulse · Fri 20 Nov',
        description: '4 new stars\n\n**[myorg/cli](https://github.com/myorg/cli)** ⭐ +4',
      },
    ]);
  });
});
