/**
 * Internal domain model for repository events.
 * Normalized representation of inbound repository activity.
 */

import type { StarMilestone } from './star-milestone.js';

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
  /** GitHub's `created_at`, ISO 8601. Recorded on star events only, when the payload has it. */
  createdAt?: string;
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
  /** GitHub's `created_at`, ISO 8601. Absent on events stored before it was recorded. */
  createdAt?: string;
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
  /** GitHub's `created_at`, ISO 8601. Absent on events stored before it was recorded. */
  createdAt?: string;
}

/**
 * The issue or pull request a comment or review belongs to, as the payload saw it.
 * Issues and pull requests share one number sequence per repository.
 */
export interface Thread {
  kind: 'issue' | 'pull_request';
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  /** Pull requests only, and null when the payload does not say. Always null for issues. */
  draft: boolean | null;
  /** GitHub's `created_at` of the issue or pull request, ISO 8601, when the payload has it. */
  createdAt?: string;
}

interface Comment {
  id: number;
  url: string;
  /** Null when empty or only whitespace. */
  body: string | null;
}

/** The review states GitHub sends on `pull_request_review.submitted`. */
export const REVIEW_STATES = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
} as const;

interface Review {
  id: number;
  url: string;
  /** Null when empty or only whitespace. */
  body: string | null;
  /** Lowercase. A state outside `REVIEW_STATES` is stored as sent and never alerted. */
  state: string;
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
  SUBMITTED: 'submitted',
  READY_FOR_REVIEW: 'ready_for_review',
  CONVERTED_TO_DRAFT: 'converted_to_draft',
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
  PULL_REQUEST_READY_FOR_REVIEW: 'pull_request.ready_for_review',
  PULL_REQUEST_CONVERTED_TO_DRAFT: 'pull_request.converted_to_draft',
  COMMENT_CREATED: 'comment.created',
  REVIEW_SUBMITTED: 'review.submitted',
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
    /**
     * The milestone this star was the first to be seen past, decided at acceptance.
     * Absent for every other star, and for stars stored before milestones were.
     */
    starMilestone?: StarMilestone;
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
  [REPO_EVENT_TYPES.PULL_REQUEST_READY_FOR_REVIEW]: {
    action: typeof REPO_EVENT_ACTIONS.READY_FOR_REVIEW;
    pullRequest: PullRequest;
  };
  [REPO_EVENT_TYPES.PULL_REQUEST_CONVERTED_TO_DRAFT]: {
    action: typeof REPO_EVENT_ACTIONS.CONVERTED_TO_DRAFT;
    pullRequest: PullRequest;
  };
  [REPO_EVENT_TYPES.COMMENT_CREATED]: {
    action: typeof REPO_EVENT_ACTIONS.CREATED;
    thread: Thread;
    comment: Comment;
  };
  [REPO_EVENT_TYPES.REVIEW_SUBMITTED]: {
    action: typeof REPO_EVENT_ACTIONS.SUBMITTED;
    thread: Thread;
    review: Review;
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

/** What was recorded from the sender, across all repositories, before this event. */
export interface SenderHistory {
  /** ISO time of the sender's earliest recorded event, or null when there is none. */
  firstSeenAt: string | null;
  priorEvents: number;
  priorRepositories: number;
  priorInRepository: number;
}

interface BaseRepoEvent<TType extends RepoEventType, TAction extends string> {
  type: TType;
  action: TAction;
  repository: Repository;
  sender: User;
  /** When the event was accepted: receipt time, not GitHub's. */
  timestamp: Date;
  /**
   * When it happened on GitHub, ISO 8601, for star, issue, pull request, comment and
   * review events whose payload has a valid time for it. Absent on events stored before it was
   * recorded and when the payload has none.
   */
  occurredAt?: string;
  /**
   * False when the event was accepted for history only, decided once at acceptance:
   * it is stored and never queued for an alert, redelivered or not. Absent means it
   * alerts, as every event stored before this field did.
   */
  alert?: false;
  /**
   * Set when the event was accepted, for outside people only. Absent for the owner,
   * ignored logins and bots, for events stored before it existed, and when it could
   * not be read.
   */
  senderHistory?: SenderHistory;
}

export type RepoEvent = {
  [Type in RepoEventType]: BaseRepoEvent<Type, RepoEventPayloadMap[Type]['action']> &
    Omit<RepoEventPayloadMap[Type], 'action'>;
}[RepoEventType];

export type RepoEventOf<TType extends RepoEventType> = Extract<RepoEvent, { type: TType }>;
export type StarEvent = RepoEventOf<'star.created' | 'star.deleted'>;
export type IssueEvent = RepoEventOf<'issue.opened' | 'issue.closed' | 'issue.reopened'>;
export type PullRequestEvent = RepoEventOf<
  | 'pull_request.opened'
  | 'pull_request.closed'
  | 'pull_request.merged'
  | 'pull_request.reopened'
  | 'pull_request.ready_for_review'
  | 'pull_request.converted_to_draft'
>;
export type CommentEvent = RepoEventOf<'comment.created'>;
export type ReviewEvent = RepoEventOf<'review.submitted'>;
export type ForkEvent = RepoEventOf<'fork.created'>;
export type PushEvent = RepoEventOf<'push.default_branch'>;
export type ReleaseEvent = RepoEventOf<'release.published'>;
export type RepoEventInput<TType extends RepoEventType> = Omit<
  RepoEventOf<TType>,
  'timestamp' | 'type'
>;

export function serializeRepoEvent(event: RepoEvent): string {
  return JSON.stringify({
    ...event,
    timestamp: event.timestamp.toISOString(),
  });
}

export function deserializeRepoEvent(value: string): RepoEvent {
  const parsed = JSON.parse(value) as RepoEvent & { timestamp: string };
  return {
    ...parsed,
    timestamp: new Date(parsed.timestamp),
  };
}

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
