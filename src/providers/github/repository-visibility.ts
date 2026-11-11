import type { RepositoryAdmission } from '../../core/models/public-feed.js';
import { logger } from '../../core/services/logger.js';
import { REPOSITORY_ID } from '../../core/services/public-event-rules.js';

const API_URL = 'https://api.github.com';
/** A visibility answer, admitted or not, is used for at most this long. */
const VISIBILITY_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 3_000;
/** GitHub's own limits on owner and repository names, as the feed contract states them. */
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * `denied` is GitHub's definitive answer that a repository is not public under this
 * name (a `404`, a `301` for a renamed or transferred repository, or `"private": true`);
 * `unresolved` is a lookup that gave no answer.
 */
type Visibility = 'public' | 'denied' | 'unresolved';

/** A lookup's answer, with the id of the repository GitHub found when it is public. */
interface Answer {
  visibility: Visibility;
  /** GitHub's repository id: set exactly when `visibility` is `public`. */
  id: number | null;
}

/** Of two answers to lookups sent in the same millisecond, the higher one is kept. */
const PRECEDENCE: Record<Visibility, number> = { public: 0, unresolved: 1, denied: 2 };

interface CachedVisibility extends Answer {
  /** Counted from when the lookup was sent, so an answer never outlives its TTL. */
  expiresAt: number;
}

/**
 * Admits a repository to a public response only while GitHub says it is public,
 * and says which repository that is: its id, which outlives a rename and is never
 * given to another repository. It asks GitHub without a token, or with a token
 * that can read public repositories only, so a private repository answers `404`
 * whatever the token owner can see. Only a `200` with `"private": false` admits; every other
 * answer, or no answer, leaves it out. Recorded webhook events never admit
 * a repository.
 */
export class RepositoryVisibilityGate {
  // Plain values only: a Worker request must not await a promise another request
  // created, so concurrent requests each look up what is not cached.
  private readonly cache = new Map<string, CachedVisibility>();

  /**
   * The given repositories GitHub currently shows as public, each with GitHub's id
   * for it, so a caller admits only what was recorded under that id. Those without a
   * fresh answer are looked up, at most `lookupBudget` of them; the rest are left
   * out. The answers are read once every lookup has settled, so one that expired
   * while the others were pending does not admit its repository, and a repository
   * needs both this request's own answer and the cached one to say public, with the
   * same id. Build the response without waiting on anything else after this resolves.
   *
   * `unresolved` lists the repositories left out without a definitive denial: a
   * failed lookup, a cached failure, no lookup within the budget, or an answer
   * that expired before it could be used.
   */
  async admit(
    repositories: readonly string[],
    lookupBudget: number,
    publicToken: string | undefined
  ): Promise<RepositoryAdmission> {
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
    const admitted = new Map<string, number>();
    const unresolved = new Set<string>();
    for (const repository of candidates) {
      const own = ownAnswers.get(repository);
      const fresh = this.freshAnswer(repository);
      if (
        fresh?.visibility === 'public' &&
        fresh.id !== null &&
        (own === undefined || (own.visibility === 'public' && own.id === fresh.id))
      ) {
        admitted.set(repository, fresh.id);
      } else if (own?.visibility !== 'denied' && fresh?.visibility !== 'denied') {
        unresolved.add(repository);
      }
    }
    return { admitted, unresolved };
  }

  /** The cached answer for a repository, or undefined once it is 60 seconds old. */
  private freshAnswer(repository: string): Answer | undefined {
    const cached = this.cache.get(repository);
    return cached && Date.now() < cached.expiresAt
      ? { visibility: cached.visibility, id: cached.id }
      : undefined;
  }

  private async lookUp(repository: string, publicToken: string | undefined): Promise<Answer> {
    const expiresAt = Date.now() + VISIBILITY_TTL_MS;
    const answer = await this.fetchVisibility(repository, publicToken);
    // A slower lookup must not replace a newer answer from a concurrent request.
    // Lookups sent in the same millisecond keep the least public answer.
    const cached = this.cache.get(repository);
    if (
      !cached ||
      cached.expiresAt < expiresAt ||
      (cached.expiresAt === expiresAt &&
        PRECEDENCE[answer.visibility] > PRECEDENCE[cached.visibility])
    ) {
      this.cache.set(repository, { ...answer, expiresAt });
    }
    return answer;
  }

  /**
   * Whether GitHub says, right now, that the repository with this id is public and not
   * a fork. Looked up on every call and never cached; any other answer, a renamed or
   * replaced repository, or no answer is false. Gates the writes Discord actions make.
   */
  async isPublicSource(
    repository: { fullName: string; id: number },
    publicToken: string | undefined
  ): Promise<boolean> {
    if (!REPOSITORY_NAME_PATTERN.test(repository.fullName)) {
      return false;
    }
    const found = await this.fetchRepository(repository.fullName, publicToken);
    return (
      typeof found === 'object' &&
      found.private === false &&
      found.fork === false &&
      found.id === repository.id
    );
  }

  private async fetchVisibility(
    repository: string,
    publicToken: string | undefined
  ): Promise<Answer> {
    const found = await this.fetchRepository(repository, publicToken);
    if (found === 'not_found') {
      return { visibility: 'denied', id: null };
    }
    if (found === 'unavailable') {
      return { visibility: 'unresolved', id: null };
    }
    if (found.private === false && REPOSITORY_ID.test(found.id)) {
      return { visibility: 'public', id: found.id };
    }
    if (found.private === true) {
      return { visibility: 'denied', id: null };
    }
    logger.warn('visibility.lookup_unreadable', { component: 'github', repository });
    return { visibility: 'unresolved', id: null };
  }

  /**
   * GitHub's answer about a repository: its fields as found, `not_found` for a `404`
   * or for the `301` GitHub keeps answering for the old name of a renamed or transferred
   * repository, or `unavailable` for any other answer or none. `publicToken` only raises the rate
   * limit from 60 to 5,000 lookups an hour. Never pass a token that can read private
   * repositories.
   */
  private async fetchRepository(
    repository: string,
    publicToken: string | undefined
  ): Promise<{ id: unknown; private: unknown; fork: unknown } | 'not_found' | 'unavailable'> {
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
        return response.status === 404 || response.status === 301 ? 'not_found' : 'unavailable';
      }
      const body: unknown = await response.json();
      const fields = (typeof body === 'object' && body !== null ? body : {}) as Record<
        string,
        unknown
      >;
      return { id: fields.id, private: fields.private, fork: fields.fork };
    } catch {
      // A transport error can quote the request, Authorization header included.
      logger.warn('visibility.lookup_failed', { component: 'github', repository });
      return 'unavailable';
    }
  }
}
