import { describe, expect, it } from 'vitest';
import type { RepositoryActivity } from '../core/models/daily-digest.js';
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

    expect(added.description).toContain(' starred ');
    expect(added.description).toContain('**100**');
    expect(removed.title).not.toBe(added.title);
    expect(removed.description).toContain('unstarred');
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

    expect(templateOnly.description).toBeUndefined();
    expect(long.description).not.toContain('hidden');
    expect(long.description?.length).toBeLessThanOrEqual(300);
    expect(long.description?.endsWith('...')).toBe(true);
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
    expect(embeds[0]?.fields?.find((field) => field.name === 'Changes')?.value).toBe(
      '+100 −20 in 5 files'
    );
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
    expect(release.description).toBe('## Changes\n- faster');
    expect(release.fields).toEqual([{ name: 'Tag', value: '`v1.2.0`', inline: true }]);
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
    expect(embed.author?.name).toBe('testuser');
    expect(embed.author?.url).toBe('https://github.com/testuser');
    expect(embed.footer?.text).toBe('owner/test-repo');
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
      pullRequestsMerged: 0,
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
      date: '2026-10-15',
      timeZone: 'UTC',
      windowStart: new Date('2026-10-14T09:00:00.000Z'),
      windowEnd: new Date('2026-10-15T09:00:00.000Z'),
      eventCount: 62,
      repositories: [activity('myorg/monorepo', 60), activity('myorg/cli', 0)],
    });

    const lines = payload.embeds[0]?.description?.split('\n') ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('**[myorg/monorepo]');
    expect(lines[0]).toContain('[pkg@1.2.59]');
    expect(lines[0]).toMatch(/ and 57 more$/);
    expect(lines[1]).toContain('**[myorg/cli]');
  });
});
