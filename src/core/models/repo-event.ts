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

export const REPO_EVENT_ACTIONS = {
  CREATED: 'created',
  DELETED: 'deleted',
  OPENED: 'opened',
  CLOSED: 'closed',
  REOPENED: 'reopened',
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
} as const;

const STAR_EVENT_TYPES = [REPO_EVENT_TYPES.STAR_CREATED, REPO_EVENT_TYPES.STAR_DELETED] as const;
const ISSUE_EVENT_TYPES = [
  REPO_EVENT_TYPES.ISSUE_OPENED,
  REPO_EVENT_TYPES.ISSUE_CLOSED,
  REPO_EVENT_TYPES.ISSUE_REOPENED,
] as const;
const PULL_REQUEST_EVENT_TYPES = [
  REPO_EVENT_TYPES.PULL_REQUEST_OPENED,
  REPO_EVENT_TYPES.PULL_REQUEST_CLOSED,
  REPO_EVENT_TYPES.PULL_REQUEST_MERGED,
  REPO_EVENT_TYPES.PULL_REQUEST_REOPENED,
] as const;
const FORK_EVENT_TYPES = [REPO_EVENT_TYPES.FORK_CREATED] as const;

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
export type StarEvent = RepoEventOf<(typeof STAR_EVENT_TYPES)[number]>;
export type IssueEvent = RepoEventOf<(typeof ISSUE_EVENT_TYPES)[number]>;
export type PullRequestEvent = RepoEventOf<(typeof PULL_REQUEST_EVENT_TYPES)[number]>;
export type ForkEvent = RepoEventOf<(typeof FORK_EVENT_TYPES)[number]>;
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
