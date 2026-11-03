import { describe, expect, it } from 'vitest';
import type { RepositoryActivity } from '../core/models/digest.js';
import type {
  RepoEvent,
  RepoEventInput,
  RepoEventOf,
  RepoEventType,
} from '../core/models/repo-event.js';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
} from '../core/models/repo-event.js';
import { formatDiscordDigest, formatDiscordEmbed } from '../providers/discord/embed-formatter.js';

type BaseEventPayload = Pick<RepoEvent, 'repository' | 'sender'>;

const basePayload: BaseEventPayload = {
  repository: {
    id: 1,
    name: 'test-repo',
    fullName: 'owner/test-repo',
    owner: 'owner',
    url: 'https://github.com/owner/test-repo',
    private: false,
    description: 'A test repository',
    stars: 42,
    forks: 5,
    language: 'TypeScript',
  },
  sender: {
    id: 1,
    login: 'testuser',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1',
    url: 'https://github.com/testuser',
  },
};

function createEvent<TType extends RepoEventType>(
  type: TType,
  payload: Omit<RepoEventInput<TType>, keyof BaseEventPayload>
): RepoEventOf<TType> {
  const eventPayload = {
    ...basePayload,
    ...payload,
  } as RepoEventInput<TType>;

  return createRepoEvent(type, eventPayload);
}

function getFirstEmbed(
  event: ReturnType<typeof formatDiscordEmbed>
): ReturnType<typeof formatDiscordEmbed>['embeds'][number] {
  const [embed] = event.embeds;

  if (embed === undefined) {
    throw new Error('Expected one embed');
  }

  return embed;
}

function pullRequest(
  overrides: Partial<RepoEventOf<'pull_request.opened'>['pullRequest']> = {}
): RepoEventOf<'pull_request.opened'>['pullRequest'] {
  return {
    number: 456,
    title: 'feat: Add new feature',
    url: 'https://github.com/owner/test-repo/pull/456',
    state: 'open',
    merged: false,
    body: 'This PR adds a cool feature',
    draft: false,
    headBranch: 'feature-branch',
    baseBranch: 'main',
    additions: 100,
    deletions: 20,
    changedFiles: 5,
    ...overrides,
  };
}

function commits(count: number): RepoEventOf<'push.default_branch'>['push']['commits'] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${String(index).padStart(2, '0')}${'a'.repeat(38)}`,
    message: `commit ${String(index + 1)}`,
    url: `https://github.com/owner/test-repo/commit/${String(index)}`,
    author: 'testuser',
  }));
}

describe('formatDiscordEmbed', () => {
  it('announces stars with the running total, and says when a star is removed', () => {
    const added = getFirstEmbed(
      formatDiscordEmbed(
        createEvent(REPO_EVENT_TYPES.STAR_CREATED, {
          action: REPO_EVENT_ACTIONS.CREATED,
          star: { count: 100 },
        })
      )
    );
    const removed = getFirstEmbed(
      formatDiscordEmbed(
        createEvent(REPO_EVENT_TYPES.STAR_DELETED, {
          action: REPO_EVENT_ACTIONS.DELETED,
          star: { count: 99 },
        })
      )
    );

    expect(added.title).toBe('⭐ New star · 100 total');
    expect(added.description).toBe(
      '[testuser](https://github.com/testuser) starred this repository'
    );
    expect(removed.title).toBe('💫 Star removed · 99 total');
    expect(removed.description).toContain('unstarred');
  });

  it('celebrates a star only from the milestone stored with it, never from its count', () => {
    const star = (count: number, starMilestone?: unknown): RepoEventOf<'star.created'> => ({
      ...createEvent(REPO_EVENT_TYPES.STAR_CREATED, {
        action: REPO_EVENT_ACTIONS.CREATED,
        star: { count },
      }),
      ...(starMilestone !== undefined ? { starMilestone: starMilestone as never } : {}),
    });
    const stored = {
      milestone: 1000,
      reachedAt: '2026-11-03T12:00:00.000Z',
      previous: { milestone: 500, reachedAt: '2026-10-01T09:00:00.000Z' },
      recentStars: { since: '2026-10-27T12:00:00.000Z', net: 42 },
    };

    // Exact counts without a stored milestone: a fallback, a duplicate, a seeded one, or
    // an event stored before milestones were.
    for (const count of [10, 1000, 30_000]) {
      expect(getFirstEmbed(formatDiscordEmbed(star(count))).title).toMatch(/^⭐ New star · /);
    }
    expect(getFirstEmbed(formatDiscordEmbed(star(1000, { milestone: 999 }))).title).toMatch(
      /^⭐ New star · /
    );

    const celebration = getFirstEmbed(formatDiscordEmbed(star(1003, stored)));
    expect(celebration.title).toBe('🎉 owner/test-repo reached 1,000 stars');
    expect(celebration.description).toBe(
      [
        'Observed after [testuser](https://github.com/testuser) starred this repository · **1,003** total',
        '⏱️ 33d since 500 stars',
        '📈 +42 net recorded stars in the last 7 days',
      ].join('\n')
    );

    // The first one: counted from the repository's creation, or not at all.
    const first = { ...stored, milestone: 10, previous: null };
    const created = star(10, { ...first, recentStars: { ...stored.recentStars, net: -1 } });
    created.repository = { ...created.repository, createdAt: '2026-10-20T12:00:00.000Z' };
    expect(getFirstEmbed(formatDiscordEmbed(created)).description).toBe(
      [
        'Observed after [testuser](https://github.com/testuser) starred this repository · **10** total',
        '⏱️ 14d since the repository was created',
        '📈 -1 net recorded star in the last 7 days',
      ].join('\n')
    );
    expect(getFirstEmbed(formatDiscordEmbed(star(10, first))).description).not.toContain('⏱️');
  });

  it('names the issue in the title and lists labels', () => {
    const embed = getFirstEmbed(
      formatDiscordEmbed(
        createEvent(REPO_EVENT_TYPES.ISSUE_OPENED, {
          action: REPO_EVENT_ACTIONS.OPENED,
          issue: {
            number: 123,
            title: 'Bug: Something is broken',
            url: 'https://github.com/owner/test-repo/issues/123',
            state: 'open',
            body: 'This is a detailed bug description',
            labels: ['bug', 'priority:high'],
          },
        })
      )
    );

    expect(embed.title).toContain('#123: Bug: Something is broken');
    expect(embed.url).toBe('https://github.com/owner/test-repo/issues/123');
    expect(embed.description).toBe('This is a detailed bug description');
    expect(embed.fields).toEqual([expect.objectContaining({ name: 'Labels' })]);
  });

  it('omits empty labels and descriptions instead of showing placeholders', () => {
    const embed = getFirstEmbed(
      formatDiscordEmbed(
        createEvent(REPO_EVENT_TYPES.ISSUE_OPENED, {
          action: REPO_EVENT_ACTIONS.OPENED,
          issue: {
            number: 1,
            title: 'Empty',
            url: 'https://github.com/owner/test-repo/issues/1',
            state: 'open',
            body: null,
            labels: [],
          },
        })
      )
    );

    expect(embed.description).toBeUndefined();
    expect(embed.fields).toBeUndefined();
  });

  it('strips template comments from pull request bodies and bounds the excerpt', () => {
    const templateOnly = getFirstEmbed(
      formatDiscordEmbed(
        createEvent(REPO_EVENT_TYPES.PULL_REQUEST_OPENED, {
          action: REPO_EVENT_ACTIONS.OPENED,
          pullRequest: pullRequest({ body: '<!-- Describe your change -->\n\n<!-- Tests? -->' }),
        })
      )
    );
    const long = getFirstEmbed(
      formatDiscordEmbed(
        createEvent(REPO_EVENT_TYPES.PULL_REQUEST_OPENED, {
          action: REPO_EVENT_ACTIONS.OPENED,
          pullRequest: pullRequest({ body: `<!-- hidden -->${'A'.repeat(500)}` }),
        })
      )
    );

    expect(templateOnly.description).toBe('+100 −20 in 5 files');
    const excerpt = long.description?.split('\n\n')[1] ?? '';
    expect(excerpt).not.toContain('hidden');
    expect(excerpt.length).toBeLessThanOrEqual(300);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('distinguishes opened, draft, merged and closed pull requests by title and color', () => {
    const format = (
      type: 'pull_request.opened' | 'pull_request.merged' | 'pull_request.closed',
      overrides: Parameters<typeof pullRequest>[0] = {}
    ): ReturnType<typeof getFirstEmbed> =>
      getFirstEmbed(
        formatDiscordEmbed(
          createRepoEvent(type, {
            ...basePayload,
            action:
              type === 'pull_request.opened'
                ? REPO_EVENT_ACTIONS.OPENED
                : REPO_EVENT_ACTIONS.CLOSED,
            pullRequest: pullRequest(overrides),
          })
        )
      );
    const embeds = [
      format('pull_request.opened'),
      format('pull_request.opened', { draft: true }),
      format('pull_request.merged', { state: 'closed', merged: true }),
      format('pull_request.closed', { state: 'closed' }),
    ];

    expect(new Set(embeds.map((embed) => embed.color)).size).toBe(4);
    expect(new Set(embeds.map((embed) => embed.title)).size).toBe(4);
    for (const embed of embeds) {
      expect(embed.title).toContain('#456: feat: Add new feature');
    }
    expect(embeds[0]?.description).toMatch(/^\+100 −20 in 5 files\n\n/);
    expect(embeds[0]?.fields).toBeUndefined();
  });

  it('links forks to the new repository', () => {
    const embed = getFirstEmbed(
      formatDiscordEmbed(
        createEvent(REPO_EVENT_TYPES.FORK_CREATED, {
          action: REPO_EVENT_ACTIONS.CREATED,
          fork: {
            fullName: 'otheruser/test-repo',
            url: 'https://github.com/otheruser/test-repo',
            defaultBranch: 'main',
          },
        })
      )
    );

    expect(embed.url).toBe('https://github.com/otheruser/test-repo');
    expect(embed.description).toContain(
      '[otheruser/test-repo](https://github.com/otheruser/test-repo)'
    );
  });

  it('summarizes a push with its latest commits and how many came before', () => {
    const embed = getFirstEmbed(
      formatDiscordEmbed(
        createEvent(REPO_EVENT_TYPES.PUSH_DEFAULT_BRANCH, {
          action: REPO_EVENT_ACTIONS.PUSHED,
          push: {
            branch: 'main',
            compareUrl: 'https://github.com/owner/test-repo/compare/a...b',
            forced: false,
            commits: commits(8),
          },
        })
      )
    );
    const lines = embed.description?.split('\n') ?? [];

    expect(embed.title).toBe('📌 8 new commits on main');
    expect(embed.url).toBe('https://github.com/owner/test-repo/compare/a...b');
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain('3 earlier commits');
    expect(lines.at(-1)).toContain('commit 8');
    expect(lines.at(-1)).toContain('[`07aaaaa`]');
  });

  it('flags force pushes', () => {
    const embed = getFirstEmbed(
      formatDiscordEmbed(
        createEvent(REPO_EVENT_TYPES.PUSH_DEFAULT_BRANCH, {
          action: REPO_EVENT_ACTIONS.PUSHED,
          push: {
            branch: 'main',
            compareUrl: 'https://github.com/owner/test-repo/compare/a...b',
            forced: true,
            commits: commits(1),
          },
        })
      )
    );

    expect(embed.title).toBe('⚠️ Force-pushed 1 commit to main');
  });

  it('announces releases with notes and marks pre-releases', () => {
    const format = (prerelease: boolean): ReturnType<typeof getFirstEmbed> =>
      getFirstEmbed(
        formatDiscordEmbed(
          createEvent(REPO_EVENT_TYPES.RELEASE_PUBLISHED, {
            action: REPO_EVENT_ACTIONS.PUBLISHED,
            release: {
              tagName: 'v1.2.0',
              name: 'Spring cleaning',
              url: 'https://github.com/owner/test-repo/releases/tag/v1.2.0',
              body: '## Changes\n- faster',
              prerelease,
            },
          })
        )
      );
    const release = format(false);

    expect(release.title).toBe('🚀 Released Spring cleaning');
    expect(release.description).toBe('tag `v1.2.0`\n\nChanges\n\n- faster');
    expect(format(true).title).toBe('🧪 Pre-release Spring cleaning');
    expect(format(true).color).not.toBe(release.color);
  });

  it('keeps titles and label lists within Discord limits', () => {
    const embed = getFirstEmbed(
      formatDiscordEmbed(
        createEvent(REPO_EVENT_TYPES.ISSUE_OPENED, {
          action: REPO_EVENT_ACTIONS.OPENED,
          issue: {
            number: 1,
            title: 'T'.repeat(400),
            url: 'https://github.com/owner/test-repo/issues/1',
            state: 'open',
            body: null,
            labels: Array.from({ length: 100 }, () => 'label'.repeat(10)),
          },
        })
      )
    );

    expect(embed.title.length).toBe(256);
    expect(embed.fields?.[0]?.value.length).toBe(1024);
  });

  it('includes timestamp, author and repository in all embeds', () => {
    const event = createEvent(REPO_EVENT_TYPES.STAR_CREATED, {
      action: REPO_EVENT_ACTIONS.CREATED,
      star: { count: 1 },
    });

    const embed = getFirstEmbed(formatDiscordEmbed(event));

    expect(embed.timestamp).toBe(event.timestamp.toISOString());
    // The repository is above the title, next to who acted; only the timestamp is below.
    expect(embed.author?.name).toBe('testuser · owner/test-repo');
    expect(embed.author?.url).toBe('https://github.com/testuser');
    expect(embed.footer).toBeUndefined();
  });

  it('says whether the sender is new or has been seen before, and nothing when unknown', () => {
    const issue = createEvent(REPO_EVENT_TYPES.ISSUE_OPENED, {
      action: REPO_EVENT_ACTIONS.OPENED,
      issue: {
        number: 7,
        title: 'Crash on start',
        url: 'https://github.com/owner/test-repo/issues/7',
        state: 'open',
        body: null,
        labels: [],
      },
    });
    const star = createEvent(REPO_EVENT_TYPES.STAR_CREATED, {
      action: REPO_EVENT_ACTIONS.CREATED,
      star: { count: 3 },
    });
    const firstTime = {
      firstSeenAt: null,
      priorEvents: 0,
      priorRepositories: 0,
      priorInRepository: 0,
    };
    const returning = {
      firstSeenAt: '2026-03-04T23:30:00.000Z',
      priorEvents: 12,
      priorRepositories: 3,
      priorInRepository: 1,
    };

    expect(getFirstEmbed(formatDiscordEmbed(issue))).not.toHaveProperty('description');
    expect(
      getFirstEmbed(formatDiscordEmbed({ ...issue, senderHistory: firstTime })).description
    ).toBe('👋 First event recorded from them');
    expect(getFirstEmbed(formatDiscordEmbed(star)).description).toBe(
      '[testuser](https://github.com/testuser) starred this repository'
    );
    expect(
      getFirstEmbed(formatDiscordEmbed({ ...star, senderHistory: returning })).description
    ).toBe(
      '[testuser](https://github.com/testuser) starred this repository\n\n↩️ Seen before: 12 events in 3 repos since 4 Mar 2026'
    );
  });
});

describe('formatDiscordDigest', () => {
  function activity(repository: string, releaseCount: number): RepositoryActivity {
    return {
      repository,
      url: `https://github.com/${repository}`,
      starsGained: 0,
      forks: 0,
      commits: 1,
      pullRequestsOpened: 0,
      pullRequestsOpenedByBots: 0,
      pullRequestsMerged: [],
      issuesOpened: 0,
      issuesClosed: 0,
      releases: Array.from({ length: releaseCount }, (_, index) => ({
        tagName: `pkg@1.2.${String(index)}`,
        url: `https://github.com/${repository}/releases/tag/pkg@1.2.${String(index)}`,
      })),
    };
  }

  it('keeps a repository that published many releases, listing its latest three', () => {
    const payload = formatDiscordDigest({
      period: 'daily',
      date: '2026-10-15',
      timeZone: 'UTC',
      windowStart: new Date('2026-10-14T09:00:00.000Z'),
      windowEnd: new Date('2026-10-15T09:00:00.000Z'),
      eventCount: 62,
      repositories: [activity('myorg/monorepo', 60), activity('myorg/cli', 0)],
      unreleased: [],
      people: [],
      waiting: [],
      responseTimes: null,
    });

    const lines = (payload.embeds[0]?.description?.split('\n') ?? []).filter((line) =>
      line.startsWith('**')
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('**[myorg/monorepo]');
    expect(lines[0]).toContain('[pkg@1.2.59]');
    expect(lines[0]).toMatch(/ and 57 more$/);
    expect(lines[1]).toContain('**[myorg/cli]');
  });

  it('keeps the whole embed within Discord’s 6,000 characters, waiting list first', () => {
    const long = (prefix: string, length: number): string => prefix.padEnd(length, 'x');
    const payload = formatDiscordDigest({
      period: 'weekly',
      date: '2026-10-19',
      timeZone: 'UTC',
      windowStart: new Date('2026-10-12T09:00:00.000Z'),
      windowEnd: new Date('2026-10-19T09:00:00.000Z'),
      eventCount: 900,
      repositories: Array.from({ length: 300 }, (_, index) =>
        activity(long(`org/repo-${String(index)}-`, 100), 5)
      ),
      unreleased: Array.from({ length: 5 }, (_, index) => ({
        repository: long(`org/unreleased-${String(index)}-`, 100),
        compareUrl: long('https://github.com/compare/', 300),
        tagName: long('v', 100),
        releasedAt: new Date('2026-10-01T00:00:00.000Z'),
        commitsSinceRelease: 10 + index,
      })),
      people: Array.from({ length: 5 }, (_, index) => ({
        login: long(`person-${String(index)}-`, 39),
        url: long('https://github.com/', 300),
        events: 3,
        repositories: 2,
        isNew: true,
      })),
      waiting: Array.from({ length: 12 }, (_, index) => ({
        repository: long(`org/waiting-${String(index)}-`, 100),
        number: 10_000 + index,
        title: long('A very long title ', 256),
        url: long('https://github.com/org/repo/issues/', 200),
        login: long('someone-', 39),
        since: new Date(Date.parse('2026-10-01T00:00:00.000Z') + index * 3_600_000),
      })),
      responseTimes: {
        merge: { medianMs: 52 * 3_600_000, count: 6 },
        firstReply: { medianMs: 5 * 3_600_000, count: 4 },
      },
    });

    const embed = payload.embeds[0];
    const fields = embed?.fields ?? [];
    const total =
      (embed?.title.length ?? 0) +
      (embed?.description?.length ?? 0) +
      (embed?.footer?.text.length ?? 0) +
      (embed?.author?.name.length ?? 0) +
      fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
    expect(embed?.description?.length).toBeLessThanOrEqual(4096);
    expect(embed?.description).toMatch(/\n_…and \d+ repositories more_$/);
    for (const field of fields) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    expect(fields.map((field) => field.name)).toEqual([
      '⏳ Waiting on you',
      '⏱️ Response times',
      '🚢 Not released yet',
      "👥 Who's showing up",
    ]);
    const waiting = fields[0]?.value.split('\n') ?? [];
    expect(waiting.at(-1)).toBe(`…and ${String(12 - (waiting.length - 1))} more`);
    expect(waiting[0]).toMatch(
      /^\[org\/waiting-0-x+#10000\]\(.+\) A very long title x+… · @someone-x+ · 18d$/
    );
    expect(fields[1]?.value).toBe(
      'Merge: 2d 4h median (6 PRs) · First reply: 5h median (4 threads)'
    );
  });

  it('heads a digest with only waiting threads truthfully, and leaves out an empty half', () => {
    const payload = formatDiscordDigest({
      period: 'weekly',
      date: '2026-10-19',
      timeZone: 'UTC',
      windowStart: new Date('2026-10-12T09:00:00.000Z'),
      windowEnd: new Date('2026-10-19T09:00:00.000Z'),
      eventCount: 0,
      repositories: [],
      unreleased: [],
      people: [],
      waiting: [
        {
          repository: 'myorg/repo',
          number: 12,
          title: 'Crash on start',
          url: 'https://github.com/myorg/repo/issues/12',
          login: 'alice',
          since: new Date('2026-10-19T04:30:00.000Z'),
        },
      ],
      responseTimes: { merge: null, firstReply: { medianMs: 20 * 60_000, count: 1 } },
    });

    expect(payload.embeds[0]?.description).toBe('No new events');
    expect(payload.embeds[0]?.title).toBe('📦 Weekly pulse · Mon 12 Oct to Sun 18 Oct');
    expect(payload.embeds[0]?.fields).toEqual([
      {
        name: '⏳ Waiting on you',
        value:
          '[myorg/repo#12](https://github.com/myorg/repo/issues/12) Crash on start · @alice · 4h',
      },
      { name: '⏱️ Response times', value: 'First reply: <1h median (1 thread)' },
    ]);
  });
});
