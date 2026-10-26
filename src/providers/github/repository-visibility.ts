import { logger } from '../../core/services/logger.js';

const API_URL = 'https://api.github.com';
/** A visibility answer, admitted or not, is used for at most this long. */
const VISIBILITY_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 3_000;
/** GitHub's own limits on owner and repository names, as the feed contract states them. */
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

interface CachedVisibility {
  isPublic: boolean;
  /** Counted from when the lookup was sent, so an answer never outlives its TTL. */
  expiresAt: number;
}

/**
 * Admits a repository to a public response only while GitHub says it is public.
 * It asks GitHub without a token, or with a token that can read public
 * repositories only, so a private repository answers `404` whatever the token
 * owner can see. Only a `200` with `"private": false` admits; every other
 * answer, or no answer, counts as private. Recorded webhook events never admit
 * a repository.
 */
export class RepositoryVisibilityGate {
  // Plain values only: a Worker request must not await a promise another request
  // created, so concurrent requests each look up what is not cached.
  private readonly cache = new Map<string, CachedVisibility>();

  /**
   * The given repositories GitHub currently shows as public. Those without a fresh
   * answer are looked up, at most `lookupBudget` of them; the rest are left out.
   * The answers are read once every lookup has settled, so one that expired while
   * the others were pending does not admit its repository, and a repository needs
   * both this request's own answer and the cached one to say public. Build the
   * response without waiting on anything else after this resolves.
   */
  async admit(
    repositories: readonly string[],
    lookupBudget: number,
    publicToken: string | undefined
  ): Promise<Set<string>> {
    const candidates = [...new Set(repositories)].filter((repository) =>
      REPOSITORY_NAME_PATTERN.test(repository)
    );
    const unanswered = candidates.filter(
      (repository) => this.freshAnswer(repository) === undefined
    );
    const ownAnswers = new Map(
      await Promise.all(
        unanswered
          .slice(0, lookupBudget)
          .map(
            async (repository) => [repository, await this.lookUp(repository, publicToken)] as const
          )
      )
    );
    const skipped = unanswered.length - lookupBudget;
    if (skipped > 0) {
      logger.warn('visibility.lookup_budget_exhausted', { component: 'github', omitted: skipped });
    }
    return new Set(
      candidates.filter(
        (repository) =>
          ownAnswers.get(repository) !== false && this.freshAnswer(repository) === true
      )
    );
  }

  /** The cached answer for a repository, or undefined once it is 60 seconds old. */
  private freshAnswer(repository: string): boolean | undefined {
    const cached = this.cache.get(repository);
    return cached && Date.now() < cached.expiresAt ? cached.isPublic : undefined;
  }

  private async lookUp(repository: string, publicToken: string | undefined): Promise<boolean> {
    const expiresAt = Date.now() + VISIBILITY_TTL_MS;
    const isPublic = await this.fetchIsPublic(repository, publicToken);
    // A slower lookup must not replace a newer answer from a concurrent request.
    // Lookups sent in the same millisecond keep the private answer.
    const cached = this.cache.get(repository);
    if (!cached || cached.expiresAt < expiresAt || (cached.expiresAt === expiresAt && !isPublic)) {
      this.cache.set(repository, { isPublic, expiresAt });
    }
    return isPublic;
  }

  /**
   * `publicToken` only raises the rate limit from 60 to 5,000 lookups an hour.
   * Never pass a token that can read private repositories.
   */
  private async fetchIsPublic(
    repository: string,
    publicToken: string | undefined
  ): Promise<boolean> {
    const [owner = '', name = ''] = repository.split('/');
    try {
      const response = await fetch(
        `${API_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        {
          redirect: 'manual',
          cache: 'no-store',
          signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'repo-pulse',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(publicToken === undefined ? {} : { Authorization: `Bearer ${publicToken}` }),
          },
        }
      );
      if (response.status !== 200) {
        await response.body?.cancel();
        logger.warn('visibility.lookup_refused', {
          component: 'github',
          repository,
          status: response.status,
        });
        return false;
      }
      const body: unknown = await response.json();
      return (
        typeof body === 'object' && body !== null && 'private' in body && body.private === false
      );
    } catch (error) {
      logger.warn('visibility.lookup_failed', { component: 'github', repository, error });
      return false;
    }
  }
}
