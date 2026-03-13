import { describe, expect, expectTypeOf, it } from 'vitest';
import { REPO_EVENT_TYPES } from '../core/models/repo-event.js';
import { EventMappingError, mapGitHubEvent } from '../providers/github/event-mapper.js';
import type { GitHubWebhookPayload } from '../providers/github/types.js';

const mockRepo = {
  id: 1,
  name: 'test-repo',
  full_name: 'owner/test-repo',
  owner: { login: 'owner' },
  html_url: 'https://github.com/owner/test-repo',
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
    expect(() => mapGitHubEvent('star', { sender: mockSender } as GitHubWebhookPayload)).toThrow(
      EventMappingError
    );
  });

  it('throws on missing sender', () => {
    expect(() => mapGitHubEvent('star', { repository: mockRepo } as GitHubWebhookPayload)).toThrow(
      EventMappingError
    );
  });

  it('returns null for unsupported event types', () => {
    const result = mapGitHubEvent('unknown_event', {
      repository: mockRepo,
      sender: mockSender,
    } as GitHubWebhookPayload);

    expect(result).toBeNull();
  });

  describe('star events', () => {
    it('maps star.created to a normalized event', () => {
      const result = mapGitHubEvent('star', {
        action: 'created',
        repository: mockRepo,
        sender: mockSender,
      } as GitHubWebhookPayload);

      expect(result?.type).toBe(REPO_EVENT_TYPES.STAR_CREATED);
      if (!result || result.type !== REPO_EVENT_TYPES.STAR_CREATED) {
        throw new Error('Expected star.created event');
      }

      expectTypeOf(result.star.count).toBeNumber();
      expect(result.repository.fullName).toBe('owner/test-repo');
      expect(result.sender.login).toBe('testuser');
      expect(result.star.count).toBe(10);
    });

    it('maps star.deleted to a normalized event', () => {
      const result = mapGitHubEvent('star', {
        action: 'deleted',
        repository: mockRepo,
        sender: mockSender,
      } as GitHubWebhookPayload);

      expect(result?.type).toBe(REPO_EVENT_TYPES.STAR_DELETED);
      if (!result || result.type !== REPO_EVENT_TYPES.STAR_DELETED) {
        throw new Error('Expected star.deleted event');
      }

      expect(result.star.count).toBe(10);
    });

    it('returns null for unknown star actions', () => {
      const result = mapGitHubEvent('star', {
        action: 'unknown',
        repository: mockRepo,
        sender: mockSender,
      } as GitHubWebhookPayload);

      expect(result).toBeNull();
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
      } as GitHubWebhookPayload);

      expect(result?.type).toBe(REPO_EVENT_TYPES.ISSUE_OPENED);
      if (!result || result.type !== REPO_EVENT_TYPES.ISSUE_OPENED) {
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
      } as GitHubWebhookPayload);

      expect(result?.type).toBe(REPO_EVENT_TYPES.ISSUE_CLOSED);
      if (!result || result.type !== REPO_EVENT_TYPES.ISSUE_CLOSED) {
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
      } as GitHubWebhookPayload);

      expect(result?.type).toBe(REPO_EVENT_TYPES.ISSUE_REOPENED);
    });

    it('throws on missing issue data', () => {
      expect(() =>
        mapGitHubEvent('issues', {
          action: 'opened',
          repository: mockRepo,
          sender: mockSender,
        } as GitHubWebhookPayload)
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
      } as GitHubWebhookPayload);

      expect(result?.type).toBe(REPO_EVENT_TYPES.PULL_REQUEST_OPENED);
      if (!result || result.type !== REPO_EVENT_TYPES.PULL_REQUEST_OPENED) {
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
      } as GitHubWebhookPayload);

      expect(result?.type).toBe(REPO_EVENT_TYPES.PULL_REQUEST_CLOSED);
      if (!result || result.type !== REPO_EVENT_TYPES.PULL_REQUEST_CLOSED) {
        throw new Error('Expected pull_request.closed event');
      }

      expect(result.pullRequest.merged).toBe(false);
    });

    it('maps merged pull requests to pull_request.merged', () => {
      const result = mapGitHubEvent('pull_request', {
        action: 'closed',
        repository: mockRepo,
        sender: mockSender,
        pull_request: { ...mockPR, state: 'closed' as const, merged: true },
      } as GitHubWebhookPayload);

      expect(result?.type).toBe(REPO_EVENT_TYPES.PULL_REQUEST_MERGED);
      if (!result || result.type !== REPO_EVENT_TYPES.PULL_REQUEST_MERGED) {
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
      } as GitHubWebhookPayload);

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
      } as GitHubWebhookPayload);

      expect(result?.type).toBe(REPO_EVENT_TYPES.FORK_CREATED);
      if (!result || result.type !== REPO_EVENT_TYPES.FORK_CREATED) {
        throw new Error('Expected fork.created event');
      }

      expectTypeOf(result.fork.fullName).toBeString();
      expect(result.fork.fullName).toBe('otheruser/test-repo');
    });
  });
});
