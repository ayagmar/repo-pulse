export type DigestPeriod = 'daily' | 'weekly';

interface MergedPullRequest {
  number: number;
  title: string;
  url: string;
}

export interface RepositoryActivity {
  repository: string;
  url: string;
  /** Stars added minus stars removed. */
  starsGained: number;
  forks: number;
  commits: number;
  pullRequestsOpened: number;
  pullRequestsMerged: MergedPullRequest[];
  issuesOpened: number;
  issuesClosed: number;
  releases: { tagName: string; url: string }[];
}

export interface Digest {
  period: DigestPeriod;
  /** Local date of the digest, YYYY-MM-DD. */
  date: string;
  timeZone: string;
  windowStart: Date;
  windowEnd: Date;
  eventCount: number;
  /** Most active repositories first. */
  repositories: RepositoryActivity[];
}
