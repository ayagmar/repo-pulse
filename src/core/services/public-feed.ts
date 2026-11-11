import type {
  PublicFeed,
  PublicFeedEvent,
  PublicFeedMaterial,
  PublicFeedStarHistory,
  RepositoryAdmission,
} from '../models/public-feed.js';
import {
  COMMIT_COUNT,
  GITHUB_URL,
  isTimestamp,
  PULL_REQUEST_NUMBER,
  PULL_REQUEST_TITLE,
  RELEASE_TAG,
  REPOSITORY_ID,
  STAR_COUNT,
  toIsoString,
} from './public-event-rules.js';
import { loadMaterial, type MaterialSources } from './public-material.js';

const DAY_MS = 24 * 60 * 60_000;
/** Star history covers the current UTC day and the 89 before it. */
const STAR_HISTORY_DAYS = 90;
const STAR_HISTORY_MAX_REPOSITORIES = 50;
/**
 * GitHub lookups one response may make. A Free plan invocation may make 50
 * subrequests, the cache and D1 reads included.
 */
export const VISIBILITY_LOOKUP_BUDGET = 40;
/** The largest `limit` a response may ask for: material is read once at this size. */
export const PUBLIC_FEED_MAX_LIMIT = 100;
/**
 * Versioned with the material's shape. During a deploy the previous release and this
 * one run side by side and share the Cache API: each reads and writes only its own
 * version, so neither reads material it does not understand.
 */
const MATERIAL_CACHE_URL = 'https://repo-pulse.internal/public-feed/material/v2';

interface PublicFeedSources extends MaterialSources<PublicFeedMaterial> {
  readMaterial(limit: number, since: Date): Promise<PublicFeedMaterial>;
  admit(repositories: readonly string[], lookupBudget: number): Promise<RepositoryAdmission>;
}

/** A real calendar day as `YYYY-MM-DD`. */
function isDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    toIsoString(`${value}T00:00:00.000Z`)?.slice(0, 10) === value
  );
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
      return GITHUB_URL.test(candidate.releaseUrl) && RELEASE_TAG.test(candidate.releaseTag)
        ? {
            type: 'release.published',
            ...base,
            url: candidate.releaseUrl,
            release: { tag: candidate.releaseTag },
          }
        : null;
    case 'star.created':
      return STAR_COUNT.test(candidate.starCount)
        ? { type: 'star.created', ...base, star: { count: candidate.starCount } }
        : null;
    case 'push.default_branch':
      return GITHUB_URL.test(candidate.compareUrl) && COMMIT_COUNT.test(candidate.commitCount)
        ? {
            type: 'push.default_branch',
            ...base,
            url: candidate.compareUrl,
            push: { commits: candidate.commitCount },
          }
        : null;
    case 'pull_request.merged':
      return GITHUB_URL.test(candidate.pullRequestUrl) &&
        PULL_REQUEST_NUMBER.test(candidate.pullRequestNumber) &&
        PULL_REQUEST_TITLE.test(candidate.pullRequestTitle)
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

/** A contract event and the repository id it was recorded under. */
interface FeedCandidate {
  event: PublicFeedEvent;
  repositoryId: number;
}

/** A candidate, or null without a repository id the visibility check could match. */
function toCandidate(candidate: PublicFeedMaterial['events'][number]): FeedCandidate | null {
  if (!REPOSITORY_ID.test(candidate.repositoryId)) {
    return null;
  }
  const event = toFeedEvent(candidate);
  return event === null ? null : { event, repositoryId: candidate.repositoryId };
}

/**
 * Star history as of `now`: the days of the last 90, so cached material read
 * before UTC midnight drops its oldest day after it. Most recently starred first.
 * With `admitted`, only the days recorded under the id GitHub gives each name now;
 * without it, every candidate's days, for the visibility check.
 */
function toStarHistory(
  starDays: PublicFeedMaterial['starDays'],
  now: Date,
  admitted: ReadonlyMap<string, number> | null
): PublicFeedStarHistory[] {
  const firstDay = starHistoryStart(now).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const byRepository = new Map<string, PublicFeedStarHistory['points']>();
  for (const day of starDays) {
    if (
      !isDate(day.date) ||
      day.date < firstDay ||
      day.date > today ||
      !STAR_COUNT.test(day.stars) ||
      !REPOSITORY_ID.test(day.repositoryId) ||
      (admitted !== null && admitted.get(day.repository) !== day.repositoryId)
    ) {
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

/**
 * Material for the largest limit, shared by every `limit`: the events are newest
 * first in a total order, so the first `limit` of them are what a read at `limit`
 * returns.
 */
function loadFeedMaterial(sources: PublicFeedSources, now: Date): Promise<PublicFeedMaterial> {
  return loadMaterial(
    sources,
    {
      cacheUrl: MATERIAL_CACHE_URL,
      component: 'public-feed',
      read: () => sources.readMaterial(PUBLIC_FEED_MAX_LIMIT, starHistoryStart(now)),
    },
    now
  );
}

/**
 * The public feed: recent activity and star history of the repositories GitHub
 * shows as public right now. The material may come from a cache; the visibility
 * check runs for every response.
 *
 * `visibility_unavailable` when nothing is shown and some repository was left
 * out without a definitive denial, so an empty feed always means nothing is public,
 * never that GitHub could not be asked.
 */
export async function buildPublicFeed(
  sources: PublicFeedSources,
  limit: number
): Promise<PublicFeed | 'visibility_unavailable'> {
  const material = await loadFeedMaterial(sources, new Date());
  const candidates = material.events
    .slice(0, limit)
    .map(toCandidate)
    .filter((candidate) => candidate !== null);

  // Recent activity is checked first, so a lookup budget that runs out leaves out
  // the repositories with the oldest stars.
  const { admitted, unresolved } = await sources.admit(
    [
      ...candidates.map(({ event }) => event.repo),
      ...toStarHistory(material.starDays, new Date(), null).map((entry) => entry.repo),
    ],
    VISIBILITY_LOOKUP_BUDGET
  );

  // Built without waiting on anything after the visibility check. An event recorded
  // under another id than GitHub's for its name now is from a repository that was
  // renamed, transferred, deleted or made private since: left out, and no reason to
  // answer 503, since GitHub did answer for the name.
  const builtAt = new Date();
  const feed: PublicFeed = {
    version: 1,
    generatedAt: builtAt.toISOString(),
    events: candidates
      .filter(({ event, repositoryId }) => admitted.get(event.repo) === repositoryId)
      .map(({ event }) => event),
    starHistory: toStarHistory(material.starDays, builtAt, admitted).slice(
      0,
      STAR_HISTORY_MAX_REPOSITORIES
    ),
  };
  // Decided on the candidates at `builtAt`: past UTC midnight a repository's only
  // star day may have left the window, admitted or not.
  if (
    feed.events.length === 0 &&
    feed.starHistory.length === 0 &&
    [
      ...candidates.map(({ event }) => event.repo),
      ...toStarHistory(material.starDays, builtAt, null).map((entry) => entry.repo),
    ].some((repo) => unresolved.has(repo))
  ) {
    return 'visibility_unavailable';
  }
  return feed;
}
