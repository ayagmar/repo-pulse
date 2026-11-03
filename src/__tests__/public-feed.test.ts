import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { RepoEvent } from '../core/models/repo-event.js';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
} from '../core/models/repo-event.js';
import { prepareEventHistoryInsert } from '../core/services/d1-event-history.js';
import feedLimitsGolden from './fixtures/public-feed-limits.golden.json' with { type: 'json' };
import feedSchema from './fixtures/repo-pulse-feed.input.json' with { type: 'json' };
import { createExecutionContext, createTempDatabasePath, createTestEnv } from './test-helpers.js';

type Visibility =
  | 'public'
  | 'private'
  | 'not_found'
  | 'moved'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'no_private_flag'
  | 'unreadable';

/** The exported schema leaves objects open; the contract is closed, so close every object. */
function closed(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(closed);
  }
  if (typeof schema !== 'object' || schema === null) {
    return schema;
  }
  const result = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [key, closed(value)])
  );
  return result.type === 'object' ? { ...result, additionalProperties: false } : result;
}

const validateFeed = new Ajv2020({ allErrors: true, validateFormats: false }).compile(
  closed(feedSchema) as object
);

function repository(fullName: string, isPrivate: boolean): RepoEvent['repository'] {
  const [owner = '', name = ''] = fullName.split('/');
  return {
    id: 1,
    name,
    fullName,
    owner,
    url: `https://github.com/${fullName}`,
    private: isPrivate,
    description: 'Secret description',
    stars: 1,
    forks: 0,
    language: 'TypeScript',
  };
}

const sender = {
  id: 7,
  login: 'secret-stargazer',
  avatarUrl: 'https://avatars.githubusercontent.com/u/7',
  url: 'https://github.com/secret-stargazer',
};

function star(fullName: string, count: number, isPrivate = false, removed = false): RepoEvent {
  const payload = { repository: repository(fullName, isPrivate), sender, star: { count } };
  return removed
    ? createRepoEvent(REPO_EVENT_TYPES.STAR_DELETED, {
        action: REPO_EVENT_ACTIONS.DELETED,
        ...payload,
      })
    : createRepoEvent(REPO_EVENT_TYPES.STAR_CREATED, {
        action: REPO_EVENT_ACTIONS.CREATED,
        ...payload,
      });
}

function push(fullName: string, isPrivate = false): RepoEvent {
  return createRepoEvent(REPO_EVENT_TYPES.PUSH_DEFAULT_BRANCH, {
    action: REPO_EVENT_ACTIONS.PUSHED,
    repository: repository(fullName, isPrivate),
    sender,
    push: {
      branch: 'main',
      compareUrl: `https://github.com/${fullName}/compare/a...b`,
      forced: false,
      commits: ['one', 'two'].map((id) => ({
        id,
        message: `Secret commit message ${id}`,
        url: `https://github.com/${fullName}/commit/${id}`,
        author: 'secret-author',
      })),
    },
  });
}

function release(fullName: string, tagName: string): RepoEvent {
  return createRepoEvent(REPO_EVENT_TYPES.RELEASE_PUBLISHED, {
    action: REPO_EVENT_ACTIONS.PUBLISHED,
    repository: repository(fullName, false),
    sender,
    release: {
      tagName,
      name: 'Secret release name',
      url: `https://github.com/${fullName}/releases/tag/${tagName}`,
      body: 'Secret release notes',
      prerelease: false,
    },
  });
}

function pullRequest(
  fullName: string,
  type: 'pull_request.merged' | 'pull_request.opened' | 'pull_request.closed'
): RepoEvent {
  return createRepoEvent(type, {
    action: type === 'pull_request.opened' ? REPO_EVENT_ACTIONS.OPENED : REPO_EVENT_ACTIONS.CLOSED,
    repository: repository(fullName, false),
    sender,
    pullRequest: {
      number: 41,
      title: type === 'pull_request.merged' ? 'Edit hooks from the dashboard' : 'Unmerged work',
      url: `https://github.com/${fullName}/pull/41`,
      state: 'closed',
      merged: type === 'pull_request.merged',
      body: 'Secret pull request body',
      draft: false,
      headBranch: 'secret-branch',
      baseBranch: 'main',
    },
  } as never);
}

function issue(fullName: string): RepoEvent {
  return createRepoEvent(REPO_EVENT_TYPES.ISSUE_OPENED, {
    action: REPO_EVENT_ACTIONS.OPENED,
    repository: repository(fullName, false),
    sender,
    issue: {
      number: 3,
      title: 'Secret issue',
      url: `https://github.com/${fullName}/issues/3`,
      state: 'open',
      body: 'Secret issue body',
      labels: ['secret-label'],
    },
  });
}

function fork(fullName: string): RepoEvent {
  return createRepoEvent(REPO_EVENT_TYPES.FORK_CREATED, {
    action: REPO_EVENT_ACTIONS.CREATED,
    repository: repository(fullName, false),
    sender,
    fork: {
      fullName: 'secret-stargazer/fork',
      url: 'https://github.com/secret-stargazer/fork',
      defaultBranch: 'main',
    },
  });
}

describe('public feed', () => {
  const cleanups: (() => void)[] = [];
  let visibility: Map<string, Visibility>;
  let githubLookups: string[];
  let githubAuthorizations: (string | null)[];
  let beforeAnswer: () => Promise<void> | undefined;
  let cacheEntries: Map<string, string>;
  let env: ReturnType<typeof createTestEnv>;
  let app: ReturnType<typeof createApp>;
  let sequence = 0;

  function githubAnswer(fullName: string): Promise<Response> {
    const answer = visibility.get(fullName) ?? 'not_found';
    switch (answer) {
      case 'public':
      case 'private':
        return Promise.resolve(
          Response.json({ full_name: fullName, private: answer === 'private' })
        );
      case 'no_private_flag':
        return Promise.resolve(Response.json({ full_name: fullName }));
      case 'unreadable':
        return Promise.resolve(new Response('<html>', { status: 200 }));
      case 'not_found':
        return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }));
      case 'moved':
        return Promise.resolve(
          new Response(null, {
            status: 301,
            headers: { Location: 'https://api.github.com/repositories/1' },
          })
        );
      case 'rate_limited':
        return Promise.resolve(
          Response.json(
            { message: 'API rate limit exceeded' },
            { status: 403, headers: { 'X-RateLimit-Remaining': '0' } }
          )
        );
      case 'server_error':
        return Promise.resolve(new Response('unavailable', { status: 502 }));
      case 'timeout':
        return Promise.reject(new DOMException('The operation timed out', 'TimeoutError'));
    }
  }

  async function record(event: RepoEvent, receivedAt: string): Promise<void> {
    sequence += 1;
    await prepareEventHistoryInsert(env.DB, {
      deliveryId: `delivery-${String(sequence)}`,
      repository: event.repository.fullName,
      event,
      receivedAt,
    }).run();
  }

  async function getPublic(
    path: string,
    init: RequestInit = {}
  ): Promise<{ response: Response; text: string }> {
    const { executionCtx, waitForBackground } = createExecutionContext();
    const response = await app.fetch(
      new Request(`https://example.com/public/${path}`, init),
      env,
      executionCtx
    );
    const text = await response.text();
    await waitForBackground();
    return { response, text };
  }

  function getFeed(
    query = '',
    init: RequestInit = {}
  ): Promise<{ response: Response; text: string }> {
    return getPublic(`feed${query}`, init);
  }

  async function feedRepositories(query = ''): Promise<string[]> {
    const { response, text } = await getFeed(query);
    expect(response.status, text).toBe(200);
    const feed = JSON.parse(text) as {
      events: { repo: string }[];
      starHistory: { repo: string }[];
    };
    return [...new Set([...feed.events, ...feed.starHistory].map((item) => item.repo))].sort();
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T08:45:00.000Z'));
    visibility = new Map();
    githubLookups = [];
    githubAuthorizations = [];
    beforeAnswer = (): undefined => undefined;
    cacheEntries = new Map();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        expect(url.origin).toBe('https://api.github.com');
        githubAuthorizations.push(new Headers(init?.headers).get('Authorization'));
        expect(init?.redirect).toBe('manual');
        const fullName = decodeURIComponent(url.pathname.replace(/^\/repos\//, ''));
        githubLookups.push(fullName);
        // GitHub answers asynchronously, after every lookup of the response has started.
        return Promise.resolve().then(async () => {
          await beforeAnswer();
          return githubAnswer(fullName);
        });
      })
    );
    vi.stubGlobal('caches', {
      default: {
        match: (key: string): Promise<Response | undefined> => {
          const body = cacheEntries.get(key);
          return Promise.resolve(body === undefined ? undefined : new Response(body));
        },
        put: async (key: string, response: Response): Promise<void> => {
          cacheEntries.set(key, await response.text());
        },
      },
    });
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);
    env = createTestEnv(tempDatabase.databasePath);
    cleanups.push(() => {
      env.DB.close();
    });
    app = createApp();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it('publishes only the contract fields of public activity in public repositories', async () => {
    visibility.set('ayagmar/pi-mobile', 'public');
    visibility.set('ayagmar/ccdesk', 'public');
    visibility.set('ayagmar/secret', 'not_found');
    visibility.set('ayagmar/flagged', 'private');
    // Before the 90-day window, so neither an event nor a star-history day.
    await record(star('ayagmar/pi-mobile', 90), '2026-07-28T23:59:59.000Z');
    await record(star('ayagmar/pi-mobile', 111), '2026-07-29T00:00:00.000Z');
    await record(star('ayagmar/pi-mobile', 112), '2026-10-24T08:12:00.000Z');
    await record(star('ayagmar/pi-mobile', 113), '2026-10-24T19:31:00.000Z');
    // Unstarred late on the same UTC day: that day ends at 112.
    await record(star('ayagmar/pi-mobile', 112, false, true), '2026-10-24T23:59:00.000Z');
    await record(release('ayagmar/pi-mobile', 'v0.14.1'), '2026-10-25T13:51:53.000Z');
    await record(pullRequest('ayagmar/ccdesk', 'pull_request.merged'), '2026-10-25T16:40:00.000Z');
    await record(push('ayagmar/ccdesk'), '2026-10-25T21:14:00.000Z');
    // Activity that must stay out: other types, a private repository, and an event
    // of a public repository that was recorded while it was private.
    await record(pullRequest('ayagmar/ccdesk', 'pull_request.opened'), '2026-10-26T01:00:00.000Z');
    await record(pullRequest('ayagmar/ccdesk', 'pull_request.closed'), '2026-10-26T01:01:00.000Z');
    await record(issue('ayagmar/ccdesk'), '2026-10-26T01:02:00.000Z');
    await record(fork('ayagmar/ccdesk'), '2026-10-26T01:03:00.000Z');
    await record(push('ayagmar/secret'), '2026-10-26T01:04:00.000Z');
    await record(star('ayagmar/secret', 5), '2026-10-26T01:05:00.000Z');
    await record(star('ayagmar/flagged', 9), '2026-10-26T01:06:00.000Z');
    await record(push('ayagmar/ccdesk', true), '2026-10-26T01:07:00.000Z');
    // An event stored before visibility was recorded (no flag at all).
    await env.DB.prepare(
      `INSERT INTO events (delivery_id, event_type, repository, received_at, event_json)
       VALUES ('legacy', 'push.default_branch', 'ayagmar/ccdesk', '2026-10-26T01:08:00.000Z',
               json_remove(?, '$.repository.private'))`
    )
      .bind(JSON.stringify(push('ayagmar/ccdesk')))
      .run();

    const { response, text } = await getFeed();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const feed: unknown = JSON.parse(text);
    expect(validateFeed(feed), JSON.stringify(validateFeed.errors)).toBe(true);
    expect(feed).toEqual({
      version: 1,
      generatedAt: '2026-10-26T08:45:00.000Z',
      events: [
        {
          type: 'push.default_branch',
          repo: 'ayagmar/ccdesk',
          at: '2026-10-25T21:14:00.000Z',
          url: 'https://github.com/ayagmar/ccdesk/compare/a...b',
          push: { commits: 2 },
        },
        {
          type: 'pull_request.merged',
          repo: 'ayagmar/ccdesk',
          at: '2026-10-25T16:40:00.000Z',
          url: 'https://github.com/ayagmar/ccdesk/pull/41',
          pullRequest: { number: 41, title: 'Edit hooks from the dashboard' },
        },
        {
          type: 'release.published',
          repo: 'ayagmar/pi-mobile',
          at: '2026-10-25T13:51:53.000Z',
          url: 'https://github.com/ayagmar/pi-mobile/releases/tag/v0.14.1',
          release: { tag: 'v0.14.1' },
        },
        {
          type: 'star.created',
          repo: 'ayagmar/pi-mobile',
          at: '2026-10-24T19:31:00.000Z',
          star: { count: 113 },
        },
        {
          type: 'star.created',
          repo: 'ayagmar/pi-mobile',
          at: '2026-10-24T08:12:00.000Z',
          star: { count: 112 },
        },
        {
          type: 'star.created',
          repo: 'ayagmar/pi-mobile',
          at: '2026-07-29T00:00:00.000Z',
          star: { count: 111 },
        },
      ],
      starHistory: [
        {
          repo: 'ayagmar/pi-mobile',
          points: [
            { date: '2026-07-29', stars: 111 },
            { date: '2026-10-24', stars: 112 },
          ],
        },
      ],
    });
    expect(text).not.toMatch(/secret|avatar|sender|login|delivery/i);
    expect(new Set(githubAuthorizations)).toEqual(new Set([null]));
  });

  it('answers HEAD without a body and rejects bad limits and other methods', async () => {
    for (const day of ['01', '02', '03']) {
      await record(star('ayagmar/pi-mobile', Number(day)), `2026-10-${day}T00:00:00.000Z`);
    }
    visibility.set('ayagmar/pi-mobile', 'public');

    const limited = await getFeed('?limit=02&since=2026-01-01');
    expect(JSON.parse(limited.text)).toMatchObject({
      events: [{ star: { count: 3 } }, { star: { count: 2 } }],
    });

    const head = await getFeed('', { method: 'HEAD' });
    expect(head.response.status).toBe(200);
    expect(head.text).toBe('');

    for (const limit of ['', '0', '101', '1.5', '-1', '+5', 'abc', '1e2']) {
      const { response, text } = await getFeed(`?limit=${limit}`);
      expect(response.status, limit).toBe(400);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(JSON.parse(text)).toEqual({ error: 'invalid_query' });
    }

    for (const method of ['POST', 'PUT', 'DELETE']) {
      const { response } = await getFeed('', { method });
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, HEAD');
    }
  });

  it('hides internal failures', async () => {
    await env.DB.exec('DROP TABLE events');

    const { response, text } = await getFeed();

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.parse(text)).toEqual({ error: 'internal_error' });
  });

  it('serves the feed without the webhook and admin secrets', async () => {
    env = { ...env, GITHUB_WEBHOOK_SECRET: undefined, ADMIN_API_TOKEN: undefined } as never;

    const { response } = await getFeed();

    expect(response.status).toBe(200);
  });

  it('drops a repository made private within 60 seconds, even from cached material', async () => {
    visibility.set('ayagmar/runnerd', 'public');
    await record(push('ayagmar/runnerd'), '2026-10-25T21:14:00.000Z');
    await expect(feedRepositories()).resolves.toEqual(['ayagmar/runnerd']);

    // From here on, responses must come from the cached material: the history is gone.
    await env.DB.exec('DELETE FROM events');
    visibility.set('ayagmar/runnerd', 'not_found');
    vi.setSystemTime(new Date('2026-10-26T08:45:59.999Z'));
    await expect(feedRepositories()).resolves.toEqual(['ayagmar/runnerd']);
    expect(githubLookups).toEqual(['ayagmar/runnerd']);

    vi.setSystemTime(new Date('2026-10-26T08:46:00.000Z'));
    await expect(feedRepositories()).resolves.toEqual([]);
    expect(githubLookups).toEqual(['ayagmar/runnerd', 'ayagmar/runnerd']);
  });

  it('never lets a late or replayed public webhook bring back a private repository', async () => {
    visibility.set('ayagmar/runnerd', 'not_found');
    await record(push('ayagmar/runnerd', true), '2026-10-25T21:00:00.000Z');
    // Recorded as public, but delivered after the repository was made private.
    await record(push('ayagmar/runnerd'), '2026-10-25T21:14:00.000Z');
    await record(star('ayagmar/runnerd', 4), '2026-10-25T21:15:00.000Z');

    await expect(feedRepositories()).resolves.toEqual([]);
  });

  it('omits a repository whenever GitHub does not confirm it is public', async () => {
    visibility.set('ayagmar/runnerd', 'public');
    await record(push('ayagmar/runnerd'), '2026-10-25T21:14:00.000Z');
    const answers: Visibility[] = [
      'private',
      'moved',
      'rate_limited',
      'server_error',
      'timeout',
      'no_private_flag',
      'unreadable',
    ];
    for (const answer of answers) {
      visibility.set(`ayagmar/${answer.replaceAll('_', '-')}`, answer);
      await record(push(`ayagmar/${answer.replaceAll('_', '-')}`), '2026-10-25T21:14:00.000Z');
    }

    await expect(feedRepositories()).resolves.toEqual(['ayagmar/runnerd']);
    expect(githubLookups).toHaveLength(answers.length + 1);
  });

  it('answers 503, never an empty feed, when no repository is admitted and a lookup failed', async () => {
    const expectStatus = async (status: 200 | 503): Promise<void> => {
      const { response, text } = await getFeed();
      expect(response.status, text).toBe(status);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(JSON.parse(text)).toMatchObject(
        status === 503 ? { error: 'visibility_unavailable' } : { events: [], starHistory: [] }
      );
    };
    // No candidates: nothing to hide.
    await expectStatus(200);

    // One definitive denial plus one timeout.
    visibility.set('ayagmar/runnerd', 'not_found');
    visibility.set('ayagmar/ccdesk', 'timeout');
    await record(push('ayagmar/runnerd'), '2026-10-25T21:14:00.000Z');
    await record(push('ayagmar/ccdesk'), '2026-10-25T21:15:00.000Z');
    app = createApp();
    cacheEntries.clear();
    await expectStatus(503);

    // The cached failure still counts, without asking GitHub again.
    vi.setSystemTime(new Date('2026-10-26T08:45:59.999Z'));
    visibility.set('ayagmar/ccdesk', 'private');
    await expectStatus(503);
    expect(githubLookups).toHaveLength(2);

    // Every candidate definitively denied: an empty feed.
    vi.setSystemTime(new Date('2026-10-26T08:46:00.000Z'));
    await expectStatus(200);

    // Candidates the lookup budget leaves unattempted are unresolved too.
    for (let index = 0; index < 41; index += 1) {
      await record(push(`ayagmar/repo-${String(index)}`), '2026-10-25T22:00:00.000Z');
    }
    app = createApp();
    cacheEntries.clear();
    await expectStatus(503);
  });

  it('answers 503 when an admitted repository leaves the star window at UTC midnight', async () => {
    vi.setSystemTime(new Date('2026-10-26T23:59:59.900Z'));
    // ccdesk's only star day is the first of the 90; at midnight it leaves the window.
    visibility.set('ayagmar/ccdesk', 'public');
    await record(star('ayagmar/ccdesk', 3), '2026-07-29T12:00:00.000Z');
    visibility.set('ayagmar/runnerd', 'timeout');
    await record(star('ayagmar/runnerd', 8), '2026-10-26T12:00:00.000Z');
    beforeAnswer = (): undefined => {
      vi.setSystemTime(new Date('2026-10-27T00:00:00.000Z'));
    };

    // With limit=1 ccdesk is only in star history.
    const { response, text } = await getFeed('?limit=1');

    expect(response.status, text).toBe(503);
  });

  it('answers an empty feed when every candidate leaves the star window at UTC midnight', async () => {
    vi.setSystemTime(new Date('2026-10-26T23:59:59.900Z'));
    // Removed stars: star history only, no published events.
    visibility.set('ayagmar/ccdesk', 'public');
    await record(star('ayagmar/ccdesk', 3, false, true), '2026-07-29T12:00:00.000Z');
    visibility.set('ayagmar/runnerd', 'timeout');
    await record(star('ayagmar/runnerd', 8, false, true), '2026-07-29T13:00:00.000Z');
    beforeAnswer = (): undefined => {
      vi.setSystemTime(new Date('2026-10-27T00:00:00.000Z'));
    };

    const { response, text } = await getFeed();

    expect(response.status, text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ events: [], starHistory: [] });
  });

  it('never shows a repository on an answer older than 60 seconds when GitHub fails', async () => {
    visibility.set('ayagmar/runnerd', 'public');
    await record(push('ayagmar/runnerd'), '2026-10-25T21:14:00.000Z');
    await expect(feedRepositories()).resolves.toEqual(['ayagmar/runnerd']);

    for (const [offsetSeconds, failure] of [
      [60, 'timeout'],
      [120, 'rate_limited'],
      [180, 'server_error'],
    ] as const) {
      visibility.set('ayagmar/runnerd', failure);
      vi.setSystemTime(new Date(Date.parse('2026-10-26T08:45:00.000Z') + offsetSeconds * 1000));
      const { response, text } = await getFeed();
      expect(response.status, failure).toBe(503);
      expect(JSON.parse(text)).toEqual({ error: 'visibility_unavailable' });
    }
  });

  it('answers from GitHub answers under 60 seconds old across restarts', async () => {
    const repositories = ['ayagmar/runnerd', 'ayagmar/ccdesk', 'ayagmar/glimpse'];
    const kinds: Visibility[] = [
      'public',
      'public',
      'private',
      'not_found',
      'moved',
      'rate_limited',
      'server_error',
      'timeout',
      'no_private_flag',
      'unreadable',
    ];
    const outcome = (kind: Visibility): 'public' | 'denied' | 'unresolved' =>
      kind === 'public'
        ? 'public'
        : kind === 'private' || kind === 'not_found'
          ? 'denied'
          : 'unresolved';
    for (const fullName of repositories) {
      await record(push(fullName), '2026-10-25T21:14:00.000Z');
    }

    let cachedAnswers = 0;
    for (let seed = 1; seed <= 5; seed += 1) {
      // Park-Miller: every product stays an exact integer.
      let state = seed;
      const random = (bound: number): number => {
        state = (state * 48_271) % 2_147_483_647;
        return state % bound;
      };
      // What a correct isolate remembers: each repository's last answer and when it was asked.
      let answers = new Map<string, { kind: Visibility; askedAt: number }>();
      app = createApp();
      for (let step = 0; step < 40; step += 1) {
        for (const fullName of repositories) {
          visibility.set(fullName, kinds[random(kinds.length)] ?? 'public');
        }
        if (random(8) === 0) {
          app = createApp();
          answers = new Map();
        }
        vi.setSystemTime(new Date(Date.now() + random(90) * 1000));
        let lookups = 0;
        for (const fullName of repositories) {
          const answer = answers.get(fullName);
          if (answer === undefined || Date.now() >= answer.askedAt + 60_000) {
            lookups += 1;
            answers.set(fullName, {
              kind: visibility.get(fullName) ?? 'not_found',
              askedAt: Date.now(),
            });
          }
        }
        cachedAnswers += repositories.length - lookups;
        const lookupsBefore = githubLookups.length;
        const outcomes = repositories.map((fullName) =>
          outcome(answers.get(fullName)?.kind ?? 'not_found')
        );
        const admitted = repositories.filter((_, index) => outcomes[index] === 'public');

        const { response, text } = await getFeed();

        const label = `seed ${String(seed)}, step ${String(step)}`;
        expect(githubLookups.length - lookupsBefore, label).toBe(lookups);
        if (admitted.length === 0 && outcomes.includes('unresolved')) {
          expect(response.status, label).toBe(503);
        } else {
          expect(response.status, label).toBe(200);
          const feed = JSON.parse(text) as { events: { repo: string }[] };
          expect(feed.events.map((event) => event.repo).sort(), label).toEqual(admitted.sort());
        }
      }
    }
    // The sequences reuse cached answers, not only fresh lookups.
    expect(cachedAnswers).toBeGreaterThan(100);
  });

  it('looks up at most 40 repositories per response and omits the rest', async () => {
    for (let index = 0; index < 45; index += 1) {
      const fullName = `ayagmar/repo-${String(index)}`;
      visibility.set(fullName, 'public');
      await record(push(fullName), new Date(Date.UTC(2026, 9, 25, 0, index)).toISOString());
    }

    const repositories = await feedRepositories();

    expect(githubLookups).toHaveLength(40);
    expect(repositories).toHaveLength(40);
    // The newest activity is checked first.
    expect(repositories).toContain('ayagmar/repo-44');
    expect(repositories).not.toContain('ayagmar/repo-0');
  });

  it('drops an admission that expires while other lookups are pending', async () => {
    visibility.set('ayagmar/runnerd', 'public');
    await record(push('ayagmar/runnerd'), '2026-10-25T21:14:00.000Z');
    await expect(feedRepositories()).resolves.toEqual(['ayagmar/runnerd']);

    // At 59 seconds runnerd's answer is still fresh, but the lookup for a new
    // repository answers once it has turned 60 seconds old.
    visibility.set('ayagmar/runnerd', 'not_found');
    visibility.set('ayagmar/ccdesk', 'public');
    await record(push('ayagmar/ccdesk'), '2026-10-25T21:15:00.000Z');
    vi.setSystemTime(new Date('2026-10-26T08:45:59.000Z'));
    beforeAnswer = (): undefined => {
      vi.setSystemTime(new Date('2026-10-26T08:46:00.000Z'));
    };

    // Cold material caches, so the material is read again and includes ccdesk.
    cacheEntries.clear();
    app = createApp();
    await expect(feedRepositories()).resolves.toEqual(['ayagmar/ccdesk']);
  });

  it('reads only well-formed events recorded as public', async () => {
    visibility.set('ayagmar/runnerd', 'public');
    await record(push('ayagmar/runnerd'), '2026-10-25T21:00:00.000Z');
    const stored: [RepoEvent, string, string][] = [
      [
        push('ayagmar/runnerd'),
        '2026-10-25T21:01:00.000Z',
        `json_set(?, '$.repository.private', 0)`,
      ],
      [
        push('ayagmar/runnerd'),
        '2026-10-25T21:02:00.000Z',
        `json_set(?, '$.repository.private', json('null'))`,
      ],
      [
        push('ayagmar/runnerd'),
        '2026-10-25T21:03:00.000Z',
        `json_set(?, '$.repository.private', 'false')`,
      ],
      [
        star('ayagmar/runnerd', 3),
        '2026-10-25T21:04:00.000Z',
        `json_set(?, '$.repository.private', 0)`,
      ],
      [
        push('ayagmar/runnerd'),
        '2026-10-25T21:05:00.000Z',
        `json_set(?, '$.push.commits', json('null'))`,
      ],
      [
        push('ayagmar/runnerd'),
        '2026-10-25T21:06:00.000Z',
        `json_set(?, '$.push.compareUrl', 'https://github.com/ayagmar/runnerd/compare/a...b c')`,
      ],
      [
        star('ayagmar/runnerd', 4),
        '2026-10-25T21:07:00.000Z',
        `json_set(?, '$.star.count', json('true'))`,
      ],
      [
        pullRequest('ayagmar/runnerd', 'pull_request.merged'),
        '2026-10-25T21:08:00.000Z',
        `json_set(?, '$.pullRequest.title', json('{"body":"Secret body","login":"secret"}'))`,
      ],
      [
        release('ayagmar/runnerd', 'v1.0.0'),
        '2026-10-25T21:09:00.000Z',
        `json_set(?, '$.release.tagName', json('["secret-tag"]'))`,
      ],
      [push('ayagmar/runnerd'), 'yesterday', '?'],
      [push('ayagmar/runnerd'), '+010000-01-01T00:00:00.000Z', '?'],
    ];
    for (const [index, [event, receivedAt, eventJson]] of stored.entries()) {
      await env.DB.prepare(
        `INSERT INTO events (delivery_id, event_type, repository, received_at, event_json)
         VALUES (?, ?, ?, ?, ${eventJson})`
      )
        .bind(
          `malformed-${String(index)}`,
          event.type,
          event.repository.fullName,
          receivedAt,
          JSON.stringify(event)
        )
        .run();
    }

    const { text } = await getFeed();

    const feed: unknown = JSON.parse(text);
    expect(validateFeed(feed), JSON.stringify(validateFeed.errors)).toBe(true);
    expect(text).not.toMatch(/secret/i);
    expect(feed).toMatchObject({
      events: [{ type: 'push.default_branch', at: '2026-10-25T21:00:00.000Z' }],
      starHistory: [],
    });
    expect(JSON.parse(text)).toHaveProperty('events.length', 1);
  });

  it('keeps cached star history to the last 90 days after UTC midnight', async () => {
    visibility.set('ayagmar/pi-mobile', 'public');
    vi.setSystemTime(new Date('2026-10-26T23:59:00.000Z'));
    await record(star('ayagmar/pi-mobile', 1), '2026-07-29T12:00:00.000Z');
    await record(star('ayagmar/pi-mobile', 2), '2026-10-26T12:00:00.000Z');
    const before = await getFeed();
    expect(JSON.parse(before.text)).toMatchObject({
      starHistory: [{ points: [{ date: '2026-07-29' }, { date: '2026-10-26' }] }],
    });

    vi.setSystemTime(new Date('2026-10-27T00:01:00.000Z'));
    const after = await getFeed();

    expect(cacheEntries.size).toBe(1);
    expect(JSON.parse(after.text)).toMatchObject({
      generatedAt: '2026-10-27T00:01:00.000Z',
      starHistory: [{ points: [{ date: '2026-10-26', stars: 2 }] }],
    });
    expect(JSON.parse(after.text)).toHaveProperty('starHistory.0.points.length', 1);
  });

  it('keeps the private answer when concurrent lookups disagree', async () => {
    await record(push('ayagmar/runnerd'), '2026-10-25T21:14:00.000Z');
    for (const answers of [
      ['public', 'not_found'],
      ['not_found', 'public'],
    ] as const) {
      app = createApp();
      cacheEntries.clear();
      let calls = 0;
      beforeAnswer = async (): Promise<void> => {
        const call = calls;
        calls += 1;
        // The second answer arrives after the first one is cached.
        if (call === 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        visibility.set('ayagmar/runnerd', answers[call] ?? 'not_found');
      };

      // Both lookups are sent in the same millisecond: the fake clock does not move.
      const concurrent = await Promise.all([feedRepositories(), feedRepositories()]);

      expect(calls).toBe(2);
      expect(concurrent.filter((repositories) => repositories.length > 0).length).toBeLessThan(2);
      await expect(feedRepositories()).resolves.toEqual([]);
    }
  });

  it('caps star history at 50 repositories among the ones GitHub admits', async () => {
    visibility.set('ayagmar/public', 'public');
    await record(star('ayagmar/public', 7, false, true), '2026-10-01T12:00:00.000Z');
    for (let index = 0; index < 50; index += 1) {
      const fullName = `ayagmar/private-${String(index)}`;
      visibility.set(fullName, 'not_found');
      await record(
        star(fullName, 1, false, true),
        new Date(Date.UTC(2026, 9, 25, 0, index)).toISOString()
      );
    }

    // The first response spends its 40 lookups on the most recently starred and,
    // admitting none of them, cannot tell the rest are not public.
    expect((await getFeed()).response.status).toBe(503);
    const { text } = await getFeed();

    const feed: unknown = JSON.parse(text);
    expect(validateFeed(feed), JSON.stringify(validateFeed.errors)).toBe(true);
    expect(feed).toMatchObject({
      starHistory: [{ repo: 'ayagmar/public', points: [{ date: '2026-10-01', stars: 7 }] }],
    });
  });

  it('looks up with the public-only token, never with the App token', async () => {
    env = { ...env, GITHUB_PUBLIC_TOKEN: 'test-public-token' };
    visibility.set('ayagmar/runnerd', 'public');
    visibility.set('ayagmar/trellis', 'private');
    await record(push('ayagmar/runnerd'), '2026-10-25T21:14:00.000Z');
    await record(push('ayagmar/trellis'), '2026-10-25T21:15:00.000Z');

    await expect(feedRepositories()).resolves.toEqual(['ayagmar/runnerd']);
    expect(githubAuthorizations).toEqual(['Bearer test-public-token', 'Bearer test-public-token']);
  });

  it('reads D1 at most once per 300 seconds per isolate, even without the Cache API', async () => {
    vi.stubGlobal('caches', undefined);
    visibility.set('ayagmar/runnerd', 'public');
    await record(push('ayagmar/runnerd'), '2026-10-25T21:14:00.000Z');
    await expect(feedRepositories()).resolves.toEqual(['ayagmar/runnerd']);

    // Any further D1 read would see the history gone.
    await env.DB.exec('DELETE FROM events');
    vi.setSystemTime(new Date('2026-10-26T08:49:59.999Z'));
    await expect(feedRepositories()).resolves.toEqual(['ayagmar/runnerd']);

    vi.setSystemTime(new Date('2026-10-26T08:50:00.000Z'));
    await expect(feedRepositories()).resolves.toEqual([]);
  });

  /**
   * More published candidates than the largest limit, newest first: an unpublishable
   * release (dropped after the limit is applied), private and unpublished activity
   * the query skips, a star outside the window, and more repositories than one
   * response may look up.
   */
  async function recordLimitScenario(): Promise<void> {
    await record(star('o/r0', 1), '2026-07-01T00:00:00.000Z');
    for (let index = 0; index < 45; index += 1) {
      const fullName = `o/r${String(index)}`;
      visibility.set(fullName, index % 9 === 4 ? 'not_found' : 'public');
      await record(push(fullName), new Date(Date.UTC(2026, 9, 25, 2, index)).toISOString());
    }
    visibility.set('o/r10', 'rate_limited');
    for (let index = 0; index < 60; index += 1) {
      await record(
        star(`o/r${String((index * 7) % 45)}`, index + 1, false, index % 11 === 0),
        new Date(Date.UTC(2026, 7, 1 + index, 12)).toISOString()
      );
    }
    await record(release('o/r1', 'v1.0.0'), '2026-10-25T20:00:00.000Z');
    await record(pullRequest('o/r2', 'pull_request.merged'), '2026-10-25T21:00:00.000Z');
    for (let index = 0; index < 5; index += 1) {
      await record(release('o/r3', 'v'.repeat(201)), `2026-10-25T22:0${String(index)}:00.000Z`);
      await record(push('o/r5', true), `2026-10-25T22:1${String(index)}:00.000Z`);
      await record(issue('o/r6'), `2026-10-25T22:2${String(index)}:00.000Z`);
    }
  }

  it('answers every limit as when material was read per limit', async () => {
    await recordLimitScenario();
    const cold: Record<string, string> = {};
    for (const limit of [1, 20, 100]) {
      app = createApp();
      cacheEntries.clear();
      cold[limit] = (await getFeed(`?limit=${String(limit)}`)).text;
    }
    app = createApp();
    cacheEntries.clear();
    const warm: Record<string, string> = {};
    for (const limit of [100, 1, 20, 50]) {
      warm[limit] = (await getFeed(`?limit=${String(limit)}`)).text;
    }

    expect({ cold, warm }).toEqual(feedLimitsGolden);
  });

  it('reads D1 once for every limit, from memory or the Cache API', async () => {
    await recordLimitScenario();
    const golden = feedLimitsGolden as {
      cold: Record<string, string>;
      warm: Record<string, string>;
    };
    expect((await getFeed('?limit=100')).text).toBe(golden.warm['100']);

    // Any further D1 read would see the history gone.
    await env.DB.exec('DELETE FROM events');
    for (const limit of [1, 20, 50]) {
      expect((await getFeed(`?limit=${String(limit)}`)).text, String(limit)).toBe(
        golden.warm[String(limit)]
      );
    }
    // Another isolate at the same location, so only the Cache API has the material.
    app = createApp();
    expect((await getFeed('?limit=20')).text).toBe(golden.cold['20']);
    expect(cacheEntries.size).toBe(1);
  });

  it('serves every limit when the Cache API fails, and an empty history as an empty feed', async () => {
    vi.stubGlobal('caches', {
      default: {
        match: (): Promise<undefined> => Promise.resolve(undefined),
        put: (): Promise<void> => Promise.reject(new Error('cache unavailable')),
      },
    });
    const warn = vi.mocked(console.warn);
    warn.mockClear();

    for (const limit of [1, 20, 100]) {
      const { response, text } = await getFeed(`?limit=${String(limit)}`);
      expect(response.status, String(limit)).toBe(200);
      expect(JSON.parse(text)).toEqual({
        version: 1,
        generatedAt: '2026-10-26T08:45:00.000Z',
        events: [],
        starHistory: [],
      });
    }
    expect(
      warn.mock.calls.filter(([entry]) =>
        String(entry).includes('public_feed.material_cache_failed')
      )
    ).toHaveLength(1);
  });

  it('rate limits each client', async () => {
    const allowed = new Map<string, number>([
      ['198.51.100.1', 1],
      ['198.51.100.2', 1],
    ]);
    env = {
      ...env,
      FEED_RATE_LIMIT: {
        limit: ({ key }: { key: string }): Promise<{ success: boolean }> => {
          const remaining = allowed.get(key) ?? 0;
          allowed.set(key, remaining - 1);
          return Promise.resolve({ success: remaining > 0 });
        },
      },
    };
    const fromClient = (ip: string): Promise<{ response: Response; text: string }> =>
      getFeed('', { headers: { 'CF-Connecting-IP': ip } });

    await expect(fromClient('198.51.100.1')).resolves.toHaveProperty('response.status', 200);
    const limited = await fromClient('198.51.100.1');
    await expect(fromClient('198.51.100.2')).resolves.toHaveProperty('response.status', 200);

    expect(limited.response.status).toBe(429);
    expect(limited.response.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.parse(limited.text)).toEqual({ error: 'rate_limited' });
    // One budget for both routes.
    const activity = await getPublic('activity', {
      headers: { 'CF-Connecting-IP': '198.51.100.1' },
    });
    expect(activity.response.status).toBe(429);
  });

  describe('daily activity', () => {
    interface Counts {
      pushes: number;
      commits: number;
      merges: number;
      releases: number;
      stars: number;
    }
    interface Day extends Counts {
      date: string;
      repos: (Counts & { repo: string })[];
      reposTruncated: boolean;
    }
    interface Activity {
      since: string | null;
      complete: boolean;
      days: Day[];
    }

    async function getActivity(
      query = ''
    ): Promise<{ status: number; headers: Headers; body: Activity }> {
      const { response, text } = await getPublic(`activity${query}`);
      const body = JSON.parse(text) as Activity;
      // A consumer may keep only the per-repository rows: unless the list is
      // truncated, they must add up to the day.
      for (const day of response.status === 200 ? body.days : []) {
        if (!day.reposTruncated) {
          for (const field of ['pushes', 'commits', 'merges', 'releases', 'stars'] as const) {
            const total = day.repos.reduce((sum, repo) => sum + repo[field], 0);
            expect(total, `${day.date} ${field}`).toBe(day[field]);
          }
        }
      }
      return { status: response.status, headers: response.headers, body };
    }

    const none: Counts = { pushes: 0, commits: 0, merges: 0, releases: 0, stars: 0 };
    const zero = (date: string): Day => ({ date, ...none, repos: [], reposTruncated: false });

    it('sums public activity per UTC day, zero-filled, from public repositories only', async () => {
      visibility.set('ayagmar/ccdesk', 'public');
      visibility.set('ayagmar/pi-mobile', 'public');
      visibility.set('ayagmar/secret', 'not_found');
      visibility.set('ayagmar/flagged', 'private');
      // Older than the window: only `since` sees it.
      await record(push('ayagmar/ccdesk'), '2026-09-30T12:00:00.000Z');
      // One minute either side of UTC midnight.
      await record(push('ayagmar/ccdesk'), '2026-10-23T23:59:00.000Z');
      await record(push('ayagmar/ccdesk'), '2026-10-24T00:01:00.000Z');
      await record(push('ayagmar/ccdesk'), '2026-10-24T09:00:00.000Z');
      await record(
        pullRequest('ayagmar/ccdesk', 'pull_request.merged'),
        '2026-10-24T10:00:00.000Z'
      );
      await record(release('ayagmar/pi-mobile', 'v0.14.1'), '2026-10-24T11:00:00.000Z');
      await record(star('ayagmar/pi-mobile', 112), '2026-10-24T12:00:00.000Z');
      await record(star('ayagmar/pi-mobile', 113), '2026-10-26T08:00:00.000Z');
      // Not counted: unpublished types, a star removed, repositories GitHub does not
      // show as public, an event recorded while private, and one stored without a flag.
      await record(star('ayagmar/pi-mobile', 112, false, true), '2026-10-24T13:00:00.000Z');
      await record(
        pullRequest('ayagmar/ccdesk', 'pull_request.opened'),
        '2026-10-24T13:01:00.000Z'
      );
      await record(issue('ayagmar/ccdesk'), '2026-10-24T13:02:00.000Z');
      await record(fork('ayagmar/ccdesk'), '2026-10-24T13:03:00.000Z');
      await record(push('ayagmar/secret'), '2026-10-24T13:04:00.000Z');
      await record(star('ayagmar/flagged', 9), '2026-10-24T13:05:00.000Z');
      await record(push('ayagmar/ccdesk', true), '2026-10-24T13:06:00.000Z');
      await env.DB.prepare(
        `INSERT INTO events (delivery_id, event_type, repository, received_at, event_json)
         VALUES ('legacy', 'push.default_branch', 'ayagmar/ccdesk', '2026-10-24T13:07:00.000Z',
                 json_remove(?, '$.repository.private'))`
      )
        .bind(JSON.stringify(push('ayagmar/ccdesk')))
        .run();

      const { status, headers, body } = await getActivity('?days=5');

      expect(status).toBe(200);
      expect(headers.get('Cache-Control')).toBe('no-store');
      expect(headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(body).toEqual({
        generatedAt: '2026-10-26T08:45:00.000Z',
        since: '2026-09-30',
        // Denied repositories are known not to be public: nothing is missing.
        complete: true,
        days: [
          zero('2026-10-22'),
          {
            ...zero('2026-10-23'),
            pushes: 1,
            commits: 2,
            repos: [{ repo: 'ayagmar/ccdesk', ...none, pushes: 1, commits: 2 }],
          },
          {
            date: '2026-10-24',
            pushes: 2,
            commits: 4,
            merges: 1,
            releases: 1,
            stars: 1,
            repos: [
              { repo: 'ayagmar/ccdesk', ...none, pushes: 2, commits: 4, merges: 1 },
              { repo: 'ayagmar/pi-mobile', ...none, releases: 1, stars: 1 },
            ],
            reposTruncated: false,
          },
          zero('2026-10-25'),
          {
            ...zero('2026-10-26'),
            stars: 1,
            repos: [{ repo: 'ayagmar/pi-mobile', ...none, stars: 1 }],
          },
        ],
      });
    });

    it('keeps the 50 busiest repositories of a day, by name, and counts them all', async () => {
      for (let index = 0; index < 52; index += 1) {
        const fullName = `o/r${String(index).padStart(2, '0')}`;
        visibility.set(fullName, 'public');
        await record(star(fullName, 1), new Date(Date.UTC(2026, 9, 25, 10, index)).toISOString());
      }
      // The two last by name are the busiest; of the 50 tied, the first 48 by name stay.
      await record(push('o/r50'), '2026-10-25T12:00:00.000Z');
      await record(push('o/r51'), '2026-10-25T12:01:00.000Z');

      // A response looks up at most 40 repositories, so the first one counts only
      // the 40 most recently active; the next, within 60 seconds, looks up the rest.
      const first = await getActivity('?days=2');
      expect(first.body.complete).toBe(false);
      expect(first.body.days[0]).toMatchObject({ pushes: 2, stars: 40, reposTruncated: false });
      const { body } = await getActivity('?days=2');
      expect(body.complete).toBe(true);

      const [day] = body.days;
      expect(day).toMatchObject({ date: '2026-10-25', pushes: 2, commits: 4, stars: 52 });
      expect(day?.reposTruncated).toBe(true);
      expect(day?.repos.map((repo) => repo.repo)).toEqual([
        ...Array.from({ length: 48 }, (_, index) => `o/r${String(index).padStart(2, '0')}`),
        'o/r50',
        'o/r51',
      ]);
      expect(day?.repos.at(-1)).toEqual({
        repo: 'o/r51',
        ...none,
        pushes: 1,
        commits: 2,
        stars: 1,
      });
    });

    it('counts exactly the events the feed publishes', async () => {
      const tag = (length: number): string => 'v'.repeat(length);
      // Each case in its own repository; `publishes` is what the feed does with it.
      const cases: {
        event: RepoEvent;
        publishes: boolean;
        at?: string;
        set?: [string, unknown];
      }[] = [
        { event: push('o/push'), publishes: true },
        { event: star('o/star', 3), publishes: true },
        { event: release('o/release', 'v1.0.0'), publishes: true },
        { event: pullRequest('o/merged', 'pull_request.merged'), publishes: true },
        { event: release('o/tag-200', tag(200)), publishes: true },
        // 300 UTF-16 units, 150 code points: lengths count code points, as the schema does.
        { event: release('o/tag-emoji', '\u{1F600}'.repeat(150)), publishes: true },
        {
          event: pullRequest('o/title-300', 'pull_request.merged'),
          publishes: true,
          set: ['$.pullRequest.title', 't'.repeat(300)],
        },
        // The webhook mapper accepts any nonempty tag.
        { event: release('o/tag-201', tag(201)), publishes: false },
        { event: release('o/tag-empty', 'v1'), publishes: false, set: ['$.release.tagName', ''] },
        {
          event: release('o/url-host', 'v1'),
          publishes: false,
          set: ['$.release.url', 'https://example.com/o/url-host'],
        },
        {
          event: release('o/url-nbsp', 'v1'),
          publishes: false,
          set: ['$.release.url', 'https://github.com/o/url nbsp'],
        },
        {
          event: release('o/url-line', 'v1'),
          publishes: false,
          set: ['$.release.url', 'https://github.com/o/url line'],
        },
        {
          event: push('o/url-2049'),
          publishes: false,
          set: ['$.push.compareUrl', `https://github.com/${'a'.repeat(2030)}`],
        },
        {
          event: push('o/url-space'),
          publishes: false,
          set: ['$.push.compareUrl', 'https://github.com/o/a...b c'],
        },
        {
          event: pullRequest('o/title-301', 'pull_request.merged'),
          publishes: false,
          set: ['$.pullRequest.title', 't'.repeat(301)],
        },
        // SQLite's length() and GLOB stop at U+0000, so neither route publishes it.
        {
          event: pullRequest('o/title-nul', 'pull_request.merged'),
          publishes: false,
          set: ['$.pullRequest.title', '\u0000'],
        },
        {
          event: pullRequest('o/title-nul-301', 'pull_request.merged'),
          publishes: false,
          set: ['$.pullRequest.title', `a\u0000${'x'.repeat(300)}`],
        },
        {
          event: release('o/url-nul-newline', 'v1'),
          publishes: false,
          set: ['$.release.url', 'https://github.com/o/url\u0000\n'],
        },
        {
          event: pullRequest('o/title-object', 'pull_request.merged'),
          publishes: false,
          set: ['$.pullRequest.title', { body: 'x' }],
        },
        {
          event: pullRequest('o/number-0', 'pull_request.merged'),
          publishes: false,
          set: ['$.pullRequest.number', 0],
        },
        {
          event: pullRequest('o/number-real', 'pull_request.merged'),
          publishes: false,
          set: ['$.pullRequest.number', 1.5],
        },
        {
          event: pullRequest('o/number-text', 'pull_request.merged'),
          publishes: false,
          set: ['$.pullRequest.number', '41'],
        },
        { event: push('o/commits-null'), publishes: false, set: ['$.push.commits', null] },
        {
          event: push('o/commits-10001'),
          publishes: false,
          set: ['$.push.commits', Array.from({ length: 10_001 }, () => 'c')],
        },
        { event: star('o/count-true', 1), publishes: false, set: ['$.star.count', true] },
        { event: star('o/count-negative', 1), publishes: false, set: ['$.star.count', -1] },
        {
          event: star('o/count-unsafe', 1),
          publishes: false,
          set: ['$.star.count', Number.MAX_SAFE_INTEGER + 1],
        },
        { event: push('o/at-hour-24'), publishes: false, at: '2026-10-25T24:00:00.000Z' },
        { event: push('o/at-no-ms'), publishes: false, at: '2026-10-25T21:00:00Z' },
        { event: star('o/unstarred', 2, false, true), publishes: false },
        { event: pullRequest('o/opened', 'pull_request.opened'), publishes: false },
        { event: issue('o/issue'), publishes: false },
      ];
      for (const [index, { event, at, set }] of cases.entries()) {
        visibility.set(event.repository.fullName, 'public');
        await env.DB.prepare(
          `INSERT INTO events (delivery_id, event_type, repository, received_at, event_json)
           VALUES (?, ?, ?, ?, ${set ? 'json_set(?, ?, json(?))' : '?'})`
        )
          .bind(
            `parity-${String(index)}`,
            event.type,
            event.repository.fullName,
            at ?? new Date(Date.UTC(2026, 9, 25, 20, index)).toISOString(),
            JSON.stringify(event),
            ...(set ? [set[0], JSON.stringify(set[1])] : [])
          )
          .run();
      }

      const feed = JSON.parse((await getFeed('?limit=100')).text) as {
        events: { type: string; repo: string; push?: { commits: number } }[];
      };
      const { body } = await getActivity('?days=2');

      const fromFeed = new Map<string, Counts>();
      for (const event of feed.events) {
        const counts = fromFeed.get(event.repo) ?? { ...none };
        counts.pushes += event.type === 'push.default_branch' ? 1 : 0;
        counts.commits += event.push?.commits ?? 0;
        counts.merges += event.type === 'pull_request.merged' ? 1 : 0;
        counts.releases += event.type === 'release.published' ? 1 : 0;
        counts.stars += event.type === 'star.created' ? 1 : 0;
        fromFeed.set(event.repo, counts);
      }
      const fromActivity = new Map(
        body.days.flatMap((day) => day.repos.map(({ repo, ...counts }) => [repo, counts] as const))
      );
      expect([...fromFeed.keys()].sort()).toEqual(
        cases
          .filter((entry) => entry.publishes)
          .map((entry) => entry.event.repository.fullName)
          .sort()
      );
      expect(Object.fromEntries(fromActivity)).toEqual(Object.fromEntries(fromFeed));
    });

    it('marks an answer incomplete when UTC midnight brings a repository it never checked', async () => {
      visibility.set('o/old', 'public');
      visibility.set('o/new', 'public');
      vi.setSystemTime(new Date('2026-10-26T23:59:59.999Z'));
      await record(star('o/old', 1), '2026-10-26T10:00:00.000Z');
      await record(star('o/new', 1), '2026-10-27T00:00:00.000Z');
      // Midnight passes while D1 runs the aggregate, which already holds o/new's star.
      const prepare = env.DB.prepare.bind(env.DB);
      vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
        const statement = prepare(query);
        if (query.includes('GROUP BY date')) {
          const bind = statement.bind.bind(statement);
          vi.spyOn(statement, 'bind').mockImplementation((...values) => {
            const bound = bind(...values);
            const all = bound.all.bind(bound);
            vi.spyOn(bound, 'all').mockImplementation(() => {
              vi.setSystemTime(new Date('2026-10-27T00:00:00.001Z'));
              return all();
            });
            return bound;
          });
        }
        return statement;
      });

      const { status, body } = await getActivity('?days=2');

      expect(status).toBe(200);
      expect(githubLookups).toEqual(['o/old']);
      expect(body).toMatchObject({
        complete: false,
        days: [
          { date: '2026-10-26', stars: 1, repos: [{ repo: 'o/old' }] },
          { date: '2026-10-27', stars: 0, repos: [] },
        ],
      });
    });

    it('answers 1 to 400 days from one D1 read, and rejects anything else', async () => {
      visibility.set('ayagmar/ccdesk', 'public');
      // The day before the 400th, then the 400th.
      await record(push('ayagmar/ccdesk'), '2025-09-21T23:59:00.000Z');
      await record(push('ayagmar/ccdesk'), '2025-09-22T00:00:00.000Z');
      await record(push('ayagmar/ccdesk'), '2026-10-26T00:00:00.000Z');

      const defaults = await getActivity();
      expect(defaults.body.days).toHaveLength(28);
      expect(defaults.body.days[0]?.date).toBe('2026-09-29');

      // Any further D1 read would see the history gone.
      await env.DB.exec('DELETE FROM events');
      const one = await getActivity('?days=1');
      expect(one.body).toMatchObject({
        since: '2025-09-21',
        days: [{ date: '2026-10-26', pushes: 1, repos: [{ repo: 'ayagmar/ccdesk', pushes: 1 }] }],
      });
      const most = await getActivity('?days=400');
      expect(most.body.days).toHaveLength(400);
      expect(most.body.days[0]).toMatchObject({ date: '2025-09-22', pushes: 1 });
      expect(most.body.days.at(-1)?.date).toBe('2026-10-26');

      for (const days of ['', '0', '401', '1.5', '-1', '+5', 'abc', '1e2']) {
        const { status, headers, body } = await getActivity(`?days=${days}`);
        expect(status, days).toBe(400);
        expect(headers.get('Cache-Control')).toBe('no-store');
        expect(body).toEqual({ error: 'invalid_query' });
      }
      const post = await getPublic('activity', { method: 'POST' });
      expect(post.response.status).toBe(405);
      expect(post.response.headers.get('Allow')).toBe('GET, HEAD');
    });

    it('answers zeros and a null since for an empty history', async () => {
      const { status, body } = await getActivity('?days=2');

      expect(status).toBe(200);
      expect(body).toEqual({
        generatedAt: '2026-10-26T08:45:00.000Z',
        since: null,
        complete: true,
        days: [zero('2026-10-25'), zero('2026-10-26')],
      });
    });

    it('answers 503 when nothing is admitted and a lookup failed, else marks the answer incomplete', async () => {
      visibility.set('ayagmar/runnerd', 'rate_limited');
      visibility.set('ayagmar/secret', 'not_found');
      await record(push('ayagmar/runnerd'), '2026-10-25T21:14:00.000Z');
      await record(push('ayagmar/secret'), '2026-10-25T21:15:00.000Z');

      const { status, body } = await getActivity();

      expect(status).toBe(503);
      expect(body).toEqual({ error: 'visibility_unavailable' });

      // With another repository admitted, the counts are served but marked incomplete.
      visibility.set('ayagmar/ccdesk', 'public');
      await record(push('ayagmar/ccdesk'), '2026-10-25T21:16:00.000Z');
      app = createApp();
      cacheEntries.clear();
      const partial = await getActivity();
      expect(partial.status).toBe(200);
      expect(partial.body.complete).toBe(false);
      expect(partial.body.days.at(-2)?.repos.map((repo) => repo.repo)).toEqual(['ayagmar/ccdesk']);
    });
  });
});
