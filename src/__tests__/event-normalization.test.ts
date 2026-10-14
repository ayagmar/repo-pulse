import { describe, expect, expectTypeOf, it } from 'vitest';
import { REPO_EVENT_TYPES } from '../core/models/repo-event.js';
import { EventMappingError, mapGitHubEvent } from '../providers/github/event-mapper.js';
import type { GitHubCommit, GitHubWebhookPayload } from '../providers/github/types.js';

const mockRepo = {
  id: 1,
  name: 'test-repo',
  full_name: 'owner/test-repo',
  owner: { login: 'owner' },
  html_url: 'https://github.com/owner/test-repo',
  private: false,
  description: 'Test repo',
  stargazers_count: 10,
  forks_count: 2,
  language: 'TypeScript',
};

const mockSender = {
  id: 1,
  login: 'testuser',
  avatar_url: 'https://avatars.githubusercontent.com/u/1',
  html_url: 'https://github.com/testuser',
};

describe('mapGitHubEvent', () => {
  it('throws on missing repository', () => {
    expect(() => mapGitHubEvent('star', { sender: mockSender })).toThrow(EventMappingError);
  });

  it('throws on missing sender', () => {
    expect(() => mapGitHubEvent('star', { repository: mockRepo })).toThrow(EventMappingError);
  });

  it('returns null for unsupported event types', () => {
    const result = mapGitHubEvent('unknown_event', {
      repository: mockRepo,
      sender: mockSender,
    });

    expect(result).toBeNull();
  });

  describe('star events', () => {
    it('maps star.created to a normalized event', () => {
      const result = mapGitHubEvent('star', {
        action: 'created',
        repository: mockRepo,
        sender: mockSender,
      });

      expect(result?.type).toBe(REPO_EVENT_TYPES.STAR_CREATED);
      if (result?.type !== REPO_EVENT_TYPES.STAR_CREATED) {
        throw new Error('Expected star.created event');
      }

      expectTypeOf(result.star.count).toBeNumber();
      expect(result.repository.fullName).toBe('owner/test-repo');
      expect(result.repository.private).toBe(false);
      expect(result.sender.login).toBe('testuser');
      expect(result.star.count).toBe(10);
    });

    it('maps star.deleted to a normalized event', () => {
      const result = mapGitHubEvent('star', {
        action: 'deleted',
        repository: mockRepo,
        sender: mockSender,
      });

      expect(result?.type).toBe(REPO_EVENT_TYPES.STAR_DELETED);
      if (result?.type !== REPO_EVENT_TYPES.STAR_DELETED) {
        throw new Error('Expected star.deleted event');
      }

      expect(result.star.count).toBe(10);
    });

    it('returns null for unknown star actions', () => {
      const result = mapGitHubEvent('star', {
        action: 'unknown',
        repository: mockRepo,
        sender: mockSender,
      });

      expect(result).toBeNull();
    });

    it('rejects non-finite counters from parsed JSON', () => {
      expect(() =>
        mapGitHubEvent('star', {
          action: 'created',
          repository: { ...mockRepo, stargazers_count: Number.POSITIVE_INFINITY },
          sender: mockSender,
        })
      ).toThrow(new EventMappingError('Invalid repository.stargazers_count'));
    });

    it('throws on malformed repository data instead of returning a broken event', () => {
      expect(() =>
        mapGitHubEvent('star', {
          action: 'created',
          repository: {
            full_name: 'owner/test-repo',
            owner: { login: 'owner' },
          },
          sender: mockSender,
        } as GitHubWebhookPayload)
      ).toThrow(new EventMappingError('Invalid repository.id'));
    });
  });

  describe('issue events', () => {
    const mockIssue = {
      number: 123,
      title: 'Test Issue',
      html_url: 'https://github.com/owner/test-repo/issues/123',
      state: 'open' as const,
      body: 'Issue description',
      labels: [{ name: 'bug' }],
    };

    it('maps issue.opened to a normalized event', () => {
      const result = mapGitHubEvent('issues', {
        action: 'opened',
        repository: mockRepo,
        sender: mockSender,
        issue: mockIssue,
      });

      expect(result?.type).toBe(REPO_EVENT_TYPES.ISSUE_OPENED);
      if (result?.type !== REPO_EVENT_TYPES.ISSUE_OPENED) {
        throw new Error('Expected issue.opened event');
      }

      expectTypeOf(result.issue.title).toBeString();
      expect(result.issue.title).toBe('Test Issue');
      expect(result.issue.labels).toEqual(['bug']);
    });

    it('maps issue.closed to a normalized event', () => {
      const result = mapGitHubEvent('issues', {
        action: 'closed',
        repository: mockRepo,
        sender: mockSender,
        issue: { ...mockIssue, state: 'closed' as const },
      });

      expect(result?.type).toBe(REPO_EVENT_TYPES.ISSUE_CLOSED);
      if (result?.type !== REPO_EVENT_TYPES.ISSUE_CLOSED) {
        throw new Error('Expected issue.closed event');
      }

      expect(result.issue.state).toBe('closed');
    });

    it('maps issue.reopened to a normalized event', () => {
      const result = mapGitHubEvent('issues', {
        action: 'reopened',
        repository: mockRepo,
        sender: mockSender,
        issue: mockIssue,
      });

      expect(result?.type).toBe(REPO_EVENT_TYPES.ISSUE_REOPENED);
    });

    it('throws on missing issue data', () => {
      expect(() =>
        mapGitHubEvent('issues', {
          action: 'opened',
          repository: mockRepo,
          sender: mockSender,
        })
      ).toThrow(EventMappingError);
    });

    it('throws on malformed issue data', () => {
      expect(() =>
        mapGitHubEvent('issues', {
          action: 'opened',
          repository: mockRepo,
          sender: mockSender,
          issue: {
            ...mockIssue,
            labels: 'bug',
          },
        } as unknown as GitHubWebhookPayload)
      ).toThrow(new EventMappingError('Invalid issue.labels'));
    });
  });

  describe('pull request events', () => {
    const mockPR = {
      number: 456,
      title: 'Test PR',
      html_url: 'https://github.com/owner/test-repo/pull/456',
      state: 'open' as const,
      merged: false,
      body: 'PR description',
      draft: false,
      head: { ref: 'feature-branch' },
      base: { ref: 'main' },
      additions: 10,
      deletions: 2,
      changed_files: 3,
    };

    it('maps pull_request.opened to a normalized event', () => {
      const result = mapGitHubEvent('pull_request', {
        action: 'opened',
        repository: mockRepo,
        sender: mockSender,
        pull_request: mockPR,
      });

      expect(result?.type).toBe(REPO_EVENT_TYPES.PULL_REQUEST_OPENED);
      if (result?.type !== REPO_EVENT_TYPES.PULL_REQUEST_OPENED) {
        throw new Error('Expected pull_request.opened event');
      }

      expectTypeOf(result.pullRequest.headBranch).toBeString();
      expect(result.pullRequest.headBranch).toBe('feature-branch');
      expect(result.pullRequest.changedFiles).toBe(3);
    });

    it('maps closed pull requests to pull_request.closed', () => {
      const result = mapGitHubEvent('pull_request', {
        action: 'closed',
        repository: mockRepo,
        sender: mockSender,
        pull_request: { ...mockPR, state: 'closed' as const },
      });

      expect(result?.type).toBe(REPO_EVENT_TYPES.PULL_REQUEST_CLOSED);
      if (result?.type !== REPO_EVENT_TYPES.PULL_REQUEST_CLOSED) {
        throw new Error('Expected pull_request.closed event');
      }

      expect(result.pullRequest.merged).toBe(false);
    });

    it('rejects non-boolean merge status instead of announcing a merge', () => {
      expect(() =>
        mapGitHubEvent('pull_request', {
          action: 'closed',
          repository: mockRepo,
          sender: mockSender,
          pull_request: { ...mockPR, state: 'closed', merged: 'false' },
        } as unknown as GitHubWebhookPayload)
      ).toThrow(new EventMappingError('Invalid pull_request.merged'));
    });

    it('maps merged pull requests to pull_request.merged', () => {
      const result = mapGitHubEvent('pull_request', {
        action: 'closed',
        repository: mockRepo,
        sender: mockSender,
        pull_request: { ...mockPR, state: 'closed' as const, merged: true },
      });

      expect(result?.type).toBe(REPO_EVENT_TYPES.PULL_REQUEST_MERGED);
      if (result?.type !== REPO_EVENT_TYPES.PULL_REQUEST_MERGED) {
        throw new Error('Expected pull_request.merged event');
      }

      expect(result.pullRequest.merged).toBe(true);
    });

    it('maps reopened pull requests to pull_request.reopened', () => {
      const result = mapGitHubEvent('pull_request', {
        action: 'reopened',
        repository: mockRepo,
        sender: mockSender,
        pull_request: mockPR,
      });

      expect(result?.type).toBe(REPO_EVENT_TYPES.PULL_REQUEST_REOPENED);
    });
  });

  describe('fork events', () => {
    it('maps fork events to a normalized event', () => {
      const result = mapGitHubEvent('fork', {
        action: 'created',
        repository: mockRepo,
        sender: mockSender,
        forkee: {
          full_name: 'otheruser/test-repo',
          html_url: 'https://github.com/otheruser/test-repo',
          default_branch: 'main',
        },
      });

      expect(result?.type).toBe(REPO_EVENT_TYPES.FORK_CREATED);
      if (result?.type !== REPO_EVENT_TYPES.FORK_CREATED) {
        throw new Error('Expected fork.created event');
      }

      expectTypeOf(result.fork.fullName).toBeString();
      expect(result.fork.fullName).toBe('otheruser/test-repo');
    });
  });

  describe('push events', () => {
    const commit = (id: string, message: string, distinct = true): GitHubCommit => ({
      id,
      message,
      url: `https://github.com/owner/test-repo/commit/${id}`,
      distinct,
      author: { name: 'Test User', username: 'testuser' },
    });
    const push = (
      overrides: Partial<GitHubWebhookPayload> = {}
    ): Partial<GitHubWebhookPayload> => ({
      ref: 'refs/heads/main',
      deleted: false,
      forced: false,
      compare: 'https://github.com/owner/test-repo/compare/a...b',
      commits: [commit('a1', 'fix: first\n\nbody text'), commit('b2', 'feat: second')],
      repository: { ...mockRepo, default_branch: 'main' },
      sender: mockSender,
      ...overrides,
    });

    it('maps default-branch pushes with commit subjects, oldest first', () => {
      const result = mapGitHubEvent('push', push());

      if (result?.type !== REPO_EVENT_TYPES.PUSH_DEFAULT_BRANCH) {
        throw new Error('Expected push event');
      }
      expect(result.push).toMatchObject({
        branch: 'main',
        forced: false,
        compareUrl: 'https://github.com/owner/test-repo/compare/a...b',
      });
      expect(result.push.commits.map((c) => [c.id, c.message, c.author])).toEqual([
        ['a1', 'fix: first', 'testuser'],
        ['b2', 'feat: second', 'testuser'],
      ]);
    });

    it.each([
      ['other branches', push({ ref: 'refs/heads/feature' })],
      ['tags', push({ ref: 'refs/tags/v1.0.0' })],
      ['branch deletions', push({ deleted: true, commits: [] })],
      ['bots', push({ sender: { ...mockSender, login: 'dependabot[bot]', type: 'Bot' } })],
      [
        'GitHub merge commits',
        push({
          commits: [
            commit('a1', 'fix: on the pull request branch', false),
            commit('m1', 'Merge pull request #12 from x/y'),
          ],
        }),
      ],
      ['squash merges', push({ commits: [commit('s1', 'feat: add thing (#12)')] })],
    ])('ignores %s', (_case, payload) => {
      expect(mapGitHubEvent('push', payload)).toBeNull();
    });

    it('announces fast-forwards to commits already pushed on another branch', () => {
      const result = mapGitHubEvent(
        'push',
        push({ commits: [commit('a1', 'fix: first', false), commit('b2', 'feat: second', false)] })
      );

      if (result?.type !== REPO_EVENT_TYPES.PUSH_DEFAULT_BRANCH) {
        throw new Error('Expected push event');
      }
      expect(result.push.commits.map((c) => c.id)).toEqual(['a1', 'b2']);
    });

    it('announces pushes that only mention a pull request among other commits', () => {
      const result = mapGitHubEvent(
        'push',
        push({ commits: [commit('a1', 'fix (#12)'), commit('b2', 'chore: follow-up')] })
      );

      expect(result?.type).toBe(REPO_EVENT_TYPES.PUSH_DEFAULT_BRANCH);
    });

    it('rejects malformed push payloads', () => {
      expect(() => mapGitHubEvent('push', { ...push(), commits: 'not-a-list' } as never)).toThrow(
        EventMappingError
      );
    });
  });

  describe('release events', () => {
    const release = {
      tag_name: 'v1.2.0',
      name: '',
      html_url: 'https://github.com/owner/test-repo/releases/tag/v1.2.0',
      body: 'notes',
      prerelease: true,
    };

    it('maps published releases, treating an empty name as absent', () => {
      const result = mapGitHubEvent('release', {
        action: 'published',
        repository: mockRepo,
        sender: mockSender,
        release,
      });

      if (result?.type !== REPO_EVENT_TYPES.RELEASE_PUBLISHED) {
        throw new Error('Expected release event');
      }
      expect(result.release).toEqual({
        tagName: 'v1.2.0',
        name: null,
        url: release.html_url,
        body: 'notes',
        prerelease: true,
      });
    });

    it('ignores the follow-up release actions so a release is announced once', () => {
      for (const action of ['released', 'prereleased', 'created', 'edited']) {
        expect(
          mapGitHubEvent('release', { action, repository: mockRepo, sender: mockSender, release })
        ).toBeNull();
      }
    });
  });
});
