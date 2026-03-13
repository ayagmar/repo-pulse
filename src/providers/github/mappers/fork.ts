import type { ForkEvent } from '../../../core/models/repo-event.js';
import {
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
  createRepoEvent,
} from '../../../core/models/repo-event.js';
import type { GitHubFork, GitHubRepository, GitHubUser } from '../types.js';
import { mapRepository, mapUser } from './repository.js';
import { requireObject, requireString } from './validation.js';

function mapFork(fork: GitHubFork) {
  const forkData = requireObject(fork, 'forkee');

  return {
    fullName: requireString(forkData.full_name, 'forkee.full_name'),
    url: requireString(forkData.html_url, 'forkee.html_url'),
    defaultBranch: requireString(forkData.default_branch, 'forkee.default_branch'),
  };
}

export function mapForkCreated(
  repository: GitHubRepository,
  sender: GitHubUser,
  fork: GitHubFork
): ForkEvent {
  return createRepoEvent(REPO_EVENT_TYPES.FORK_CREATED, {
    action: REPO_EVENT_ACTIONS.CREATED,
    repository: mapRepository(repository),
    sender: mapUser(sender),
    fork: mapFork(fork),
  });
}
