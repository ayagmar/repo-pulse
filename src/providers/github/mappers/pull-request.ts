import type {
  PullRequest,
  PullRequestEvent,
  RepoEventInput,
  RepoEventOf,
} from '../../../core/models/repo-event.js';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
} from '../../../core/models/repo-event.js';
import type { GitHubPullRequest, GitHubRepository, GitHubUser } from '../types.js';
import { mapRepository, mapUser } from './repository.js';
import {
  optionalAssociation,
  optionalCount,
  optionalString,
  optionalTimestamp,
  requireBoolean,
  requireNullableString,
  requireNumber,
  requireObject,
  requireState,
  requireString,
} from './validation.js';

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function mapPullRequest(pr: GitHubPullRequest, merged: unknown): PullRequest {
  const pullRequestData = requireObject(pr, 'pull_request');
  const head = requireObject(pullRequestData.head, 'pull_request.head');
  const base = requireObject(pullRequestData.base, 'pull_request.base');
  const pullRequest: PullRequest = {
    number: requireNumber(pullRequestData.number, 'pull_request.number'),
    title: requireString(pullRequestData.title, 'pull_request.title'),
    url: requireString(pullRequestData.html_url, 'pull_request.html_url'),
    state: requireState(pullRequestData.state, 'pull_request.state'),
    merged: requireBoolean(merged, 'pull_request.merged'),
    body: requireNullableString(pullRequestData.body, 'pull_request.body'),
    draft: requireBoolean(pullRequestData.draft, 'pull_request.draft'),
    headBranch: requireString(head.ref, 'pull_request.head.ref'),
    baseBranch: requireString(base.ref, 'pull_request.base.ref'),
  };

  const createdAt = optionalTimestamp(pullRequestData.created_at);
  if (createdAt !== undefined) {
    pullRequest.createdAt = createdAt;
  }
  const author = optionalString(optionalObject(pullRequestData.user)?.login);
  const authorAssociation = optionalAssociation(pullRequestData.author_association);
  const commits = optionalCount(pullRequestData.commits);
  if (author !== undefined) {
    pullRequest.author = author;
  }
  if (authorAssociation !== undefined) {
    pullRequest.authorAssociation = authorAssociation;
  }
  if (commits !== undefined) {
    pullRequest.commits = commits;
  }
  if (pullRequestData.additions !== undefined) {
    pullRequest.additions = requireNumber(pullRequestData.additions, 'pull_request.additions');
  }
  if (pullRequestData.deletions !== undefined) {
    pullRequest.deletions = requireNumber(pullRequestData.deletions, 'pull_request.deletions');
  }
  if (pullRequestData.changed_files !== undefined) {
    pullRequest.changedFiles = requireNumber(
      pullRequestData.changed_files,
      'pull_request.changed_files'
    );
  }

  return pullRequest;
}

/** The pull request's field holding when this action happened on GitHub. */
type ActionTimeField = 'created_at' | 'closed_at' | 'merged_at' | 'updated_at';

function createPullRequestEvent<TType extends PullRequestEvent['type']>(
  type: TType,
  action: RepoEventOf<TType>['action'],
  repository: GitHubRepository,
  sender: GitHubUser,
  pr: GitHubPullRequest,
  actionTime: ActionTimeField,
  merged: unknown = pr.merged
): RepoEventOf<TType> {
  const pullRequest = mapPullRequest(pr, merged);
  const occurredAt = optionalTimestamp(pr[actionTime]);
  return createRepoEvent(type, {
    action,
    repository: mapRepository(repository),
    sender: mapUser(sender),
    pullRequest,
    ...(occurredAt !== undefined ? { occurredAt } : {}),
  } as RepoEventInput<TType>);
}

export function mapPullRequestOpened(
  repository: GitHubRepository,
  sender: GitHubUser,
  pr: GitHubPullRequest
): RepoEventOf<typeof REPO_EVENT_TYPES.PULL_REQUEST_OPENED> {
  return createPullRequestEvent(
    REPO_EVENT_TYPES.PULL_REQUEST_OPENED,
    REPO_EVENT_ACTIONS.OPENED,
    repository,
    sender,
    pr,
    'created_at'
  );
}

export function mapPullRequestClosed(
  repository: GitHubRepository,
  sender: GitHubUser,
  pr: GitHubPullRequest
): RepoEventOf<typeof REPO_EVENT_TYPES.PULL_REQUEST_CLOSED> {
  return createPullRequestEvent(
    REPO_EVENT_TYPES.PULL_REQUEST_CLOSED,
    REPO_EVENT_ACTIONS.CLOSED,
    repository,
    sender,
    pr,
    'closed_at'
  );
}

export function mapPullRequestMerged(
  repository: GitHubRepository,
  sender: GitHubUser,
  pr: GitHubPullRequest
): RepoEventOf<typeof REPO_EVENT_TYPES.PULL_REQUEST_MERGED> {
  return createPullRequestEvent(
    REPO_EVENT_TYPES.PULL_REQUEST_MERGED,
    REPO_EVENT_ACTIONS.CLOSED,
    repository,
    sender,
    pr,
    'merged_at',
    true
  );
}

export function mapPullRequestReopened(
  repository: GitHubRepository,
  sender: GitHubUser,
  pr: GitHubPullRequest
): RepoEventOf<typeof REPO_EVENT_TYPES.PULL_REQUEST_REOPENED> {
  return createPullRequestEvent(
    REPO_EVENT_TYPES.PULL_REQUEST_REOPENED,
    REPO_EVENT_ACTIONS.REOPENED,
    repository,
    sender,
    pr,
    // GitHub has no time for a reopen or a draft change; it is the latest update.
    'updated_at'
  );
}

/** Stored for the waiting list's draft state only; never alerted. */
export function mapPullRequestReadyForReview(
  repository: GitHubRepository,
  sender: GitHubUser,
  pr: GitHubPullRequest
): RepoEventOf<typeof REPO_EVENT_TYPES.PULL_REQUEST_READY_FOR_REVIEW> {
  return createPullRequestEvent(
    REPO_EVENT_TYPES.PULL_REQUEST_READY_FOR_REVIEW,
    REPO_EVENT_ACTIONS.READY_FOR_REVIEW,
    repository,
    sender,
    pr,
    'updated_at'
  );
}

/** Stored for the waiting list's draft state only; never alerted. */
export function mapPullRequestConvertedToDraft(
  repository: GitHubRepository,
  sender: GitHubUser,
  pr: GitHubPullRequest
): RepoEventOf<typeof REPO_EVENT_TYPES.PULL_REQUEST_CONVERTED_TO_DRAFT> {
  return createPullRequestEvent(
    REPO_EVENT_TYPES.PULL_REQUEST_CONVERTED_TO_DRAFT,
    REPO_EVENT_ACTIONS.CONVERTED_TO_DRAFT,
    repository,
    sender,
    pr,
    'updated_at'
  );
}
