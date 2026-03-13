import { APP_ERROR_CODES, AppError } from '../../core/errors/app-error.js';
import type { RepoEvent } from '../../core/models/repo-event.js';
import {
  mapForkCreated,
  mapIssueClosed,
  mapIssueOpened,
  mapIssueReopened,
  mapPullRequestClosed,
  mapPullRequestMerged,
  mapPullRequestOpened,
  mapPullRequestReopened,
  mapStarCreated,
  mapStarDeleted,
} from './mappers/index.js';
import type { GitHubWebhookPayload } from './types.js';

export class EventMappingError extends AppError {
  constructor(message: string) {
    super(400, APP_ERROR_CODES.INVALID_EVENT_PAYLOAD, message);
    this.name = 'EventMappingError';
  }
}

/**
 * Map GitHub webhook payload to internal RepoEvent.
 * @returns RepoEvent or null if event type is not supported
 * @throws EventMappingError if payload is invalid
 */
export function mapGitHubEvent(eventType: string, payload: GitHubWebhookPayload): RepoEvent | null {
  if (!(payload.repository && payload.sender)) {
    throw new EventMappingError('Missing required fields: repository or sender');
  }

  const { repository, sender, action } = payload;
  try {
    switch (eventType) {
      case 'star': {
        if (action === 'created') {
          return mapStarCreated(repository, sender);
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
            return pr.merged
              ? mapPullRequestMerged(repository, sender, pr)
              : mapPullRequestClosed(repository, sender, pr);
          case 'reopened':
            return mapPullRequestReopened(repository, sender, pr);
          default:
            return null;
        }
      }

      case 'fork': {
        if (!payload.forkee) {
          throw new EventMappingError('Missing fork data');
        }
        return mapForkCreated(repository, sender, payload.forkee);
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
