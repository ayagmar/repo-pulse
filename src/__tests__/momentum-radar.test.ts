import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkMomentum } from '../app.js';
import type { RepoEvent } from '../core/models/repo-event.js';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
} from '../core/models/repo-event.js';
import { D1DeliveryLedger } from '../core/services/d1-delivery-ledger.js';
import { D1RadarLog } from '../core/services/d1-radar-log.js';
import { createTempDatabasePath, createTestEnv } from './test-helpers.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function star(name: string, login: string, count: number): RepoEvent {
  return createRepoEvent(REPO_EVENT_TYPES.STAR_CREATED, {
    action: REPO_EVENT_ACTIONS.CREATED,
    repository: {
      id: 1,
      name,
      fullName: `myorg/${name}`,
      owner: 'myorg',
      url: `https://github.com/myorg/${name}`,
      private: false,
      description: null,
      stars: count,
      forks: 0,
      language: 'TypeScript',
    },
    sender: {
      id: 1,
      login,
      avatarUrl: `https://avatars.githubusercontent.com/${login}`,
      url: `https://github.com/${login}`,
    },
    star: { count },
  });
}

/** Followers per GitHub user, for the fake GraphQL API. */
const followers: Record<string, number> = { famous: 52_000, known: 340, newcomer: 3 };

function fakeGitHub(url: string, init: RequestInit): Response {
  if (url === 'https://api.github.com/repos/myorg/cli/traffic/popular/referrers') {
    return Response.json([
      { referrer: 'news.ycombinator.com', count: 480, uniques: 410 },
      { referrer: 'github.com', count: 35, uniques: 20 },
      { referrer: 'reddit.com', count: 12, uniques: 11 },
      { referrer: 'google.com', count: 4, uniques: 4 },
    ]);
  }

  const { variables } = JSON.parse(init.body as string) as { variables: Record<string, string> };
  const data: Record<string, unknown> = {};
  for (let index = 0; `login${String(index)}` in variables; index += 1) {
    const login = variables[`login${String(index)}`] ?? '';
    const count = followers[login];
    data[`r${String(index)}`] =
      count === undefined
        ? null
        : { login, url: `https://github.com/${login}`, followers: { totalCount: count } };
  }
  return Response.json({ data });
}

describe('momentum radar', () => {
  const cleanups: (() => void)[] = [];
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    fetchMock
      .mockReset()
      .mockImplementation((url, init) =>
        Promise.resolve(
          url.startsWith('https://api.github.com/')
            ? fakeGitHub(url, init)
            : new Response(null, { status: 204 })
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  function createRadarEnv(
    overrides: Parameters<typeof createTestEnv>[1] = {}
  ): ReturnType<typeof createTestEnv> {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);
    const env = createTestEnv(tempDatabase.databasePath, overrides);
    cleanups.push(() => {
      env.DB.close();
    });
    return env;
  }

  let deliveryCount = 0;
  async function record(
    env: ReturnType<typeof createTestEnv>,
    receivedAt: Date,
    event: RepoEvent
  ): Promise<void> {
    vi.setSystemTime(receivedAt);
    deliveryCount += 1;
    await new D1DeliveryLedger(env.DB).persistAcceptedDelivery({
      deliveryId: `delivery-${String(deliveryCount)}`,
      sourceEventType: event.type,
      repository: event.repository.fullName,
      event,
      maxAttempts: 5,
    });
  }

  /** `logins.length` stars on `name` in the hour before `end`, the last bringing it to `total`. */
  async function recordStars(
    env: ReturnType<typeof createTestEnv>,
    name: string,
    end: Date,
    logins: readonly string[],
    total: number
  ): Promise<void> {
    for (const [index, login] of logins.entries()) {
      const receivedAt = new Date(end.getTime() - HOUR_MS + index * MINUTE_MS);
      await record(env, receivedAt, star(name, login, total - logins.length + index + 1));
    }
  }

  /** Run the radar as the cron would at `scheduledTime`, with the clock there too. */
  async function check(
    env: ReturnType<typeof createTestEnv>,
    scheduledTime: string
  ): Promise<void> {
    vi.setSystemTime(new Date(scheduledTime));
    await checkMomentum(env, new Date(scheduledTime));
  }

  function postedEmbeds(): {
    title: string;
    description: string;
    fields?: { name: string; value: string }[];
  }[] {
    return fetchMock.mock.calls
      .filter(([url]) => url.startsWith('https://discord.com/'))
      .map(([, init]) => (JSON.parse(init.body as string) as { embeds: [never] }).embeds[0]);
  }

  it('alerts once a day when a quiet repository suddenly gains stars', async () => {
    const env = createRadarEnv({ GITHUB_TOKEN: 'github-token' });
    // One star a day for the two weeks before.
    for (let day = 14; day >= 1; day -= 1) {
      await record(
        env,
        new Date(Date.parse('2026-10-15T12:00:00.000Z') - day * 24 * HOUR_MS),
        star('cli', `regular${String(day)}`, 15 - day)
      );
    }
    await recordStars(
      env,
      'cli',
      new Date('2026-10-15T12:00:00.000Z'),
      ['newcomer', 'famous', 'a', 'b', 'known', 'c'],
      20
    );

    await check(env, '2026-10-15T12:00:00.000Z');
    expect(postedEmbeds()).toEqual([]);

    await check(env, '2026-10-15T12:05:00.000Z');
    await check(env, '2026-10-15T12:15:00.000Z');

    expect(postedEmbeds()).toEqual([
      expect.objectContaining({
        title: '🚀 myorg/cli is taking off',
        description: '⭐ **6 stars** in the last 3 hours, against about 0.1 usually. **20** total.',
        fields: [
          {
            name: 'Notable stargazers',
            value: [
              '[famous](https://github.com/famous) · 52,000 followers',
              '[known](https://github.com/known) · 340 followers',
            ].join('\n'),
          },
          {
            name: 'Top referrers, last 14 days',
            value: [
              'news.ycombinator.com · 480 views from 410 visitors',
              'github.com · 35 views from 20 visitors',
              'reddit.com · 12 views from 11 visitors',
            ].join('\n'),
          },
        ],
      }),
    ]);
  });

  it('does not alert for a repository that usually gains stars this fast', async () => {
    const env = createRadarEnv();
    const now = new Date('2026-10-15T12:05:00.000Z');
    // Two stars every three hours for the two weeks before.
    for (let window = 1; window <= 14 * 8; window += 1) {
      const windowEnd = new Date(now.getTime() - 3 * HOUR_MS - (window - 1) * 3 * HOUR_MS);
      await record(env, new Date(windowEnd.getTime() - HOUR_MS), star('web', 'a', window));
      await record(env, new Date(windowEnd.getTime() - 2 * HOUR_MS), star('web', 'b', window));
    }
    await recordStars(env, 'web', now, ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 300);

    await check(env, now.toISOString());

    expect(postedEmbeds()).toEqual([]);
  });

  it('does not alert for fewer than five stars, however quiet the repository was', async () => {
    const env = createRadarEnv();
    const now = new Date('2026-10-15T12:05:00.000Z');
    await recordStars(env, 'cli', now, ['a', 'b', 'c', 'd'], 4);

    await check(env, now.toISOString());

    expect(postedEmbeds()).toEqual([]);
  });

  it('counts people, not stars, so one person toggling a star cannot set it off', async () => {
    const env = createRadarEnv();
    const now = new Date('2026-10-15T12:05:00.000Z');
    await recordStars(env, 'cli', now, ['a', 'a', 'a', 'a', 'a', 'a'], 1);

    await check(env, now.toISOString());

    expect(postedEmbeds()).toEqual([]);
  });

  it('sends one alert per check, starting with the repository with the most stargazers', async () => {
    const env = createRadarEnv();
    const now = new Date('2026-10-15T12:05:00.000Z');
    await recordStars(env, 'cli', now, ['a', 'b', 'c', 'd', 'e'], 5);
    await recordStars(env, 'web', now, ['a', 'b', 'c', 'd', 'e', 'f'], 6);

    await check(env, '2026-10-15T12:05:00.000Z');
    const afterFirstCheck = postedEmbeds().map((embed) => embed.title);
    await check(env, '2026-10-15T12:15:00.000Z');

    expect(afterFirstCheck).toEqual(['🚀 myorg/web is taking off']);
    expect(postedEmbeds().map((embed) => embed.title)).toEqual([
      '🚀 myorg/web is taking off',
      '🚀 myorg/cli is taking off',
    ]);
  });

  it('sends one alert when two checks overlap', async () => {
    const env = createRadarEnv();
    const now = new Date('2026-10-15T12:05:00.000Z');
    await recordStars(env, 'cli', now, ['a', 'b', 'c', 'd', 'e'], 5);
    vi.setSystemTime(now);

    await Promise.all([checkMomentum(env, now), checkMomentum(env, now)]);

    expect(postedEmbeds()).toHaveLength(1);
  });

  it('retries an alert Discord rejected at the next check', async () => {
    const env = createRadarEnv();
    await recordStars(
      env,
      'cli',
      new Date('2026-10-15T12:05:00.000Z'),
      ['a', 'b', 'c', 'd', 'e'],
      5
    );
    fetchMock.mockResolvedValueOnce(new Response('upstream error', { status: 500 }));

    await check(env, '2026-10-15T12:05:00.000Z');
    await check(env, '2026-10-15T12:15:00.000Z');
    await check(env, '2026-10-15T12:25:00.000Z');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(postedEmbeds()[1]).toMatchObject({
      description: '⭐ **5 stars** in the last 3 hours, up from almost none. **5** total.',
    });
  });

  it('still alerts, without stargazers or referrers, when GitHub fails', async () => {
    fetchMock.mockImplementation((url) =>
      Promise.resolve(
        url.startsWith('https://api.github.com/')
          ? new Response('Bad credentials', { status: 401 })
          : new Response(null, { status: 204 })
      )
    );
    const env = createRadarEnv({ GITHUB_TOKEN: 'expired-token' });
    const now = new Date('2026-10-15T12:05:00.000Z');
    await recordStars(env, 'cli', now, ['a', 'b', 'c', 'd', 'e'], 5);

    await check(env, now.toISOString());

    expect(postedEmbeds()).toHaveLength(1);
    expect(postedEmbeds()[0]?.fields).toBeUndefined();
  });

  it('retries an alert at the next check when building it fails', async () => {
    const env = createRadarEnv();
    await recordStars(
      env,
      'cli',
      new Date('2026-10-15T12:05:00.000Z'),
      ['a', 'b', 'c', 'd', 'e'],
      5
    );
    const prepare = env.DB.prepare.bind(env.DB);
    let failed = false;
    vi.spyOn(env.DB, 'prepare').mockImplementation((query: string) => {
      // Only the lookup of recent stargazers, after the alert is claimed, reads star counts.
      if (!failed && query.includes("'$.star.count'")) {
        failed = true;
        throw new Error('D1_ERROR: network connection lost');
      }
      return prepare(query);
    });

    await expect(check(env, '2026-10-15T12:05:00.000Z')).rejects.toThrow('D1_ERROR');
    const claims = await env.DB.prepare('SELECT alert_id FROM radar_alerts').all();
    expect(claims.results).toEqual([{ alert_id: 'stars:myorg/cli' }]);
    await check(env, '2026-10-15T12:15:00.000Z');

    expect(postedEmbeds()).toHaveLength(1);
  });

  it('lets a check take over an abandoned claim, and holds a sent alert for a day', async () => {
    const env = createRadarEnv();
    const log = new D1RadarLog(env.DB);
    const limits = { cooldownMs: 24 * HOUR_MS, leaseMs: 5 * MINUTE_MS };
    const claim = (at: string): Promise<string | null> =>
      log.claim('stars:myorg/cli', new Date(at), limits);

    expect(await claim('2026-10-15T12:05:00.000Z')).not.toBeNull();
    // The claiming check may still be posting.
    expect(await claim('2026-10-15T12:09:00.000Z')).toBeNull();
    // It stopped without sending or releasing.
    expect(await claim('2026-10-15T12:15:00.000Z')).not.toBeNull();
    await log.markSent('stars:myorg/cli', new Date('2026-10-15T12:15:05.000Z'));

    expect(await claim('2026-10-16T12:15:00.000Z')).toBeNull();
    expect(await claim('2026-10-16T12:15:05.000Z')).not.toBeNull();
  });
});
