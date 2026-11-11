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

  describe('free text GitHub sends as an empty string', () => {
    const issue = {
      number: 1,
      title: 'Crash on start',
      html_url: 'https://github.com/owner/test-repo/issues/1',
      state: 'open',
      body: 'text',
      labels: [],
    };
    const pullRequest = {
      number: 2,
      title: 'Fix crash',
      html_url: 'https://github.com/owner/test-repo/pull/2',
      state: 'open',
      merged: false,
      body: 'text',
      draft: false,
      head: { ref: 'fix' },
      base: { ref: 'main' },
    };
    const release = {
      tag_name: 'v1.0.0',
      name: 'v1.0.0',
      html_url: 'https://github.com/owner/test-repo/releases/tag/v1.0.0',
      body: 'notes',
      prerelease: false,
    };

    it.each([
      [
        'repository.description',
        'star',
        { action: 'created', repository: { ...mockRepo, description: '' } },
        { repository: { description: null } },
      ],
      [
        'repository.language',
        'star',
        { action: 'created', repository: { ...mockRepo, language: '' } },
        { repository: { language: null } },
      ],
      [
        'issue.body',
        'issues',
        { action: 'opened', repository: mockRepo, issue: { ...issue, body: '' } },
        { issue: { body: null } },
      ],
      [
        'pull_request.body',
        'pull_request',
        { action: 'opened', repository: mockRepo, pull_request: { ...pullRequest, body: '' } },
        { pullRequest: { body: null } },
      ],
      [
        'release.name',
        'release',
        { action: 'published', repository: mockRepo, release: { ...release, name: '' } },
        { release: { name: null } },
      ],
      [
        'release.body',
        'release',
        { action: 'published', repository: mockRepo, release: { ...release, body: '' } },
        { release: { body: null } },
      ],
    ])('maps an empty %s to null', (_field, event, payload, expected) => {
      const result = mapGitHubEvent(event, {
        sender: mockSender,
        ...payload,
      } as unknown as GitHubWebhookPayload);

      expect(result).toMatchObject(expected);
    });
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

    it("keeps GitHub's star time and the repository's creation time, when valid", () => {
      const created = mapGitHubEvent('star', {
        action: 'created',
        starred_at: '2026-11-03T10:00:00Z',
        repository: { ...mockRepo, created_at: '2025-01-02T03:04:05Z' },
        sender: mockSender,
      });
      const deleted = mapGitHubEvent('star', {
        action: 'deleted',
        starred_at: null,
        // Some payloads send a Unix time here; it is left out rather than misread.
        repository: { ...mockRepo, created_at: 1_735_786_000 },
        sender: mockSender,
      });

      expect(created).toMatchObject({
        occurredAt: '2026-11-03T10:00:00.000Z',
        repository: { createdAt: '2025-01-02T03:04:05.000Z' },
      });
      expect(deleted).not.toHaveProperty('occurredAt');
      expect(deleted?.repository).not.toHaveProperty('createdAt');
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

    it('records why an issue was closed, when GitHub says', () => {
      const closed = (stateReason: unknown): unknown => {
        const result = mapGitHubEvent('issues', {
          action: 'closed',
          repository: mockRepo,
          sender: mockSender,
          issue: { ...mockIssue, state: 'closed' as const, state_reason: stateReason },
        } as unknown as GitHubWebhookPayload);
        return result !== null && 'issue' in result ? result.issue : undefined;
      };

      expect(closed('not_planned')).toMatchObject({ stateReason: 'not_planned' });
      expect(closed('completed')).toMatchObject({ stateReason: 'completed' });
      expect(closed('reopened')).not.toHaveProperty('stateReason');
      expect(closed(null)).not.toHaveProperty('stateReason');
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

    it('records who opened a pull request, what GitHub knows of them, and its commit count', () => {
      const mapped = (pr: object): unknown => {
        const result = mapGitHubEvent('pull_request', {
          action: 'opened',
          repository: mockRepo,
          sender: mockSender,
          pull_request: { ...mockPR, ...pr },
        });
        return result !== null && 'pullRequest' in result ? result.pullRequest : undefined;
      };

      expect(
        mapped({
          user: { login: 'razakiau' },
          author_association: 'FIRST_TIME_CONTRIBUTOR',
          commits: 2,
        })
      ).toMatchObject({
        author: 'razakiau',
        authorAssociation: 'first_time_contributor',
        commits: 2,
      });
      // A payload without them, or with nonsense, is still accepted.
      expect(mapped({ user: null, author_association: 7, commits: -1 })).not.toHaveProperty(
        'author'
      );
      expect(mapped({ commits: 'two' })).not.toHaveProperty('commits');
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

    it('records how many assets a release has and their total size, and none when it has none', () => {
      const mapped = (assets: unknown): unknown => {
        const result = mapGitHubEvent('release', {
          action: 'published',
          repository: mockRepo,
          sender: mockSender,
          release: { ...release, assets },
        } as unknown as GitHubWebhookPayload);
        return result?.type === REPO_EVENT_TYPES.RELEASE_PUBLISHED ? result.release : undefined;
      };

      expect(mapped([{ size: 1000 }, { size: 24 }, {}])).toMatchObject({
        assetCount: 3,
        assetBytes: 1024,
      });
      expect(mapped([])).not.toHaveProperty('assetCount');
      expect(mapped(undefined)).not.toHaveProperty('assetCount');
    });

    it('ignores the follow-up release actions so a release is announced once', () => {
      for (const action of ['released', 'prereleased', 'created', 'edited']) {
        expect(
          mapGitHubEvent('release', { action, repository: mockRepo, sender: mockSender, release })
        ).toBeNull();
      }
    });
  });

  describe('comments, reviews and draft changes', () => {
    // Shaped like GitHub's webhook payloads, trimmed to the fields read.
    const issueOnPullRequest = {
      number: 7,
      title: 'Add a flag',
      html_url: 'https://github.com/owner/test-repo/pull/7',
      state: 'open',
      body: null,
      labels: [],
      created_at: '2026-10-10T10:00:00Z',
      updated_at: '2026-10-12T10:00:00Z',
      pull_request: { url: 'https://api.github.com/repos/owner/test-repo/pulls/7' },
    };
    const comment = {
      id: 42,
      html_url: 'https://github.com/owner/test-repo/pull/7#issuecomment-42',
      body: 'Any news?',
      created_at: '2026-10-12T10:00:00Z',
    };
    const pullRequest = {
      number: 7,
      title: 'Add a flag',
      html_url: 'https://github.com/owner/test-repo/pull/7',
      state: 'open',
      merged: false,
      body: null,
      draft: true,
      head: { ref: 'feature' },
      base: { ref: 'main' },
      created_at: '2026-10-10T10:00:00Z',
      updated_at: '2026-10-11T10:00:00+02:00',
      merged_at: null,
      closed_at: null,
    };

    function map(
      eventType: string,
      payload: Record<string, unknown>
    ): ReturnType<typeof mapGitHubEvent> {
      return mapGitHubEvent(eventType, { repository: mockRepo, sender: mockSender, ...payload });
    }

    it('maps a comment on a pull request without needing a full pull request', () => {
      expect(
        map('issue_comment', { action: 'created', issue: issueOnPullRequest, comment })
      ).toMatchObject({
        type: 'comment.created',
        occurredAt: '2026-10-12T10:00:00.000Z',
        thread: {
          kind: 'pull_request',
          number: 7,
          url: 'https://github.com/owner/test-repo/pull/7',
          state: 'open',
          // A comment's payload does not say whether the pull request is a draft.
          draft: null,
          createdAt: '2026-10-10T10:00:00.000Z',
        },
        comment: { id: 42, url: comment.html_url, body: 'Any news?' },
      });
      const { pull_request: _pullRequest, ...plainIssue } = issueOnPullRequest;
      expect(map('issue_comment', { action: 'created', issue: plainIssue, comment })).toMatchObject(
        {
          thread: { kind: 'issue', draft: null },
        }
      );
      expect(map('issue_comment', { action: 'edited', issue: plainIssue, comment })).toBeNull();
      expect(() => map('issue_comment', { action: 'created', issue: plainIssue })).toThrow(
        EventMappingError
      );
    });

    it('accepts empty and missing review bodies and keeps unknown states as sent', () => {
      const review = (body: unknown, state: string, submittedAt: unknown): unknown =>
        map('pull_request_review', {
          action: 'submitted',
          pull_request: pullRequest,
          review: {
            id: 9,
            html_url: 'https://github.com/owner/test-repo/pull/7#pullrequestreview-9',
            body,
            state,
            submitted_at: submittedAt,
          },
        });

      expect(review('', 'commented', '2026-10-12T11:00:00Z')).toMatchObject({
        type: 'review.submitted',
        occurredAt: '2026-10-12T11:00:00.000Z',
        thread: { kind: 'pull_request', draft: true },
        review: { body: null, state: 'commented' },
      });
      expect(review(null, 'APPROVED', null)).not.toHaveProperty('occurredAt');
      expect(review(' \n', 'dismissed', 'yesterday')).toMatchObject({
        review: { body: null, state: 'dismissed' },
      });
      expect(() => review(3, 'commented', null)).toThrow(EventMappingError);
    });

    it('records draft changes and GitHub’s time for each pull request action', () => {
      expect(
        map('pull_request', {
          action: 'ready_for_review',
          pull_request: { ...pullRequest, draft: false },
        })
      ).toMatchObject({
        type: 'pull_request.ready_for_review',
        occurredAt: '2026-10-11T08:00:00.000Z',
        pullRequest: { draft: false, createdAt: '2026-10-10T10:00:00.000Z' },
      });
      expect(
        map('pull_request', { action: 'converted_to_draft', pull_request: pullRequest })
      ).toMatchObject({
        type: 'pull_request.converted_to_draft',
        pullRequest: { draft: true },
      });
      expect(
        map('pull_request', {
          action: 'closed',
          pull_request: {
            ...pullRequest,
            state: 'closed',
            merged: true,
            merged_at: '2026-10-13T00:00:00Z',
          },
        })
      ).toMatchObject({ type: 'pull_request.merged', occurredAt: '2026-10-13T00:00:00.000Z' });
      expect(
        map('pull_request', {
          action: 'opened',
          pull_request: { ...pullRequest, created_at: 'soon' },
        })
      ).not.toHaveProperty('occurredAt');
    });
  });
});
