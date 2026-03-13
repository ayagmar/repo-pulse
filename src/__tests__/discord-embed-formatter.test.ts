import { describe, expect, it } from 'vitest';
import {
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
  createRepoEvent,
} from '../core/models/repo-event.js';
import type {
  RepoEvent,
  RepoEventInput,
  RepoEventOf,
  RepoEventType,
} from '../core/models/repo-event.js';
import { formatDiscordEmbed } from '../providers/discord/embed-formatter.js';

type BaseEventPayload = Pick<RepoEvent, 'repository' | 'sender'>;

const basePayload: BaseEventPayload = {
  repository: {
    id: 1,
    name: 'test-repo',
    fullName: 'owner/test-repo',
    owner: 'owner',
    url: 'https://github.com/owner/test-repo',
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

describe('formatDiscordEmbed', () => {
  it('formats star.created events', () => {
    const event = createEvent(REPO_EVENT_TYPES.STAR_CREATED, {
      action: REPO_EVENT_ACTIONS.CREATED,
      star: { count: 100 },
    });

    const result = formatDiscordEmbed(event);
    const embed = getFirstEmbed(result);

    expect(result.embeds).toHaveLength(1);
    expect(embed.title).toBe('⭐ New Star');
    expect(embed.description).toContain('100');
    expect(embed.color).toBe(0xffd700);
  });

  it('formats star.deleted events distinctly from star.created', () => {
    const event = createEvent(REPO_EVENT_TYPES.STAR_DELETED, {
      action: REPO_EVENT_ACTIONS.DELETED,
      star: { count: 99 },
    });

    const result = formatDiscordEmbed(event);
    const embed = getFirstEmbed(result);

    expect(embed.title).toBe('💫 Star Removed');
    expect(embed.description).toContain('99');
  });

  it('formats issue.opened events', () => {
    const event = createEvent(REPO_EVENT_TYPES.ISSUE_OPENED, {
      action: REPO_EVENT_ACTIONS.OPENED,
      issue: {
        number: 123,
        title: 'Bug: Something is broken',
        url: 'https://github.com/owner/test-repo/issues/123',
        state: 'open',
        body: 'This is a detailed bug description',
        labels: ['bug', 'priority:high'],
      },
    });

    const result = formatDiscordEmbed(event);
    const embed = getFirstEmbed(result);

    expect(embed.title).toBe('🐛 New Issue #123');
    expect(embed.description).toContain('Bug: Something is broken');
    expect(embed.color).toBe(0x28a745);
    expect(embed.fields?.some((field) => field.name === 'Labels')).toBe(true);
  });

  it('truncates long issue bodies', () => {
    const event = createEvent(REPO_EVENT_TYPES.ISSUE_OPENED, {
      action: REPO_EVENT_ACTIONS.OPENED,
      issue: {
        number: 1,
        title: 'Long issue',
        url: 'https://github.com/owner/test-repo/issues/1',
        state: 'open',
        body: 'A'.repeat(500),
        labels: [],
      },
    });

    const result = formatDiscordEmbed(event);
    const embed = getFirstEmbed(result);

    expect(embed.description?.length).toBeLessThan(300);
    expect(embed.description).toContain('...');
  });

  it('formats pull_request.opened events', () => {
    const event = createEvent(REPO_EVENT_TYPES.PULL_REQUEST_OPENED, {
      action: REPO_EVENT_ACTIONS.OPENED,
      pullRequest: {
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
      },
    });

    const result = formatDiscordEmbed(event);
    const embed = getFirstEmbed(result);

    expect(embed.title).toBe('📥 New Pull Request #456');
    expect(embed.description).toContain('feat: Add new feature');
    expect(embed.color).toBe(0x6f42c1);
  });

  it('formats pull_request.merged events', () => {
    const event = createEvent(REPO_EVENT_TYPES.PULL_REQUEST_MERGED, {
      action: REPO_EVENT_ACTIONS.CLOSED,
      pullRequest: {
        number: 789,
        title: 'feat: Merged feature',
        url: 'https://github.com/owner/test-repo/pull/789',
        state: 'closed',
        merged: true,
        body: 'This PR was merged',
        draft: false,
        headBranch: 'feature',
        baseBranch: 'main',
      },
    });

    const result = formatDiscordEmbed(event);
    const embed = getFirstEmbed(result);

    expect(embed.title).toBe('🔀 Pull Request Merged #789');
    expect(embed.color).toBe(0x6f42c1);
  });

  it('formats fork.created events', () => {
    const event = createEvent(REPO_EVENT_TYPES.FORK_CREATED, {
      action: REPO_EVENT_ACTIONS.CREATED,
      fork: {
        fullName: 'otheruser/test-repo',
        url: 'https://github.com/otheruser/test-repo',
        defaultBranch: 'main',
      },
    });

    const result = formatDiscordEmbed(event);
    const embed = getFirstEmbed(result);

    expect(embed.title).toBe('🍴 New Fork');
    expect(embed.description).toContain('otheruser/test-repo');
    expect(embed.color).toBe(0x0366d6);
  });

  it('includes timestamp and author in all embeds', () => {
    const event = createEvent(REPO_EVENT_TYPES.STAR_CREATED, {
      action: REPO_EVENT_ACTIONS.CREATED,
      star: { count: 1 },
    });

    const result = formatDiscordEmbed(event);
    const embed = getFirstEmbed(result);

    expect(embed.timestamp).toBe(event.timestamp.toISOString());
    expect(embed.author?.name).toBe('testuser');
    expect(embed.author?.url).toBe('https://github.com/testuser');
  });
});
