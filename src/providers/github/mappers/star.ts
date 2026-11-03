import type { RepoEventInput, RepoEventOf, StarEvent } from '../../../core/models/repo-event.js';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
} from '../../../core/models/repo-event.js';
import type { GitHubRepository, GitHubUser } from '../types.js';
import { mapRepository, mapUser } from './repository.js';
import { optionalTimestamp } from './validation.js';

function createStarEvent<TType extends StarEvent['type']>(
  type: TType,
  action: RepoEventOf<TType>['action'],
  repository: GitHubRepository,
  sender: GitHubUser,
  starredAt: unknown
): RepoEventOf<TType> {
  const createdAt = optionalTimestamp(repository.created_at);
  const occurredAt = optionalTimestamp(starredAt);
  return createRepoEvent(type, {
    action,
    repository: {
      ...mapRepository(repository),
      ...(createdAt !== undefined ? { createdAt } : {}),
    },
    sender: mapUser(sender),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    star: {
      count: repository.stargazers_count,
    },
  } as RepoEventInput<TType>);
}

export function mapStarCreated(
  repository: GitHubRepository,
  sender: GitHubUser,
  starredAt: unknown
): RepoEventOf<typeof REPO_EVENT_TYPES.STAR_CREATED> {
  return createStarEvent(
    REPO_EVENT_TYPES.STAR_CREATED,
    REPO_EVENT_ACTIONS.CREATED,
    repository,
    sender,
    starredAt
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
    sender,
    null
  );
}
