import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendDailyDigest } from '../app.js';
import type { RepoEvent } from '../core/models/repo-event.js';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
} from '../core/models/repo-event.js';
import { D1DeliveryLedger } from '../core/services/d1-delivery-ledger.js';
import { dueDigestWindow } from '../core/services/daily-digest.js';
import { createTempDatabasePath, createTestEnv } from './test-helpers.js';

const HOUR_MS = 60 * 60_000;

type DigestWindowResult = NonNullable<ReturnType<typeof dueDigestWindow>>;

/** Local wall-clock time, computed independently of the code under test. */
function localWallClock(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(instant);
}

function repository(name: string): RepoEvent['repository'] {
  return {
    id: 1,
    name,
    fullName: `myorg/${name}`,
    owner: 'myorg',
    url: `https://github.com/myorg/${name}`,
    private: false,
    description: null,
    stars: 1,
    forks: 0,
    language: 'TypeScript',
  };
}

const sender = {
  id: 1,
  login: 'octocat',
  avatarUrl: 'https://avatars.githubusercontent.com/u/1',
  url: 'https://github.com/octocat',
};

function star(name: string, removed = false): RepoEvent {
  return removed
    ? createRepoEvent(REPO_EVENT_TYPES.STAR_DELETED, {
        action: REPO_EVENT_ACTIONS.DELETED,
        repository: repository(name),
        sender,
        star: { count: 1 },
      })
    : createRepoEvent(REPO_EVENT_TYPES.STAR_CREATED, {
        action: REPO_EVENT_ACTIONS.CREATED,
        repository: repository(name),
        sender,
        star: { count: 1 },
      });
}

function push(name: string, commitCount: number): RepoEvent {
  return createRepoEvent(REPO_EVENT_TYPES.PUSH_DEFAULT_BRANCH, {
    action: REPO_EVENT_ACTIONS.PUSHED,
    repository: repository(name),
    sender,
    push: {
      branch: 'main',
      compareUrl: `https://github.com/myorg/${name}/compare/a...b`,
      forced: false,
      commits: Array.from({ length: commitCount }, (_, index) => ({
        id: `${String(index)}abcdef`,
        message: `Commit ${String(index)}`,
        url: `https://github.com/myorg/${name}/commit/${String(index)}`,
        author: 'octocat',
      })),
    },
  });
}

function release(name: string, tagName: string): RepoEvent {
  return createRepoEvent(REPO_EVENT_TYPES.RELEASE_PUBLISHED, {
    action: REPO_EVENT_ACTIONS.PUBLISHED,
    repository: repository(name),
    sender,
    release: {
      tagName,
      name: null,
      url: `https://github.com/myorg/${name}/releases/tag/${tagName}`,
      body: null,
      prerelease: false,
    },
  });
}

describe('daily digest schedule', () => {
  function digestsIn2026(timeZone: string, hour: number): DigestWindowResult[] {
    const windows: DigestWindowResult[] = [];
    // These zones are offset from UTC by whole or half hours, so half-hour steps land on
    // every digest's due time, and no due period is sampled twice.
    for (
      let time = Date.parse('2026-01-01T00:00:00.000Z');
      time < Date.parse('2027-01-01T00:00:00.000Z');
      time += 30 * 60_000
    ) {
      const window = dueDigestWindow(new Date(time), timeZone, hour);
      if (window) {
        windows.push(window);
      }
    }
    return windows;
  }

  function expectEveryDayOnceWithoutGaps(windows: DigestWindowResult[], timeZone: string): void {
    expect(new Set(windows.map((window) => window.date)).size).toBe(windows.length);
    // 2026-01-01's digest falls on the first day sampled; 365 local days follow it.
    expect(windows.length).toBeGreaterThanOrEqual(364);
    for (const [index, window] of windows.entries()) {
      expect(localWallClock(window.end, timeZone).slice(0, 10)).toBe(window.date);
      const next = windows[index + 1];
      if (next) {
        expect(next.start).toEqual(window.end);
      }
    }
  }

  it.each(['Africa/Casablanca', 'America/New_York', 'Asia/Kolkata'])(
    'in %s, covers each local day exactly once, from 09:00 to 09:00, across clock changes',
    (timeZone) => {
      const windows = digestsIn2026(timeZone, 9);

      expectEveryDayOnceWithoutGaps(windows, timeZone);
      for (const window of windows) {
        expect(localWallClock(window.end, timeZone)).toBe(`${window.date} 09:00`);
      }
      const durations = new Set(
        windows.map((window) => (window.end.getTime() - window.start.getTime()) / HOUR_MS)
      );
      expect([...durations].sort()).toEqual(timeZone === 'Asia/Kolkata' ? [24] : [23, 24, 25]);
    }
  );

  it.each([
    ['Africa/Casablanca', 1],
    ['Africa/Casablanca', 2],
    ['America/New_York', 1],
    ['America/New_York', 2],
  ])(
    'in %s at hour %i, inside a clock change, still sends one digest a day and leaves no gap',
    (timeZone, hour) => {
      const windows = digestsIn2026(timeZone, hour);

      expectEveryDayOnceWithoutGaps(windows, timeZone);
    }
  );
});

describe('daily digest', () => {
  const cleanups: (() => void)[] = [];
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
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

  function createDigestEnv(): ReturnType<typeof createTestEnv> {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);
    const env = createTestEnv(tempDatabase.databasePath, {
      DIGEST_TIME_ZONE: 'Africa/Casablanca',
      DIGEST_HOUR: '9',
    });
    cleanups.push(() => {
      env.DB.close();
    });
    return env;
  }

  async function record(
    env: ReturnType<typeof createTestEnv>,
    receivedAt: string,
    events: RepoEvent[]
  ): Promise<void> {
    vi.setSystemTime(new Date(receivedAt));
    const ledger = new D1DeliveryLedger(env.DB);
    for (const [index, event] of events.entries()) {
      await ledger.persistAcceptedDelivery({
        deliveryId: `${receivedAt}-${String(index)}`,
        sourceEventType: event.type,
        repository: event.repository.fullName,
        event,
        maxAttempts: 5,
      });
    }
  }

  function postedEmbeds(): { title: string; description: string; footer: { text: string } }[] {
    return fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return (JSON.parse(init.body as string) as { embeds: [never] }).embeds[0];
    });
  }

  it('posts one summary of the last day at 09:00 Morocco time, most active repository first', async () => {
    const env = createDigestEnv();
    // Morocco has been on UTC+0 since 20 September 2026, so 09:00 there is 09:00 UTC.
    await record(env, '2026-10-14T08:59:00.000Z', [star('too-early')]);
    await record(env, '2026-10-14T09:00:00.000Z', [star('cli'), star('cli'), star('cli', true)]);
    await record(env, '2026-10-14T20:00:00.000Z', [push('web', 3), release('web', 'v1.0.0')]);
    await record(env, '2026-10-15T09:00:00.000Z', [star('too-late')]);

    await sendDailyDigest(env, new Date('2026-10-15T09:00:00.000Z'));
    await sendDailyDigest(env, new Date('2026-10-15T09:01:00.000Z'));

    expect(postedEmbeds()).toMatchObject([
      {
        title: '📊 Daily pulse: 5 events in 2 repositories',
        description: [
          '**[myorg/cli](https://github.com/myorg/cli)** ⭐ +1',
          '**[myorg/web](https://github.com/myorg/web)** 3 commits · released [v1.0.0](https://github.com/myorg/web/releases/tag/v1.0.0)',
        ].join('\n'),
        footer: { text: '14 Oct, 09:00 to 15 Oct, 09:00 · Africa/Casablanca' },
      },
    ]);
  });

  it('retries a failed digest the next minute, then stops once it is posted', async () => {
    const env = createDigestEnv();
    await record(env, '2026-10-14T12:00:00.000Z', [star('cli')]);
    fetchMock.mockResolvedValueOnce(new Response('upstream error', { status: 500 }));

    await sendDailyDigest(env, new Date('2026-10-15T09:00:00.000Z'));
    await sendDailyDigest(env, new Date('2026-10-15T09:01:00.000Z'));
    await sendDailyDigest(env, new Date('2026-10-15T09:02:00.000Z'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('posts once when two cron runs overlap', async () => {
    const env = createDigestEnv();
    await record(env, '2026-10-14T12:00:00.000Z', [star('cli')]);

    await Promise.all([
      sendDailyDigest(env, new Date('2026-10-15T09:00:00.000Z')),
      sendDailyDigest(env, new Date('2026-10-15T09:01:00.000Z')),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('posts nothing after a day without activity', async () => {
    const env = createDigestEnv();
    await record(env, '2026-10-13T12:00:00.000Z', [star('cli')]);

    await sendDailyDigest(env, new Date('2026-10-15T09:00:00.000Z'));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
