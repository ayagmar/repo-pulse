import { APP_ERROR_CODES, AppError } from '../../core/errors/app-error.js';
import type { RepoEvent } from '../../core/models/repo-event.js';
import {
  mapCommentCreated,
  mapForkCreated,
  mapIssueClosed,
  mapIssueOpened,
  mapIssueReopened,
  mapPullRequestClosed,
  mapPullRequestConvertedToDraft,
  mapPullRequestMerged,
  mapPullRequestOpened,
  mapPullRequestReadyForReview,
  mapPullRequestReopened,
  mapPush,
  mapReleasePublished,
  mapReviewSubmitted,
  mapStarCreated,
  mapStarDeleted,
} from './mappers/index.js';
import { requireBoolean } from './mappers/validation.js';
import type { GitHubWebhookPayload } from './types.js';

export class EventMappingError extends AppError {
  constructor(message: string) {
    super(400, APP_ERROR_CODES.INVALID_EVENT_PAYLOAD, message);
    this.name = 'EventMappingError';
  }
}

/**
 * Map GitHub webhook payload to internal RepoEvent.
 * @returns RepoEvent, or null if the event is unsupported or filtered out
 * @throws EventMappingError if payload is invalid
 */
export function mapGitHubEvent(
  eventType: string,
  payload: Partial<GitHubWebhookPayload>
): RepoEvent | null {
  if (!(payload.repository && payload.sender)) {
    throw new EventMappingError('Missing required fields: repository or sender');
  }

  const { repository, sender, action } = payload;
  try {
    switch (eventType) {
      case 'star': {
        if (action === 'created') {
          return mapStarCreated(repository, sender, payload.starred_at);
        }
        if (action === 'deleted') {
          return mapStarDeleted(repository, sender);
        }
        return null;
      }

      case 'issues': {
        if (!payload.issue) {
          throw new EventMappingError('Missing issue data');
        }
        switch (action) {
          case 'opened':
            return mapIssueOpened(repository, sender, payload.issue);
          case 'closed':
            return mapIssueClosed(repository, sender, payload.issue);
          case 'reopened':
            return mapIssueReopened(repository, sender, payload.issue);
          default:
            return null;
        }
      }

      case 'pull_request': {
        if (!payload.pull_request) {
          throw new EventMappingError('Missing pull request data');
        }
        const pr = payload.pull_request;
        switch (action) {
          case 'opened':
            return mapPullRequestOpened(repository, sender, pr);
          case 'closed':
            return requireBoolean(pr.merged, 'pull_request.merged')
              ? mapPullRequestMerged(repository, sender, pr)
              : mapPullRequestClosed(repository, sender, pr);
          case 'reopened':
            return mapPullRequestReopened(repository, sender, pr);
          case 'ready_for_review':
            return mapPullRequestReadyForReview(repository, sender, pr);
          case 'converted_to_draft':
            return mapPullRequestConvertedToDraft(repository, sender, pr);
          default:
            return null;
        }
      }

      case 'issue_comment': {
        if (action !== 'created') {
          return null;
        }
        if (!(payload.issue && payload.comment)) {
          throw new EventMappingError('Missing issue or comment data');
        }
        return mapCommentCreated(repository, sender, payload.issue, payload.comment);
      }

      case 'pull_request_review': {
        if (action !== 'submitted') {
          return null;
        }
        if (!(payload.pull_request && payload.review)) {
          throw new EventMappingError('Missing pull request or review data');
        }
        return mapReviewSubmitted(repository, sender, payload.pull_request, payload.review);
      }

      case 'fork': {
        if (!payload.forkee) {
          throw new EventMappingError('Missing fork data');
        }
        return mapForkCreated(repository, sender, payload.forkee);
      }

      case 'push':
        return mapPush(repository, sender, payload);

      case 'release': {
        // `published` covers releases and pre-releases; `released`/`prereleased`
        // would announce the same release twice.
        if (action !== 'published') {
          return null;
        }
        if (!payload.release) {
          throw new EventMappingError('Missing release data');
        }
        return mapReleasePublished(repository, sender, payload.release);
      }

      default:
        return null;
    }
  } catch (error) {
    if (error instanceof EventMappingError) {
      throw error;
    }

    throw new EventMappingError(error instanceof Error ? error.message : 'Invalid GitHub payload');
  }
}
