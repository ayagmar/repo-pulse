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

/** A repository whose default branch has commits that its latest release does not. */
export interface UnreleasedWork {
  repository: string;
  compareUrl: string;
  tagName: string;
  releasedAt: Date;
  commitsSinceRelease: number;
}

/** An outside person active during a weekly digest's window. */
export interface PersonActivity {
  /** The latest login seen for the person's GitHub user id. */
  login: string;
  url: string;
  events: number;
  repositories: number;
  /** First seen inside the window. */
  isNew: boolean;
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
  /** Daily digests only, and only when GitHub was asked and answered. */
  unreleased: UnreleasedWork[];
  /** Weekly digests only, most active first, and only when the people read succeeded. */
  people: PersonActivity[];
}
