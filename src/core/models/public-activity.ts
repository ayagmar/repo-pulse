/**
 * The public activity contract (`/public/activity`): published activity summed per
 * UTC day, read by ayagmar.dev for its daily strip. It counts what `/public/feed`
 * would show, over the whole recorded history instead of the newest 100 events.
 */

/** What one UTC day of one repository adds up to, as read from the history. */
interface PublicActivityRow {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  repository: string;
  pushes: number;
  commits: number;
  merges: number;
  releases: number;
  stars: number;
  /** The latest `received_at` of these events, which orders repositories for the visibility check. */
  lastAt: string;
}

/** Plain JSON, so it can be cached as is. */
export interface PublicActivityMaterial {
  /** The first UTC day with an event of the published types recorded as public, or null. */
  since: string | null;
  /** Most recently active first. */
  rows: PublicActivityRow[];
}

interface PublicActivityCounts {
  pushes: number;
  commits: number;
  merges: number;
  releases: number;
  stars: number;
}

interface PublicActivityRepo extends PublicActivityCounts {
  repo: string;
}

export interface PublicActivityDay extends PublicActivityCounts {
  date: string;
  /**
   * Every repository with counted activity that day, sorted by name, so the day's
   * counts are their sums; at most 50, the busiest.
   */
  repos: PublicActivityRepo[];
  /** True when more than 50 repositories were active: the day's counts still include them all. */
  reposTruncated: boolean;
}

export interface PublicActivity {
  generatedAt: string;
  since: string | null;
  /**
   * False when the visibility check left some repository of the window out without
   * a definitive denial (a failed lookup or one past the lookup budget): the counts
   * may be short, and a request within 60 seconds may count more.
   */
  complete: boolean;
  /** Oldest first, ending with the current UTC day. */
  days: PublicActivityDay[];
}
