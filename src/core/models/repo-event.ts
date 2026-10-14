/**
 * Internal domain model for repository events.
 * Normalized representation of inbound repository activity.
 */

export interface Repository {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  url: string;
  private: boolean;
  description: string | null;
  stars: number;
  forks: number;
  language: string | null;
}

export interface User {
  id: number;
  login: string;
  avatarUrl: string;
  url: string;
}

export interface Issue {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  body: string | null;
  labels: string[];
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  body: string | null;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

interface Fork {
  fullName: string;
  url: string;
  defaultBranch: string;
}

export interface Commit {
  id: string;
  /** First line of the commit message. */
  message: string;
  url: string;
  author: string;
}

interface Push {
  branch: string;
  compareUrl: string;
  forced: boolean;
  /** Distinct new commits, oldest first. */
  commits: Commit[];
}

interface Release {
  tagName: string;
  name: string | null;
  url: string;
  body: string | null;
  prerelease: boolean;
}

export const REPO_EVENT_ACTIONS = {
  CREATED: 'created',
  DELETED: 'deleted',
  OPENED: 'opened',
  CLOSED: 'closed',
  REOPENED: 'reopened',
  PUSHED: 'pushed',
  PUBLISHED: 'published',
} as const;

export const REPO_EVENT_TYPES = {
  STAR_CREATED: 'star.created',
  STAR_DELETED: 'star.deleted',
  ISSUE_OPENED: 'issue.opened',
  ISSUE_CLOSED: 'issue.closed',
  ISSUE_REOPENED: 'issue.reopened',
  PULL_REQUEST_OPENED: 'pull_request.opened',
  PULL_REQUEST_CLOSED: 'pull_request.closed',
  PULL_REQUEST_MERGED: 'pull_request.merged',
  PULL_REQUEST_REOPENED: 'pull_request.reopened',
  FORK_CREATED: 'fork.created',
  PUSH_DEFAULT_BRANCH: 'push.default_branch',
  RELEASE_PUBLISHED: 'release.published',
} as const;

interface RepoEventPayloadMap {
  [REPO_EVENT_TYPES.STAR_CREATED]: {
    action: typeof REPO_EVENT_ACTIONS.CREATED;
    star: {
      count: number;
    };
  };
  [REPO_EVENT_TYPES.STAR_DELETED]: {
    action: typeof REPO_EVENT_ACTIONS.DELETED;
    star: {
      count: number;
    };
  };
  [REPO_EVENT_TYPES.ISSUE_OPENED]: {
    action: typeof REPO_EVENT_ACTIONS.OPENED;
    issue: Issue;
  };
  [REPO_EVENT_TYPES.ISSUE_CLOSED]: {
    action: typeof REPO_EVENT_ACTIONS.CLOSED;
    issue: Issue;
  };
  [REPO_EVENT_TYPES.ISSUE_REOPENED]: {
    action: typeof REPO_EVENT_ACTIONS.REOPENED;
    issue: Issue;
  };
  [REPO_EVENT_TYPES.PULL_REQUEST_OPENED]: {
    action: typeof REPO_EVENT_ACTIONS.OPENED;
    pullRequest: PullRequest;
  };
  [REPO_EVENT_TYPES.PULL_REQUEST_CLOSED]: {
    action: typeof REPO_EVENT_ACTIONS.CLOSED;
    pullRequest: PullRequest;
  };
  [REPO_EVENT_TYPES.PULL_REQUEST_MERGED]: {
    action: typeof REPO_EVENT_ACTIONS.CLOSED;
    pullRequest: PullRequest;
  };
  [REPO_EVENT_TYPES.PULL_REQUEST_REOPENED]: {
    action: typeof REPO_EVENT_ACTIONS.REOPENED;
    pullRequest: PullRequest;
  };
  [REPO_EVENT_TYPES.FORK_CREATED]: {
    action: typeof REPO_EVENT_ACTIONS.CREATED;
    fork: Fork;
  };
  [REPO_EVENT_TYPES.PUSH_DEFAULT_BRANCH]: {
    action: typeof REPO_EVENT_ACTIONS.PUSHED;
    push: Push;
  };
  [REPO_EVENT_TYPES.RELEASE_PUBLISHED]: {
    action: typeof REPO_EVENT_ACTIONS.PUBLISHED;
    release: Release;
  };
}

export type RepoEventType = keyof RepoEventPayloadMap;

interface BaseRepoEvent<TType extends RepoEventType, TAction extends string> {
  type: TType;
  action: TAction;
  repository: Repository;
  sender: User;
  timestamp: Date;
}

export type RepoEvent = {
  [Type in RepoEventType]: BaseRepoEvent<Type, RepoEventPayloadMap[Type]['action']> &
    Omit<RepoEventPayloadMap[Type], 'action'>;
}[RepoEventType];

export type RepoEventOf<TType extends RepoEventType> = Extract<RepoEvent, { type: TType }>;
export type StarEvent = RepoEventOf<'star.created' | 'star.deleted'>;
export type IssueEvent = RepoEventOf<'issue.opened' | 'issue.closed' | 'issue.reopened'>;
export type PullRequestEvent = RepoEventOf<
  'pull_request.opened' | 'pull_request.closed' | 'pull_request.merged' | 'pull_request.reopened'
>;
export type ForkEvent = RepoEventOf<'fork.created'>;
export type PushEvent = RepoEventOf<'push.default_branch'>;
export type ReleaseEvent = RepoEventOf<'release.published'>;
export type RepoEventInput<TType extends RepoEventType> = Omit<
  RepoEventOf<TType>,
  'timestamp' | 'type'
>;

/**
 * Factory function for creating RepoEvent instances.
 */
export function createRepoEvent<TType extends RepoEventType>(
  type: TType,
  payload: RepoEventInput<TType>
): RepoEventOf<TType> {
  return {
    type,
    timestamp: new Date(),
    ...payload,
  } as RepoEventOf<TType>;
}
