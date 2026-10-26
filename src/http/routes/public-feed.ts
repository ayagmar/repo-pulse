import type { Context } from 'hono';
import { Hono } from 'hono';
import { D1EventHistory } from '../../core/services/d1-event-history.js';
import { logger } from '../../core/services/logger.js';
import { buildPublicFeed, type MaterialCache } from '../../core/services/public-feed.js';
import { RepositoryVisibilityGate } from '../../providers/github/repository-visibility.js';
import type { HttpEnv } from '../app-env.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** The `limit` query parameter, or null when it is not an integer from 1 to 100. */
function parseLimit(value: string | undefined): number | null {
  if (value === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const limit = Number.parseInt(value, 10);
  return limit >= 1 && limit <= MAX_LIMIT ? limit : null;
}

/**
 * The Workers runtime's default cache, or null outside it. The DOM lib's
 * `CacheStorage` type, also in scope, does not declare `default`.
 */
function defaultCache(): MaterialCache | null {
  return typeof caches === 'undefined'
    ? null
    : (caches as unknown as { default: MaterialCache }).default;
}

/** Every answer of this route: no shared caches, so none outlives the visibility check. */
function feedJson(c: Context<HttpEnv>, body: unknown, status: 200 | 400 | 405 | 500): Response {
  c.header('Cache-Control', 'no-store');
  return c.json(body, status);
}

/**
 * Unauthenticated, read-only routes for ayagmar.dev. They read only `env.DB`, so a
 * missing webhook or admin secret does not take them down.
 */
export function createPublicFeedRoutes(
  gate: RepositoryVisibilityGate = new RepositoryVisibilityGate()
): Hono<HttpEnv> {
  const router = new Hono<HttpEnv>();

  router.onError((error, c) => {
    logger.error('public_feed.failed', { component: 'public-feed', error });
    return feedJson(c, { error: 'internal_error' }, 500);
  });

  router.get('/feed', async (c) => {
    const limit = parseLimit(c.req.query('limit'));
    if (limit === null) {
      return feedJson(c, { error: 'invalid_query' }, 400);
    }

    const history = new D1EventHistory(c.env.DB);
    const feed = await buildPublicFeed(
      {
        readMaterial: (materialLimit, since) =>
          history.readPublicFeedMaterial(materialLimit, since),
        // Never GITHUB_TOKEN: it can read private repositories.
        admit: (repositories, lookupBudget) =>
          gate.admit(repositories, lookupBudget, c.env.GITHUB_PUBLIC_TOKEN),
        cache: defaultCache(),
        waitUntil: (promise) => {
          c.executionCtx.waitUntil(promise);
        },
      },
      limit
    );
    return feedJson(c, feed, 200);
  });

  router.all('/feed', (c) => {
    c.header('Allow', 'GET, HEAD');
    return feedJson(c, { error: 'method_not_allowed' }, 405);
  });

  return router;
}
