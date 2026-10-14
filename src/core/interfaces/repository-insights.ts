import type { UnreleasedWork } from '../models/digest.js';
import type { Referrer } from '../models/momentum-alert.js';

/** A GitHub user's public profile, as far as alerts need it. */
export interface UserProfile {
  login: string;
  url: string;
  followers: number;
}

/**
 * Reads what webhooks do not carry, such as how far a repository has moved since
 * its latest release.
 */
export interface RepositoryInsights {
  /** The given repositories, by full name, that have commits since their latest release. */
  listUnreleasedWork(repositories: readonly string[]): Promise<UnreleasedWork[]>;

  /** Profiles of the given users. Users GitHub cannot find are left out. */
  getUserProfiles(logins: readonly string[]): Promise<UserProfile[]>;

  /** The sites that sent the most visitors in the last 14 days, most views first. */
  listTopReferrers(repository: string): Promise<Referrer[]>;
}
