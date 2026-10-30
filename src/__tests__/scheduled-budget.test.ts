import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
} from '../core/models/repo-event.js';
import { D1DeliveryLedger } from '../core/services/d1-delivery-ledger.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../core/services/d1-types.js';
import worker from '../index.js';
import { createExecutionContext, createTempDatabasePath, createTestEnv } from './test-helpers.js';

/** The Workers Free plan's limit on one invocation's subrequests, D1 queries included. */
const SUBREQUEST_LIMIT = 50;

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});

/** Counts every D1 query and batch, as Workers counts them against the limit. */
function countQueries(db: D1DatabaseLike): { db: D1DatabaseLike; queries: () => number } {
  let queries = 0;
  const inner = new WeakMap<D1PreparedStatementLike, D1PreparedStatementLike>();
  const wrap = (statement: D1PreparedStatementLike): D1PreparedStatementLike => {
    const wrapped: D1PreparedStatementLike = {
      bind: (...values) => wrap(statement.bind(...values)),
      first: () => {
        queries += 1;
        return statement.first();
      },
      all: () => {
        queries += 1;
        return statement.all();
      },
      run: () => {
        queries += 1;
        return statement.run();
      },
    };
    inner.set(wrapped, statement);
    return wrapped;
  };
  const counting: D1DatabaseLike = {
    prepare: (query) => wrap(db.prepare(query)),
    batch: (statements) => {
      queries += 1;
      return db.batch(statements.map((statement) => inner.get(statement) ?? statement));
    },
    exec: (sql) => {
      queries += 1;
      return db.exec(sql);
    },
  };
  return { db: counting, queries: () => queries };
}

function star(login: string, count: number): ReturnType<typeof createRepoEvent> {
  return createRepoEvent(REPO_EVENT_TYPES.STAR_CREATED, {
    action: REPO_EVENT_ACTIONS.CREATED,
    repository: {
      id: 1,
      name: 'cli',
      fullName: 'myorg/cli',
      owner: 'myorg',
      url: 'https://github.com/myorg/cli',
      private: false,
      description: null,
      stars: count,
      forks: 0,
      language: 'TypeScript',
    },
    sender: {
      id: count,
      login,
      avatarUrl: `https://avatars.githubusercontent.com/${login}`,
      url: `https://github.com/${login}`,
    },
    star: { count },
  });
}

/** GitHub's token endpoint and API, answering so that every lookup has something to add. */
function fakeGitHub(url: string, init: RequestInit, failMint: boolean): Response {
  if (url.endsWith('/access_tokens')) {
    return failMint
      ? Response.json({ message: 'Bad credentials' }, { status: 401 })
      : Response.json(
          { token: 'installation-token', expires_at: '2026-10-26T10:05:00Z' },
          { status: 201 }
        );
  }
  if (url.endsWith('/traffic/popular/referrers')) {
    return Response.json([{ referrer: 'news.ycombinator.com', count: 480, uniques: 410 }]);
  }
  const { query } = JSON.parse(init.body as string) as { query: string };
  if (query.includes('latestRelease')) {
    return Response.json({
      data: {
        r0: {
          url: 'https://github.com/myorg/cli',
          defaultBranchRef: { name: 'main' },
          latestRelease: { tagName: 'v1.0.0', publishedAt: '2026-10-01T00:00:00Z' },
        },
      },
    });
  }
  if (query.includes('compare')) {
    return Response.json({ data: { r0: { ref: { compare: { aheadBy: 3 } } } } });
  }
  return Response.json({
    data: {
      r0: { login: 'famous', url: 'https://github.com/famous', followers: { totalCount: 52_000 } },
    },
  });
}

describe('one scheduled invocation', () => {
  const cleanups: (() => void)[] = [];
  let installationId = 9000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  /**
   * The worst case: a Monday at the digest hour and a radar minute, with deliveries
   * to drain, a daily and a weekly digest, a star alert, and no cached App token.
   */
  async function runWorstCase(failMint: boolean): Promise<{
    subrequests: number;
    tokenRequests: number;
    githubRequests: number;
    discordPosts: number;
  }> {
    const database = createTempDatabasePath();
    cleanups.push(database.cleanup);
    // A new installation, so no token is cached from an earlier test.
    installationId += 1;
    const env = createTestEnv(database.databasePath, {
      DIGEST_TIME_ZONE: 'UTC',
      DIGEST_HOUR: '9',
      GITHUB_APP_ID: String(1),
      GITHUB_APP_INSTALLATION_ID: String(installationId),
      GITHUB_APP_PRIVATE_KEY: privateKey,
    });
    cleanups.push(() => {
      env.DB.close();
    });

    // Six stars in the hour before the digest, each still waiting to be posted.
    const ledger = new D1DeliveryLedger(env.DB);
    for (let index = 0; index < 6; index += 1) {
      vi.setSystemTime(new Date(Date.parse('2026-10-26T08:00:00Z') + index * 5 * 60_000));
      await ledger.persistAcceptedDelivery({
        deliveryId: `star-${String(index)}`,
        sourceEventType: 'star',
        repository: 'myorg/cli',
        event: star(index === 0 ? 'famous' : `user${String(index)}`, 100 + index),
        maxAttempts: 5,
      });
    }

    const fetchMock = vi.fn((url: string, init: RequestInit) =>
      Promise.resolve(
        url.startsWith('https://api.github.com/')
          ? fakeGitHub(url, init, failMint)
          : new Response(null, { status: 204 })
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const counted = countQueries(env.DB);

    // Monday 26 October 2026, 09:05 UTC.
    const scheduledTime = Date.parse('2026-10-26T09:05:00Z');
    vi.setSystemTime(scheduledTime);
    const execution = createExecutionContext();
    worker.scheduled(
      { scheduledTime, cron: '* * * * *', noRetry: () => undefined },
      { ...env, DB: counted.db } as unknown as Env,
      execution.executionCtx
    );
    await execution.waitForBackground();

    const urls = fetchMock.mock.calls.map(([url]) => url);
    return {
      subrequests: counted.queries() + urls.length,
      tokenRequests: urls.filter((url) => url.endsWith('/access_tokens')).length,
      githubRequests: urls.filter((url) => url.startsWith('https://api.github.com/')).length,
      discordPosts: urls.filter((url) => url.startsWith('https://discord.com/')).length,
    };
  }

  it('stays within 50 subrequests with a cold App token', async () => {
    const run = await runWorstCase(false);

    // Five deliveries, the daily and weekly digests and one star alert were all sent,
    // and the digest and the alert each asked GitHub twice, with one token.
    expect(run).toMatchObject({ tokenRequests: 1, githubRequests: 5, discordPosts: 8 });
    expect(run.subrequests).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
  });

  it('stays within 50 subrequests when the token cannot be minted, and still posts', async () => {
    const run = await runWorstCase(true);

    expect(run).toMatchObject({ tokenRequests: 1, githubRequests: 1, discordPosts: 8 });
    expect(run.subrequests).toBeLessThanOrEqual(SUBREQUEST_LIMIT);
  });
});
