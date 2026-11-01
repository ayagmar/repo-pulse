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

export interface PublicActivityDay {
  date: string;
  pushes: number;
  commits: number;
  merges: number;
  releases: number;
  stars: number;
  /** Repositories with counted activity that day, at most 10, sorted by name. */
  repos: string[];
}

export interface PublicActivity {
  generatedAt: string;
  since: string | null;
  /** Oldest first, ending with the current UTC day. */
  days: PublicActivityDay[];
}
