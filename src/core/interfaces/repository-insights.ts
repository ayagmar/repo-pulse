import type { UnreleasedWork } from '../models/digest.js';

/**
 * Reads what webhooks do not carry, such as how far a repository has moved since
 * its latest release.
 */
export interface RepositoryInsights {
  /** The given repositories, by full name, that have commits since their latest release. */
  listUnreleasedWork(repositories: readonly string[]): Promise<UnreleasedWork[]>;
}
