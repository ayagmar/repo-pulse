import type {
  Issue,
  IssueEvent,
  RepoEventInput,
  RepoEventOf,
} from '../../../core/models/repo-event.js';
import {
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
  createRepoEvent,
} from '../../../core/models/repo-event.js';
import type { GitHubIssue, GitHubRepository, GitHubUser } from '../types.js';
import { mapRepository, mapUser } from './repository.js';
import {
  requireNullableString,
  requireNumber,
  requireObject,
  requireState,
  requireString,
  requireStringArrayFromObjects,
} from './validation.js';

function mapIssue(issue: GitHubIssue): Issue {
  const issueData = requireObject(issue, 'issue');

  return {
    number: requireNumber(issueData.number, 'issue.number'),
    title: requireString(issueData.title, 'issue.title'),
    url: requireString(issueData.html_url, 'issue.html_url'),
    state: requireState(issueData.state, 'issue.state'),
    body: requireNullableString(issueData.body, 'issue.body'),
    labels: requireStringArrayFromObjects(issueData.labels, 'issue.labels', 'name'),
  };
}

function createIssueEvent<TType extends IssueEvent['type']>(
  type: TType,
  action: RepoEventOf<TType>['action'],
  repository: GitHubRepository,
  sender: GitHubUser,
  issue: GitHubIssue
): RepoEventOf<TType> {
  return createRepoEvent(type, {
    action,
    repository: mapRepository(repository),
    sender: mapUser(sender),
    issue: mapIssue(issue),
  } as RepoEventInput<TType>);
}

export function mapIssueOpened(
  repository: GitHubRepository,
  sender: GitHubUser,
  issue: GitHubIssue
): RepoEventOf<typeof REPO_EVENT_TYPES.ISSUE_OPENED> {
  return createIssueEvent(
    REPO_EVENT_TYPES.ISSUE_OPENED,
    REPO_EVENT_ACTIONS.OPENED,
    repository,
    sender,
    issue
  );
}

export function mapIssueClosed(
  repository: GitHubRepository,
  sender: GitHubUser,
  issue: GitHubIssue
): RepoEventOf<typeof REPO_EVENT_TYPES.ISSUE_CLOSED> {
  return createIssueEvent(
    REPO_EVENT_TYPES.ISSUE_CLOSED,
    REPO_EVENT_ACTIONS.CLOSED,
    repository,
    sender,
    issue
  );
}

export function mapIssueReopened(
  repository: GitHubRepository,
  sender: GitHubUser,
  issue: GitHubIssue
): RepoEventOf<typeof REPO_EVENT_TYPES.ISSUE_REOPENED> {
  return createIssueEvent(
    REPO_EVENT_TYPES.ISSUE_REOPENED,
    REPO_EVENT_ACTIONS.REOPENED,
    repository,
    sender,
    issue
  );
}
