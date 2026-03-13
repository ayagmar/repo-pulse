import type {
  PullRequest,
  PullRequestEvent,
  RepoEventInput,
  RepoEventOf,
} from '../../../core/models/repo-event.js';
import {
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
  createRepoEvent,
} from '../../../core/models/repo-event.js';
import type { GitHubPullRequest, GitHubRepository, GitHubUser } from '../types.js';
import { mapRepository, mapUser } from './repository.js';
import {
  requireBoolean,
  requireNullableString,
  requireNumber,
  requireObject,
  requireState,
  requireString,
} from './validation.js';

function mapPullRequest(pr: GitHubPullRequest, merged = pr.merged): PullRequest {
  const pullRequestData = requireObject(pr, 'pull_request');
  const head = requireObject(pullRequestData.head, 'pull_request.head');
  const base = requireObject(pullRequestData.base, 'pull_request.base');
  const pullRequest: PullRequest = {
    number: requireNumber(pullRequestData.number, 'pull_request.number'),
    title: requireString(pullRequestData.title, 'pull_request.title'),
    url: requireString(pullRequestData.html_url, 'pull_request.html_url'),
    state: requireState(pullRequestData.state, 'pull_request.state'),
    merged,
    body: requireNullableString(pullRequestData.body, 'pull_request.body'),
    draft: requireBoolean(pullRequestData.draft, 'pull_request.draft'),
    headBranch: requireString(head.ref, 'pull_request.head.ref'),
    baseBranch: requireString(base.ref, 'pull_request.base.ref'),
  };

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

function createPullRequestEvent<TType extends PullRequestEvent['type']>(
  type: TType,
  action: RepoEventOf<TType>['action'],
  repository: GitHubRepository,
  sender: GitHubUser,
  pr: GitHubPullRequest,
  merged = pr.merged
): RepoEventOf<TType> {
  return createRepoEvent(type, {
    action,
    repository: mapRepository(repository),
    sender: mapUser(sender),
    pullRequest: mapPullRequest(pr, merged),
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
    pr
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
    pr
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
    pr
  );
}
