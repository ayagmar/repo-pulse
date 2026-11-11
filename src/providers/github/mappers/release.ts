import type { ReleaseEvent } from '../../../core/models/repo-event.js';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
} from '../../../core/models/repo-event.js';
import type { GitHubRelease, GitHubRepository, GitHubUser } from '../types.js';
import { mapRepository, mapUser } from './repository.js';
import {
  optionalCount,
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
  const name = requireNullableString(releaseData.name, 'release.name');

  const assets = Array.isArray(releaseData.assets) ? (releaseData.assets as unknown[]) : [];
  const assetBytes = assets.reduce<number>((total, asset) => {
    const size = optionalCount((asset as { size?: unknown } | null)?.size);
    return total + (size ?? 0);
  }, 0);

  return createRepoEvent(REPO_EVENT_TYPES.RELEASE_PUBLISHED, {
    action: REPO_EVENT_ACTIONS.PUBLISHED,
    repository: mapRepository(repository),
    sender: mapUser(sender),
    release: {
      tagName: requireString(releaseData.tag_name, 'release.tag_name'),
      name,
      url: requireString(releaseData.html_url, 'release.html_url'),
      body: requireNullableString(releaseData.body, 'release.body'),
      prerelease: requireBoolean(releaseData.prerelease, 'release.prerelease'),
      ...(assets.length > 0 ? { assetCount: assets.length, assetBytes } : {}),
    },
  });
}
