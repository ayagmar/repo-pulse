import type {
  Issue,
  IssueEvent,
  RepoEventInput,
  RepoEventOf,
} from '../../../core/models/repo-event.js';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
} from '../../../core/models/repo-event.js';
import type { GitHubIssue, GitHubRepository, GitHubUser } from '../types.js';
import { mapRepository, mapUser } from './repository.js';
import {
  optionalAssociation,
  optionalTimestamp,
  requireNullableString,
  requireNumber,
  requireObject,
  requireState,
  requireString,
  requireStringArrayFromObjects,
} from './validation.js';

function mapIssue(issue: GitHubIssue): Issue {
  const issueData = requireObject(issue, 'issue');
  const createdAt = optionalTimestamp(issueData.created_at);
  const stateReason =
    issueData.state_reason === 'completed' || issueData.state_reason === 'not_planned'
      ? issueData.state_reason
      : undefined;
  const authorAssociation = optionalAssociation(issueData.author_association);

  return {
    number: requireNumber(issueData.number, 'issue.number'),
    title: requireString(issueData.title, 'issue.title'),
    url: requireString(issueData.html_url, 'issue.html_url'),
    state: requireState(issueData.state, 'issue.state'),
    body: requireNullableString(issueData.body, 'issue.body'),
    labels: requireStringArrayFromObjects(issueData.labels, 'issue.labels', 'name'),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(stateReason !== undefined ? { stateReason } : {}),
    ...(authorAssociation !== undefined ? { authorAssociation } : {}),
  };
}

/** The issue's field holding when this action happened on GitHub. */
type ActionTimeField = 'created_at' | 'closed_at' | 'updated_at';

function createIssueEvent<TType extends IssueEvent['type']>(
  type: TType,
  action: RepoEventOf<TType>['action'],
  repository: GitHubRepository,
  sender: GitHubUser,
  issue: GitHubIssue,
  actionTime: ActionTimeField
): RepoEventOf<TType> {
  const mapped = mapIssue(issue);
  const occurredAt = optionalTimestamp(issue[actionTime]);
  return createRepoEvent(type, {
    action,
    repository: mapRepository(repository),
    sender: mapUser(sender),
    issue: mapped,
    ...(occurredAt !== undefined ? { occurredAt } : {}),
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
    issue,
    'created_at'
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
    issue,
    'closed_at'
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
    issue,
    // GitHub has no reopen time; the reopen is the issue's latest update.
    'updated_at'
  );
}
