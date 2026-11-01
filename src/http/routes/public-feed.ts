import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import type { PublicActivityMaterial } from '../../core/models/public-activity.js';
import type { PublicFeedMaterial, RepositoryAdmission } from '../../core/models/public-feed.js';
import { D1EventHistory } from '../../core/services/d1-event-history.js';
import { logger } from '../../core/services/logger.js';
import {
  buildPublicActivity,
  PUBLIC_ACTIVITY_MAX_DAYS,
} from '../../core/services/public-activity.js';
import { buildPublicFeed, PUBLIC_FEED_MAX_LIMIT } from '../../core/services/public-feed.js';
import type {
  MaterialCache,
  MaterialMemory,
  MaterialSources,
} from '../../core/services/public-material.js';
import { RepositoryVisibilityGate } from '../../providers/github/repository-visibility.js';
import type { HttpEnv } from '../app-env.js';

const DEFAULT_LIMIT = 50;
const DEFAULT_DAYS = 28;

/** A query parameter that must be an integer from 1 to `maximum`, or null when it is not. */
function parseCount(value: string | undefined, fallback: number, maximum: number): number | null {
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const count = Number.parseInt(value, 10);
  return count >= 1 && count <= maximum ? count : null;
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
function feedJson(
  c: Context<HttpEnv>,
  body: unknown,
  status: 200 | 400 | 405 | 429 | 500 | 503
): Response {
  c.header('Cache-Control', 'no-store');
  return c.json(body, status);
}

type SharedSources = Pick<MaterialSources<unknown>, 'cache' | 'waitUntil'> & {
  admit(repositories: readonly string[], lookupBudget: number): Promise<RepositoryAdmission>;
};

/**
 * Unauthenticated, read-only routes for ayagmar.dev. They read only `env.DB`, so a
 * missing webhook or admin secret does not take them down.
 */
export function createPublicFeedRoutes(
  gate: RepositoryVisibilityGate = new RepositoryVisibilityGate()
): Hono<HttpEnv> {
  const router = new Hono<HttpEnv>();
  const feedMemory: MaterialMemory<PublicFeedMaterial> = {};
  const activityMemory: MaterialMemory<PublicActivityMaterial> = {};

  router.onError((error, c) => {
    logger.error('public_feed.failed', { component: 'public-feed', error });
    return feedJson(c, { error: 'internal_error' }, 500);
  });

  // Per client and Cloudflare location, shared by both routes, so a loop on these
  // public URLs cannot spend the account's D1 reads or GitHub lookups. signals asks
  // every 15 minutes.
  const rateLimit: MiddlewareHandler<HttpEnv> = async (c, next) => {
    const { success } = await c.env.FEED_RATE_LIMIT.limit({
      key: c.req.header('CF-Connecting-IP') ?? 'unknown',
    });
    if (!success) {
      return feedJson(c, { error: 'rate_limited' }, 429);
    }
    await next();
    return undefined;
  };

  /** What both routes build from, apart from their material: the shared gate and the caches. */
  const shared = (c: Context<HttpEnv>): SharedSources => ({
    // Never GITHUB_TOKEN: it can read private repositories.
    admit: (repositories, lookupBudget) =>
      gate.admit(repositories, lookupBudget, c.env.GITHUB_PUBLIC_TOKEN),
    cache: defaultCache(),
    waitUntil: (promise): void => {
      c.executionCtx.waitUntil(promise);
    },
  });

  router.get('/feed', rateLimit, async (c) => {
    const limit = parseCount(c.req.query('limit'), DEFAULT_LIMIT, PUBLIC_FEED_MAX_LIMIT);
    if (limit === null) {
      return feedJson(c, { error: 'invalid_query' }, 400);
    }

    const history = new D1EventHistory(c.env.DB);
    const feed = await buildPublicFeed(
      {
        ...shared(c),
        memory: feedMemory,
        readMaterial: (materialLimit, since) =>
          history.readPublicFeedMaterial(materialLimit, since),
      },
      limit
    );
    if (feed === 'visibility_unavailable') {
      // signals keeps its last snapshot instead of storing an empty feed.
      return feedJson(c, { error: 'visibility_unavailable' }, 503);
    }
    return feedJson(c, feed, 200);
  });

  router.get('/activity', rateLimit, async (c) => {
    const days = parseCount(c.req.query('days'), DEFAULT_DAYS, PUBLIC_ACTIVITY_MAX_DAYS);
    if (days === null) {
      return feedJson(c, { error: 'invalid_query' }, 400);
    }

    const history = new D1EventHistory(c.env.DB);
    const activity = await buildPublicActivity(
      {
        ...shared(c),
        memory: activityMemory,
        readMaterial: (since) => history.readPublicActivityMaterial(since),
      },
      days
    );
    if (activity === 'visibility_unavailable') {
      return feedJson(c, { error: 'visibility_unavailable' }, 503);
    }
    return feedJson(c, activity, 200);
  });

  router.all('/feed', methodNotAllowed);
  router.all('/activity', methodNotAllowed);

  return router;
}

function methodNotAllowed(c: Context<HttpEnv>): Response {
  c.header('Allow', 'GET, HEAD');
  return feedJson(c, { error: 'method_not_allowed' }, 405);
}
