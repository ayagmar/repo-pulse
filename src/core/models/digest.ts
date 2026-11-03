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

/** An open issue or pull request where an outside person waits for the owner's side. */
export interface WaitingThread {
  /** The repository's latest recorded name. */
  repository: string;
  number: number;
  title: string;
  url: string;
  /** Who made the request that is waiting. */
  login: string;
  /** When that request happened on GitHub. */
  since: Date;
}

/** A median duration and how many samples it was taken from. */
interface DurationSample {
  medianMs: number;
  count: number;
}

export interface ResponseTimes {
  /** Pull requests merged in the window, from creation to merge. */
  merge: DurationSample | null;
  /** Threads first answered in the window, from the first outside request to the answer. */
  firstReply: DurationSample | null;
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
  /** Oldest wait first; empty when nobody waits or the threads could not be read. */
  waiting: WaitingThread[];
  /** Weekly digests only; null on daily digests and when the threads could not be read. */
  responseTimes: ResponseTimes | null;
}
