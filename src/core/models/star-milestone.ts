/** Star counts worth celebrating, up to the last; past it, every further `MILESTONE_STEP`. */
const FIXED_MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000] as const;
const MILESTONE_STEP = 10_000;

/** How far back a celebration counts recent stars. */
export const RECENT_STARS_DAYS = 7;

/** The highest milestone at or below `count`, or null below the first one. */
export function highestMilestone(count: number): number | null {
  if (count >= MILESTONE_STEP) {
    return Math.floor(count / MILESTONE_STEP) * MILESTONE_STEP;
  }
  let highest: number | null = null;
  for (const milestone of FIXED_MILESTONES) {
    if (milestone <= count) {
      highest = milestone;
    }
  }
  return highest;
}

/**
 * A milestone celebrated by one star event, as decided and read when it was accepted.
 * Stored on that event and never recomputed: a retry or a redelivery posts it again
 * as it was.
 */
export interface StarMilestone {
  milestone: number;
  /** When the event that crossed it was accepted. */
  reachedAt: string;
  /** The highest milestone celebrated before this one, or null when there was none. */
  previous: { milestone: number; reachedAt: string } | null;
  /**
   * Stars added minus stars removed, as recorded, from `since` to `reachedAt`, this
   * event included.
   */
  recentStars: { since: string; net: number };
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isMilestone(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && highestMilestone(value) === value
  );
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * The stored milestone, or null when there is none or it is not one this release
 * wrote. A star event is celebrated only from this, never from its count.
 */
export function readStarMilestone(value: unknown): StarMilestone | null {
  const stored = asObject(value);
  const recent = asObject(stored?.recentStars);
  if (
    stored === null ||
    recent === null ||
    !isMilestone(stored.milestone) ||
    !isTime(stored.reachedAt) ||
    !isTime(recent.since) ||
    typeof recent.net !== 'number' ||
    !Number.isSafeInteger(recent.net)
  ) {
    return null;
  }
  const prior = asObject(stored.previous);
  const previous =
    prior !== null && isMilestone(prior.milestone) && isTime(prior.reachedAt)
      ? { milestone: prior.milestone, reachedAt: prior.reachedAt }
      : null;
  if (stored.previous !== null && previous === null) {
    return null;
  }
  return {
    milestone: stored.milestone,
    reachedAt: stored.reachedAt,
    previous,
    recentStars: { since: recent.since, net: recent.net },
  };
}
