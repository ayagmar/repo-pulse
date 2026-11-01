import type {
  PublicActivity,
  PublicActivityDay,
  PublicActivityMaterial,
} from '../models/public-activity.js';
import type { RepositoryAdmission } from '../models/public-feed.js';
import { VISIBILITY_LOOKUP_BUDGET } from './public-feed.js';
import { loadMaterial, type MaterialSources } from './public-material.js';

const DAY_MS = 24 * 60 * 60_000;
/** The most days a response may ask for: material is read once for this many. */
export const PUBLIC_ACTIVITY_MAX_DAYS = 400;
const MAX_REPOSITORIES_PER_DAY = 10;
const MATERIAL_CACHE_URL = 'https://repo-pulse.internal/public-activity/material';

type ActivityRow = PublicActivityMaterial['rows'][number];

interface PublicActivitySources extends MaterialSources<PublicActivityMaterial> {
  readMaterial(since: Date): Promise<PublicActivityMaterial>;
  admit(repositories: readonly string[], lookupBudget: number): Promise<RepositoryAdmission>;
}

/** The UTC day `daysBack` days before `now`'s, as `YYYY-MM-DD`. */
function utcDay(now: Date, daysBack: number): string {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - daysBack * DAY_MS).toISOString().slice(0, 10);
}

function eventCount(row: ActivityRow): number {
  return row.pushes + row.merges + row.releases + row.stars;
}

/** The rows of the `days` UTC days ending with `now`'s. */
function rowsInWindow(rows: readonly ActivityRow[], days: number, now: Date): ActivityRow[] {
  const first = utcDay(now, days - 1);
  const last = utcDay(now, 0);
  return rows.filter((row) => row.date >= first && row.date <= last);
}

/** One entry per day of the window, oldest first; a day without rows is zeros. */
function toDays(rows: readonly ActivityRow[], days: number, now: Date): PublicActivityDay[] {
  const byDate = new Map<string, ActivityRow[]>();
  for (const row of rows) {
    byDate.set(row.date, [...(byDate.get(row.date) ?? []), row]);
  }
  return Array.from({ length: days }, (_, index) => {
    const date = utcDay(now, days - 1 - index);
    const dayRows = byDate.get(date) ?? [];
    const sum = (field: 'pushes' | 'commits' | 'merges' | 'releases' | 'stars'): number =>
      dayRows.reduce((total, row) => total + row[field], 0);
    return {
      date,
      pushes: sum('pushes'),
      commits: sum('commits'),
      merges: sum('merges'),
      releases: sum('releases'),
      stars: sum('stars'),
      // The busiest repositories of the day, listed by name.
      repos: [...dayRows]
        .sort(
          (left, right) =>
            eventCount(right) - eventCount(left) || left.repository.localeCompare(right.repository)
        )
        .slice(0, MAX_REPOSITORIES_PER_DAY)
        .map((row) => row.repository)
        .sort(),
    };
  });
}

/**
 * Published activity per UTC day over the last `days` days, counting only the
 * repositories GitHub shows as public right now, through the feed's visibility
 * check. The material may come from a cache; the visibility check runs for every
 * response.
 *
 * `visibility_unavailable` when nothing is counted and some repository was left
 * out without a definitive denial, as the feed does, so all-zero days always mean
 * nothing public happened, never that GitHub could not be asked.
 */
export async function buildPublicActivity(
  sources: PublicActivitySources,
  days: number
): Promise<PublicActivity | 'visibility_unavailable'> {
  const now = new Date();
  const material = await loadMaterial(
    sources,
    {
      cacheUrl: MATERIAL_CACHE_URL,
      component: 'public-activity',
      read: () =>
        sources.readMaterial(
          new Date(`${utcDay(now, PUBLIC_ACTIVITY_MAX_DAYS - 1)}T00:00:00.000Z`)
        ),
    },
    now
  );
  // Most recently active first, so a lookup budget that runs out leaves out the
  // repositories with the oldest activity.
  const candidates = rowsInWindow(material.rows, days, now);
  const { admitted, unresolved } = await sources.admit(
    candidates.map((row) => row.repository),
    VISIBILITY_LOOKUP_BUDGET
  );

  // Built without waiting on anything after the visibility check.
  const builtAt = new Date();
  const window = rowsInWindow(material.rows, days, builtAt);
  const counted = window.filter((row) => admitted.has(row.repository));
  if (
    counted.length === 0 &&
    [...candidates, ...window].some((row) => unresolved.has(row.repository))
  ) {
    return 'visibility_unavailable';
  }
  return {
    generatedAt: builtAt.toISOString(),
    since: material.since,
    days: toDays(counted, days, builtAt),
  };
}
