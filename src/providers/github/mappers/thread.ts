import type { CommentEvent, ReviewEvent, Thread } from '../../../core/models/repo-event.js';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
} from '../../../core/models/repo-event.js';
import type { GitHubRepository, GitHubUser } from '../types.js';
import { mapRepository, mapUser } from './repository.js';
import {
  optionalText,
  optionalTimestamp,
  requireNumber,
  requireObject,
  requireState,
  requireString,
} from './validation.js';

/**
 * The issue or pull request under a comment or review. A comment on a pull request
 * arrives with the pull request as an issue, marked by `issue.pull_request`, without
 * the pull request's branches or merge state, and with its draft state only sometimes.
 */
function mapThread(value: unknown, field: string, kind: Thread['kind'] | null): Thread {
  const data = requireObject(value, field);
  const threadKind =
    kind ??
    (typeof data.pull_request === 'object' && data.pull_request !== null
      ? 'pull_request'
      : 'issue');
  const createdAt = optionalTimestamp(data.created_at);

  return {
    kind: threadKind,
    number: requireNumber(data.number, `${field}.number`),
    title: requireString(data.title, `${field}.title`),
    url: requireString(data.html_url, `${field}.html_url`),
    state: requireState(data.state, `${field}.state`),
    draft: threadKind === 'pull_request' && typeof data.draft === 'boolean' ? data.draft : null,
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

/** `issue_comment.created`, on an issue or a pull request's conversation. */
export function mapCommentCreated(
  repository: GitHubRepository,
  sender: GitHubUser,
  issue: unknown,
  comment: unknown
): CommentEvent {
  const commentData = requireObject(comment, 'comment');
  const occurredAt = optionalTimestamp(commentData.created_at);

  return createRepoEvent(REPO_EVENT_TYPES.COMMENT_CREATED, {
    action: REPO_EVENT_ACTIONS.CREATED,
    repository: mapRepository(repository),
    sender: mapUser(sender),
    thread: mapThread(issue, 'issue', null),
    comment: {
      id: requireNumber(commentData.id, 'comment.id'),
      url: requireString(commentData.html_url, 'comment.html_url'),
      body: optionalText(commentData.body, 'comment.body'),
    },
    ...(occurredAt !== undefined ? { occurredAt } : {}),
  });
}

/** `pull_request_review.submitted`. Its time is `submitted_at`, which can be null. */
export function mapReviewSubmitted(
  repository: GitHubRepository,
  sender: GitHubUser,
  pullRequest: unknown,
  review: unknown
): ReviewEvent {
  const reviewData = requireObject(review, 'review');
  const occurredAt = optionalTimestamp(reviewData.submitted_at);

  return createRepoEvent(REPO_EVENT_TYPES.REVIEW_SUBMITTED, {
    action: REPO_EVENT_ACTIONS.SUBMITTED,
    repository: mapRepository(repository),
    sender: mapUser(sender),
    thread: mapThread(pullRequest, 'pull_request', 'pull_request'),
    review: {
      id: requireNumber(reviewData.id, 'review.id'),
      url: requireString(reviewData.html_url, 'review.html_url'),
      body: optionalText(reviewData.body, 'review.body'),
      state: requireString(reviewData.state, 'review.state').toLowerCase(),
    },
    ...(occurredAt !== undefined ? { occurredAt } : {}),
  });
}
