export interface RepositoryActivity {
  repository: string;
  url: string;
  /** Stars added minus stars removed. */
  starsGained: number;
  forks: number;
  commits: number;
  pullRequestsOpened: number;
  pullRequestsMerged: number;
  issuesOpened: number;
  issuesClosed: number;
  releases: { tagName: string; url: string }[];
}

export interface DailyDigest {
  /** Local date of the digest, YYYY-MM-DD. */
  date: string;
  timeZone: string;
  windowStart: Date;
  windowEnd: Date;
  eventCount: number;
  /** Most active repositories first. */
  repositories: RepositoryActivity[];
}
