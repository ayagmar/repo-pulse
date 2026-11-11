import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoEvent } from '../core/models/repo-event.js';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
} from '../core/models/repo-event.js';
import { Redactor } from '../core/security/redact.js';
import { D1DeliveryLedger } from '../core/services/d1-delivery-ledger.js';
import { D1EventHistory } from '../core/services/d1-event-history.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../core/services/d1-types.js';
import { DurableEventProcessor } from '../core/services/durable-event-processor.js';
import { NotificationDispatcher } from '../core/services/notification-dispatcher.js';
import { formatDiscordEmbed } from '../providers/discord/embed-formatter.js';
import { createTempDatabasePath, createTestD1Database } from './test-helpers.js';

const DAY_MS = 24 * 3_600_000;
const START = Date.parse('2026-11-01T12:00:00Z');

interface StarOptions {
  count: number;
  removed?: boolean;
  login?: string;
  repositoryId?: number;
  fullName?: string;
  createdAt?: string;
}

function star(options: StarOptions): RepoEvent {
  const { count, login = 'alice', repositoryId = 1, fullName = 'myorg/repo' } = options;
  const [owner = 'myorg', name = 'repo'] = fullName.split('/');
  const base = {
    repository: {
      id: repositoryId,
      name,
      fullName,
      owner,
      url: `https://github.com/${fullName}`,
      private: false,
      description: null,
      stars: count,
      forks: 0,
      language: null,
      ...(options.createdAt !== undefined ? { createdAt: options.createdAt } : {}),
    },
    sender: {
      id: login.length,
      login,
      avatarUrl: `https://avatars.githubusercontent.com/${login}`,
      url: `https://github.com/${login}`,
    },
    star: { count },
  };
  return options.removed === true
    ? createRepoEvent(REPO_EVENT_TYPES.STAR_DELETED, {
        ...base,
        action: REPO_EVENT_ACTIONS.DELETED,
      })
    : createRepoEvent(REPO_EVENT_TYPES.STAR_CREATED, {
        ...base,
        action: REPO_EVENT_ACTIONS.CREATED,
      });
}

describe('star milestones', () => {
  const cleanups: (() => void)[] = [];
  let database: ReturnType<typeof createTestD1Database>;
  let deliveries = 0;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const temp = createTempDatabasePath();
    database = createTestD1Database(temp.databasePath);
    cleanups.push(temp.cleanup, () => {
      database.close();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  function processor(db: D1DatabaseLike = database): DurableEventProcessor {
    return new DurableEventProcessor(
      new D1DeliveryLedger(db),
      new NotificationDispatcher(new Redactor([])),
      {},
      { ignoredLogins: new Set() }
    );
  }

  function accept(
    event: RepoEvent,
    id?: string,
    db: D1DatabaseLike = database
  ): ReturnType<DurableEventProcessor['enqueue']> & { deliveryId: string } {
    deliveries += 1;
    const deliveryId = id ?? `delivery-${String(deliveries)}`;
    const result = processor(db).enqueue(event, {
      deliveryId,
      repository: event.repository.fullName,
      sourceEventType: 'star',
    });
    return Object.assign(result, { deliveryId });
  }

  /** The alert queued for a delivery. */
  async function queued(deliveryId: string): Promise<{ title: string; description?: string }> {
    const delivery = await new D1DeliveryLedger(database).getDelivery(deliveryId);
    const embed = delivery === null ? undefined : formatDiscordEmbed(delivery.event).embeds[0];
    if (embed === undefined) {
      throw new Error(`Nothing queued for ${deliveryId}`);
    }
    return embed;
  }

  async function queuedTitle(deliveryId: string): Promise<string> {
    // The running total is in every plain star's title; what these tests tell apart is the kind.
    return (await queued(deliveryId)).title.replace(/ · -?[\d,.]+ total$/, '');
  }

  /** Accept each star in turn, a minute apart, and return the title each would post. */
  async function titles(events: RepoEvent[]): Promise<string[]> {
    const result: string[] = [];
    for (const event of events) {
      vi.setSystemTime(Date.now() + 60_000);
      const first = accept(event);
      await first;
      // GitHub redelivering it changes nothing.
      await accept(event, first.deliveryId);
      result.push(await queuedTitle(first.deliveryId));
    }
    return result;
  }

  async function celebrated(): Promise<{ repositoryId: number; milestone: number }[]> {
    const rows = await database
      .prepare(
        `SELECT repository_id AS repositoryId, milestone FROM star_milestones
         ORDER BY repository_id, milestone`
      )
      .all<{ repositoryId: number; milestone: number }>();
    return rows.results;
  }

  const plain = '⭐ New star';
  const removed = '💫 Star removed';
  const reached = (stars: string, repo = 'myorg/repo'): string =>
    `🎉 ${repo} reached ${stars} stars`;

  it('celebrates each milestone the first time a star is seen past it, and only then', async () => {
    await expect(
      titles([
        star({ count: 98 }),
        star({ count: 100 }),
        star({ count: 99, removed: true }),
        star({ count: 100 }),
        star({ count: 101 }),
        star({ count: 249 }),
      ])
    ).resolves.toEqual([plain, reached('100'), removed, plain, plain, plain]);
    await expect(celebrated()).resolves.toEqual([{ repositoryId: 1, milestone: 100 }]);
  });

  it('does not celebrate late what a repository had passed when milestones started', async () => {
    // Stars recorded before this release: 300 at most, then some removed.
    const ledger = new D1DeliveryLedger(database);
    for (const [index, count] of [99, 300].entries()) {
      await ledger.persistAcceptedDelivery({
        deliveryId: `before-${String(index)}`,
        sourceEventType: 'star',
        repository: 'myorg/repo',
        event: star({ count }),
        maxAttempts: 5,
      });
    }

    await expect(
      titles([
        star({ count: 280 }),
        star({ count: 300 }),
        star({ count: 499 }),
        star({ count: 500 }),
      ])
    ).resolves.toEqual([plain, plain, plain, reached('500')]);
    // With no history, the first count seen is where it starts, removal or not.
    await expect(
      titles([
        star({ count: 301, repositoryId: 2, fullName: 'myorg/other' }),
        star({ count: 9, repositoryId: 3, fullName: 'myorg/new', removed: true }),
        star({ count: 10, repositoryId: 3, fullName: 'myorg/new' }),
      ])
    ).resolves.toEqual([plain, removed, reached('10', 'myorg/new')]);
    await expect(celebrated()).resolves.toEqual([
      { repositoryId: 1, milestone: 500 },
      { repositoryId: 3, milestone: 10 },
    ]);
  });

  it('celebrates only the highest milestone a jump or a late delivery crosses', async () => {
    await expect(
      titles([
        star({ count: 40 }),
        // A jump over 50 and 100, then a delivery that arrives late, below it.
        star({ count: 260, login: 'bob' }),
        star({ count: 100 }),
        star({ count: 251 }),
        // 499 is seen, then 501 arrives before 500.
        star({ count: 501, login: 'carol' }),
        star({ count: 500 }),
      ])
    ).resolves.toEqual([plain, reached('250'), plain, plain, reached('500'), plain]);

    const events = await new D1EventHistory(database).listRecentEvents();
    const fiveHundred = events.find(
      (entry) =>
        entry.event.type === REPO_EVENT_TYPES.STAR_CREATED && entry.event.star.count === 501
    );
    await expect(queued(fiveHundred?.deliveryId ?? '')).resolves.toMatchObject({
      description: expect.stringMatching(/^Observed after \[carol\]/) as unknown,
    });
  });

  it('keys milestones by repository id, through renames and a replaced name', async () => {
    await expect(
      titles([
        star({ count: 95 }),
        star({ count: 100 }),
        star({ count: 101, fullName: 'myorg/renamed' }),
        star({ count: 250, fullName: 'myorg/renamed' }),
        // Another repository now has the old name: it starts on its own.
        star({ count: 120, repositoryId: 9 }),
        star({ count: 250, repositoryId: 9 }),
      ])
    ).resolves.toEqual([
      plain,
      reached('100'),
      plain,
      reached('250', 'myorg/renamed'),
      plain,
      reached('250'),
    ]);
  });

  it('keeps counting past 10,000, and stays bounded for any count', async () => {
    await expect(
      titles([
        star({ count: 9_990 }),
        star({ count: 10_000 }),
        star({ count: 19_999 }),
        star({ count: 20_000 }),
        star({ count: 45_001 }),
        star({ count: Number.MAX_SAFE_INTEGER }),
      ])
    ).resolves.toEqual([
      plain,
      reached('10,000'),
      plain,
      reached('20,000'),
      reached('40,000'),
      reached('9,007,199,254,740,000'),
    ]);

    // Counts that are not a star count never start or take a milestone.
    await expect(
      titles([
        star({ count: -1, repositoryId: 2 }),
        star({ count: 10.5, repositoryId: 2 }),
        star({ count: 25, repositoryId: 0 }),
        star({ count: 5, repositoryId: 2 }),
        star({ count: 10, repositoryId: 2 }),
      ])
    ).resolves.toEqual([plain, plain, plain, plain, reached('10')]);
  });

  it('says how long since the previous milestone and how many net stars came this week', async () => {
    const createdAt = '2026-01-01T12:00:00.000Z';
    const at = (day: number, event: RepoEvent): RepoEvent => {
      vi.setSystemTime(START + day * DAY_MS);
      return event;
    };
    // Without the line on whether the sender is new, tested elsewhere.
    const description = async (deliveryId: string): Promise<string | undefined> =>
      (await queued(deliveryId)).description?.split('\n\n')[0];

    // Seen first at 60, so 50 is passed, not celebrated.
    await accept(at(0, star({ count: 60, createdAt })));
    const hundred = accept(at(10, star({ count: 100, createdAt })));
    await hundred;
    // Within the next week: stars here, under another name, removed, and elsewhere.
    await accept(at(34, star({ count: 200 })));
    await accept(at(35, star({ count: 201, fullName: 'myorg/renamed' })));
    await accept(at(36, star({ count: 200, removed: true, fullName: 'myorg/renamed' })));
    await accept(at(36, star({ count: 5, repositoryId: 2, fullName: 'myorg/other' })));
    const twoFifty = accept(at(40, star({ count: 250, createdAt, fullName: 'myorg/renamed' })));
    await twoFifty;

    await expect(description(hundred.deliveryId)).resolves.toBe(
      [
        'Observed after [alice](https://github.com/alice) starred this repository · **100** total',
        '⏱️ 314d since the repository was created',
        '📈 +1 net recorded star in the last 7 days',
      ].join('\n')
    );
    await expect(description(twoFifty.deliveryId)).resolves.toBe(
      [
        'Observed after [alice](https://github.com/alice) starred this repository · **250** total',
        '⏱️ 30d since 100 stars',
        '📈 +2 net recorded stars in the last 7 days',
      ].join('\n')
    );
  });

  it('keeps the first decision on redelivery, after pruning, and for events recorded before', async () => {
    await accept(star({ count: 95 }));
    vi.setSystemTime(START + DAY_MS);
    const crossing = accept(star({ count: 100 }), 'crossing');
    await expect(crossing).resolves.toEqual({ outcome: 'accepted' });
    const first = await new D1DeliveryLedger(database).getDelivery('crossing');

    // Redelivered later, with other counts and context, before and after pruning.
    vi.setSystemTime(START + 30 * DAY_MS);
    await accept(star({ count: 180 }));
    await expect(accept(star({ count: 250 }), 'crossing')).resolves.toEqual({
      outcome: 'duplicate',
    });
    await database.prepare("DELETE FROM deliveries WHERE delivery_id = 'crossing'").run();
    await expect(accept(star({ count: 250 }), 'crossing')).resolves.toEqual({
      outcome: 'duplicate',
    });
    await expect(new D1DeliveryLedger(database).getDelivery('crossing')).resolves.toBeNull();
    const recorded = await new D1EventHistory(database).listRecentEvents(200);
    expect(recorded.find((entry) => entry.deliveryId === 'crossing')?.event).toEqual(first?.event);

    // A delivery recorded before milestones existed is not decided again either.
    await new D1DeliveryLedger(database).persistAcceptedDelivery({
      deliveryId: 'before',
      sourceEventType: 'star',
      repository: 'myorg/repo',
      event: star({ count: 260 }),
      maxAttempts: 5,
    });
    vi.setSystemTime(START + 45 * DAY_MS);
    await database.prepare("DELETE FROM deliveries WHERE delivery_id = 'before'").run();
    await expect(accept(star({ count: 260 }), 'before')).resolves.toEqual({
      outcome: 'duplicate',
    });
    await expect(celebrated()).resolves.toEqual([{ repositoryId: 1, milestone: 100 }]);
  });

  it('gives a milestone to one of two deliveries racing for it, and starts a repository once', async () => {
    const racing = await Promise.all([
      accept(star({ count: 300, repositoryId: 2 })),
      accept(star({ count: 301, repositoryId: 2 })),
    ]);
    expect(racing).toEqual([{ outcome: 'accepted' }, { outcome: 'accepted' }]);
    const seeded = [
      accept(star({ count: 499, repositoryId: 2, login: 'bob' })),
      accept(star({ count: 500, repositoryId: 2, login: 'carol' })),
      accept(star({ count: 501, repositoryId: 2, login: 'dave' })),
    ];
    await Promise.all(seeded);
    const posted = await Promise.all(seeded.map((result) => queuedTitle(result.deliveryId)));
    expect(posted.filter((title) => title === plain)).toHaveLength(2);
    expect(posted.filter((title) => title === reached('500'))).toHaveLength(1);
    await expect(celebrated()).resolves.toEqual([{ repositoryId: 2, milestone: 500 }]);
  });

  describe('when D1 fails', () => {
    beforeEach(async () => {
      await accept(star({ count: 95 }));
    });

    /** The database, failing once at run time the first statement containing `sql`. */
    function failingOnce(sql: string): D1DatabaseLike {
      let failed = false;
      return {
        ...database,
        prepare: (query): D1PreparedStatementLike => {
          if (!failed && query.includes(sql)) {
            failed = true;
            // Binding the original values to this fails inside the batch, as D1 would.
            return database.prepare('SELECT 1');
          }
          return database.prepare(query);
        },
      };
    }

    for (const statement of [
      'INTO star_milestone_baselines',
      'INTO star_milestones (',
      'INTO events',
      "'$.starMilestone'",
      'INTO deliveries',
    ]) {
      it(`accepts a plain star, writing nothing of the milestone, when ${statement} fails`, async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const result = accept(star({ count: 100 }), 'crossing', failingOnce(statement));
        await expect(result).resolves.toEqual({ outcome: 'accepted' });

        await expect(queuedTitle('crossing')).resolves.toBe(plain);
        await expect(celebrated()).resolves.toEqual([]);
        const logged = warn.mock.calls.flat().join('\n');
        expect(logged).toContain('event_processor.enrichment_failed');
        expect(logged).not.toContain('Too many parameter values');
        // The milestone is still there for the next star, and the fallback took nothing.
        await expect(titles([star({ count: 100 }), star({ count: 101 })])).resolves.toEqual([
          reached('100'),
          plain,
        ]);
      });
    }

    it('fails the request when the plain star cannot be stored either', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const down: D1DatabaseLike = {
        ...database,
        batch: () => Promise.reject(new Error('D1 unavailable')),
      };

      await expect(accept(star({ count: 100 }), 'crossing', down)).rejects.toThrow(
        'D1 unavailable'
      );
      await expect(celebrated()).resolves.toEqual([]);
    });

    it('keeps a celebration whose batch committed but whose answer was lost', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      let lost = false;
      const losing: D1DatabaseLike = {
        ...database,
        batch: async (statements) => {
          const results = await database.batch(statements);
          if (!lost) {
            lost = true;
            throw new Error('Network connection lost');
          }
          return results;
        },
      };

      await expect(accept(star({ count: 100 }), 'crossing', losing)).resolves.toEqual({
        outcome: 'duplicate',
      });
      await expect(queuedTitle('crossing')).resolves.toBe(reached('100'));
      await expect(celebrated()).resolves.toEqual([{ repositoryId: 1, milestone: 100 }]);
    });
  });
});
