import type { RepoEventInput, RepoEventOf, StarEvent } from '../../../core/models/repo-event.js';
import {
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
  createRepoEvent,
} from '../../../core/models/repo-event.js';
import type { GitHubRepository, GitHubUser } from '../types.js';
import { mapRepository, mapUser } from './repository.js';

function createStarEvent<TType extends StarEvent['type']>(
  type: TType,
  action: RepoEventOf<TType>['action'],
  repository: GitHubRepository,
  sender: GitHubUser
): RepoEventOf<TType> {
  return createRepoEvent(type, {
    action,
    repository: mapRepository(repository),
    sender: mapUser(sender),
    star: {
      count: repository.stargazers_count,
    },
  } as RepoEventInput<TType>);
}

export function mapStarCreated(
  repository: GitHubRepository,
  sender: GitHubUser
): RepoEventOf<typeof REPO_EVENT_TYPES.STAR_CREATED> {
  return createStarEvent(
    REPO_EVENT_TYPES.STAR_CREATED,
    REPO_EVENT_ACTIONS.CREATED,
    repository,
    sender
  );
}

export function mapStarDeleted(
  repository: GitHubRepository,
  sender: GitHubUser
): RepoEventOf<typeof REPO_EVENT_TYPES.STAR_DELETED> {
  return createStarEvent(
    REPO_EVENT_TYPES.STAR_DELETED,
    REPO_EVENT_ACTIONS.DELETED,
    repository,
    sender
  );
}
