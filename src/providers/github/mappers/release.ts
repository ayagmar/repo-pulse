import type { ReleaseEvent } from '../../../core/models/repo-event.js';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
} from '../../../core/models/repo-event.js';
import type { GitHubRelease, GitHubRepository, GitHubUser } from '../types.js';
import { mapRepository, mapUser } from './repository.js';
import {
  requireBoolean,
  requireNullableString,
  requireObject,
  requireString,
} from './validation.js';

export function mapReleasePublished(
  repository: GitHubRepository,
  sender: GitHubUser,
  release: GitHubRelease
): ReleaseEvent {
  const releaseData = requireObject(release, 'release');
  const name = requireNullableString(
    releaseData.name === '' ? null : releaseData.name,
    'release.name'
  );

  return createRepoEvent(REPO_EVENT_TYPES.RELEASE_PUBLISHED, {
    action: REPO_EVENT_ACTIONS.PUBLISHED,
    repository: mapRepository(repository),
    sender: mapUser(sender),
    release: {
      tagName: requireString(releaseData.tag_name, 'release.tag_name'),
      name,
      url: requireString(releaseData.html_url, 'release.html_url'),
      body: requireNullableString(
        releaseData.body === '' ? null : releaseData.body,
        'release.body'
      ),
      prerelease: requireBoolean(releaseData.prerelease, 'release.prerelease'),
    },
  });
}
