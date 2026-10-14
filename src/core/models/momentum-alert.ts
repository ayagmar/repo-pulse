/** A recent stargazer with enough followers that their star may bring others. */
export interface NotableStargazer {
  login: string;
  url: string;
  followers: number;
}

/** A site that sent visitors to the repository in the last 14 days, per GitHub traffic. */
export interface Referrer {
  name: string;
  views: number;
  uniqueVisitors: number;
}

/** A repository gaining stars much faster than it usually does. */
export interface MomentumAlert {
  repository: string;
  url: string;
  detectedAt: Date;
  windowHours: number;
  /** Stars gained in the last `windowHours`. */
  recentStars: number;
  /** Stars a window that long got on average over the two weeks before it. */
  expectedStars: number;
  totalStars: number;
  /** Most followed first. Empty without a GitHub token. */
  notableStargazers: NotableStargazer[];
  /** Most views first. Empty without a GitHub token. */
  referrers: Referrer[];
}
