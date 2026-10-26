import type {
  PublicFeed,
  PublicFeedEvent,
  PublicFeedMaterial,
  PublicFeedStarHistory,
} from '../models/public-feed.js';
import { logger } from './logger.js';

const DAY_MS = 24 * 60 * 60_000;
/** Star history covers the current UTC day and the 89 before it. */
const STAR_HISTORY_DAYS = 90;
const STAR_HISTORY_MAX_REPOSITORIES = 50;
/**
 * GitHub lookups one response may make. A Free plan invocation may make 50
 * subrequests, the cache and D1 reads included.
 */
const VISIBILITY_LOOKUP_BUDGET = 40;
const MATERIAL_TTL_SECONDS = 300;
/** A host the Worker never serves, so a cached entry can never be returned as a response. */
const MATERIAL_CACHE_URL = 'https://repo-pulse.internal/public-feed/material';

/** The part of the Workers Cache API the feed uses. */
export interface MaterialCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

/** Material read from D1 by this isolate, by `limit`. */
export type MaterialMemory = Map<number, { material: PublicFeedMaterial; expiresAt: number }>;

interface PublicFeedSources {
  readMaterial(limit: number, since: Date): Promise<PublicFeedMaterial>;
  admit(repositories: readonly string[], lookupBudget: number): Promise<Set<string>>;
  /**
   * Checked before the Cache API, which is per location and may store nothing on
   * `*.workers.dev`: a warm isolate never reads D1 more than once per 300 seconds.
   */
  memory: MaterialMemory;
  /** The Cache API, or null where the runtime has none. */
  cache: MaterialCache | null;
  waitUntil(promise: Promise<unknown>): void;
}

function isGitHubUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 2048 &&
    value.startsWith('https://github.com/') &&
    !/\s/.test(value)
  );
}

function isCount(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function isText(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximumLength;
}

/** An ISO timestamp as `toISOString` writes it for years 0000 to 9999, which is how events are stored. */
function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    toIsoString(value) === value
  );
}

/** A real calendar day as `YYYY-MM-DD`. */
function isDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    toIsoString(`${value}T00:00:00.000Z`)?.slice(0, 10) === value
  );
}

function toIsoString(value: string): string | null {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * Build one contract event from a candidate's explicit fields, or null when the
 * type is not published or a field would break the contract.
 */
function toFeedEvent(candidate: PublicFeedMaterial['events'][number]): PublicFeedEvent | null {
  if (!isTimestamp(candidate.at)) {
    return null;
  }
  const base = { repo: candidate.repository, at: candidate.at };
  switch (candidate.type) {
    case 'release.published':
      return isGitHubUrl(candidate.releaseUrl) && isText(candidate.releaseTag, 200)
        ? {
            type: 'release.published',
            ...base,
            url: candidate.releaseUrl,
            release: { tag: candidate.releaseTag },
          }
        : null;
    case 'star.created':
      return isCount(candidate.starCount)
        ? { type: 'star.created', ...base, star: { count: candidate.starCount } }
        : null;
    case 'push.default_branch':
      return isGitHubUrl(candidate.compareUrl) && isCount(candidate.commitCount, 10_000)
        ? {
            type: 'push.default_branch',
            ...base,
            url: candidate.compareUrl,
            push: { commits: candidate.commitCount },
          }
        : null;
    case 'pull_request.merged':
      return isGitHubUrl(candidate.pullRequestUrl) &&
        isCount(candidate.pullRequestNumber) &&
        candidate.pullRequestNumber > 0 &&
        isText(candidate.pullRequestTitle, 300)
        ? {
            type: 'pull_request.merged',
            ...base,
            url: candidate.pullRequestUrl,
            pullRequest: {
              number: candidate.pullRequestNumber,
              title: candidate.pullRequestTitle,
            },
          }
        : null;
    default:
      return null;
  }
}

/**
 * Star history as of `now`: the days of the last 90, so cached material read
 * before UTC midnight drops its oldest day after it. Most recently starred first.
 */
function toStarHistory(
  starDays: PublicFeedMaterial['starDays'],
  now: Date
): PublicFeedStarHistory[] {
  const firstDay = starHistoryStart(now).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const byRepository = new Map<string, PublicFeedStarHistory['points']>();
  for (const day of starDays) {
    if (!isDate(day.date) || day.date < firstDay || day.date > today || !isCount(day.stars)) {
      continue;
    }
    const points = byRepository.get(day.repository) ?? [];
    points.push({ date: day.date, stars: day.stars });
    byRepository.set(day.repository, points);
  }
  return [...byRepository]
    .map(([repo, points]) => ({ repo, points }))
    .sort(
      (left, right) =>
        (right.points.at(-1)?.date ?? '').localeCompare(left.points.at(-1)?.date ?? '') ||
        left.repo.localeCompare(right.repo)
    );
}

/** Start of the oldest UTC day star history covers. */
function starHistoryStart(now: Date): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - (STAR_HISTORY_DAYS - 1) * DAY_MS);
}

async function loadMaterial(
  sources: PublicFeedSources,
  limit: number,
  now: Date
): Promise<PublicFeedMaterial> {
  const remembered = sources.memory.get(limit);
  if (remembered && now.getTime() < remembered.expiresAt) {
    return remembered.material;
  }
  const key = `${MATERIAL_CACHE_URL}?limit=${String(limit)}`;
  const cached = await sources.cache?.match(key);
  if (cached) {
    return cached.json();
  }

  const material = await sources.readMaterial(limit, starHistoryStart(now));
  sources.memory.set(limit, {
    material,
    expiresAt: now.getTime() + MATERIAL_TTL_SECONDS * 1000,
  });
  if (sources.cache) {
    sources.waitUntil(
      sources.cache
        .put(
          key,
          new Response(JSON.stringify(material), {
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': `max-age=${String(MATERIAL_TTL_SECONDS)}`,
            },
          })
        )
        .catch((error: unknown) => {
          logger.warn('public_feed.material_cache_failed', { component: 'public-feed', error });
        })
    );
  }
  return material;
}

/**
 * The public feed: recent activity and star history of the repositories GitHub
 * shows as public right now. The material may come from a cache; the visibility
 * check runs for every response.
 */
export async function buildPublicFeed(
  sources: PublicFeedSources,
  limit: number
): Promise<PublicFeed> {
  const material = await loadMaterial(sources, limit, new Date());
  const events = material.events.map(toFeedEvent).filter((event) => event !== null);

  // Recent activity is checked first, so a lookup budget that runs out leaves out
  // the repositories with the oldest stars.
  const admitted = await sources.admit(
    [
      ...events.map((event) => event.repo),
      ...toStarHistory(material.starDays, new Date()).map((entry) => entry.repo),
    ],
    VISIBILITY_LOOKUP_BUDGET
  );

  // Built without waiting on anything after the visibility check.
  const builtAt = new Date();
  return {
    version: 1,
    generatedAt: builtAt.toISOString(),
    events: events.filter((event) => admitted.has(event.repo)),
    starHistory: toStarHistory(material.starDays, builtAt)
      .filter((entry) => admitted.has(entry.repo))
      .slice(0, STAR_HISTORY_MAX_REPOSITORIES),
  };
}
