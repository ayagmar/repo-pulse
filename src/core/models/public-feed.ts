/**
 * The public feed contract (`/public/feed`, version 1) and the gate-independent
 * material it is built from. The contract is owned by ayagmar.dev (ADR 0012);
 * a new type or field is added there first.
 */

/** A candidate event as read from the history: explicit fields only, nothing gated yet. */
interface PublicFeedCandidate {
  type: string;
  repository: string;
  /** When repo-pulse received the event, as an ISO timestamp. */
  at: string;
  releaseTag: unknown;
  releaseUrl: unknown;
  starCount: unknown;
  compareUrl: unknown;
  commitCount: unknown;
  pullRequestNumber: unknown;
  pullRequestTitle: unknown;
  pullRequestUrl: unknown;
}

/** A repository's star count at the end of one UTC day. */
interface PublicFeedStarDay {
  repository: string;
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  stars: unknown;
}

/** Plain JSON, so it can be cached as is. */
export interface PublicFeedMaterial {
  /** Newest first. */
  events: PublicFeedCandidate[];
  /** By repository, then oldest day first. */
  starDays: PublicFeedStarDay[];
}

interface FeedEventBase {
  repo: string;
  at: string;
}

export type PublicFeedEvent = FeedEventBase &
  (
    | { type: 'release.published'; url: string; release: { tag: string } }
    | { type: 'star.created'; star: { count: number } }
    | { type: 'push.default_branch'; url: string; push: { commits: number } }
    | {
        type: 'pull_request.merged';
        url: string;
        pullRequest: { number: number; title: string };
      }
  );

export interface PublicFeedStarHistory {
  repo: string;
  points: { date: string; stars: number }[];
}

export interface PublicFeed {
  version: 1;
  generatedAt: string;
  events: PublicFeedEvent[];
  starHistory: PublicFeedStarHistory[];
}

/** The outcome of a response's visibility check. */
export interface RepositoryAdmission {
  /** The repositories GitHub shows as public right now. */
  admitted: Set<string>;
  /** Repositories left out without a definitive denial (`404` or `"private": true`). */
  unresolved: Set<string>;
}
