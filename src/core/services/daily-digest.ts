import type { DailyDigest, RepositoryActivity } from '../models/daily-digest.js';
import { REPO_EVENT_TYPES } from '../models/repo-event.js';
import type { D1DigestLog } from './d1-digest-log.js';
import type { D1EventHistory, EventActivity } from './d1-event-history.js';
import { logger } from './logger.js';
import type { NotificationDispatcher } from './notification-dispatcher.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * The digest is due during the first minutes after its local hour. The cron runs every
 * minute, so a failed send is retried until this window closes.
 */
const SEND_WINDOW_MINUTES = 10;

/**
 * How long a claimed digest is left to the run that claimed it. A run that stopped
 * after posting but before recording it causes one repeat post once this passes.
 */
const DIGEST_CLAIM_LEASE_MS = 5 * MINUTE_MS;

interface DigestWindow {
  date: string;
  start: Date;
  end: Date;
}

interface LocalDateTime {
  date: string;
  hour: number;
  minute: number;
}

/** Building a formatter costs far more than using one, and the cron runs every minute. */
const localFormatters = new Map<string, Intl.DateTimeFormat>();

function localDateTime(instant: Date, timeZone: string): LocalDateTime {
  let formatter = localFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    localFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? '';

  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    hour: Number(part('hour')),
    minute: Number(part('minute')),
  };
}

function parseDate(date: string): [number, number, number] {
  return date.split('-').map(Number) as [number, number, number];
}

/** Local time minus UTC at the given instant, to the minute. */
function utcOffsetMs(instant: number, timeZone: string): number {
  const local = localDateTime(new Date(instant), timeZone);
  const [year, month, day] = parseDate(local.date);
  const localAsUtc = Date.UTC(year, month - 1, day, local.hour, local.minute);
  return localAsUtc - Math.floor(instant / MINUTE_MS) * MINUTE_MS;
}

/**
 * The instant at which a local date reaches `hour`:00. Clock changes are resolved
 * like Temporal's "compatible" disambiguation: a repeated hour uses its first
 * occurrence, and an hour skipped by a clock change moves forward by the gap.
 */
function localHourInstant(date: string, hour: number, timeZone: string): Date {
  const [year, month, day] = parseDate(date);
  const wallClock = Date.UTC(year, month - 1, day, hour);
  // The offsets in effect a day either side cover any single clock change at that hour.
  const withOffsetBefore = wallClock - utcOffsetMs(wallClock - DAY_MS, timeZone);
  const withOffsetAfter = wallClock - utcOffsetMs(wallClock + DAY_MS, timeZone);
  const isExact = (instant: number): boolean =>
    instant + utcOffsetMs(instant, timeZone) === wallClock;

  if (isExact(withOffsetBefore) && isExact(withOffsetAfter)) {
    return new Date(Math.min(withOffsetBefore, withOffsetAfter));
  }
  if (isExact(withOffsetAfter)) {
    return new Date(withOffsetAfter);
  }
  return new Date(withOffsetBefore);
}

function previousDate(date: string): string {
  const [year, month, day] = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/**
 * The digest due at `now`, or null when none is. A digest covers the day up to the
 * digest hour: from that hour on the previous local day to that hour today. Both ends
 * come from the same local-hour instant, so consecutive digests meet exactly, even
 * across a clock change, when a window lasts 23 or 25 hours.
 */
export function dueDigestWindow(now: Date, timeZone: string, hour: number): DigestWindow | null {
  const today = localDateTime(now, timeZone).date;
  // A digest hour skipped by a clock change can move into the next local day, as 23:00
  // does in America/Nuuk each March, so yesterday's digest may be the one due.
  for (const date of [today, previousDate(today)]) {
    const end = localHourInstant(date, hour, timeZone);
    const elapsed = now.getTime() - end.getTime();
    if (elapsed >= 0 && elapsed < SEND_WINDOW_MINUTES * MINUTE_MS) {
      return { date, start: localHourInstant(previousDate(date), hour, timeZone), end };
    }
  }
  return null;
}

function emptyActivity(event: EventActivity): RepositoryActivity {
  return {
    repository: event.repository,
    url: event.repositoryUrl,
    starsGained: 0,
    forks: 0,
    commits: 0,
    pullRequestsOpened: 0,
    pullRequestsMerged: 0,
    issuesOpened: 0,
    issuesClosed: 0,
    releases: [],
  };
}

function summarizeRepositories(events: readonly EventActivity[]): RepositoryActivity[] {
  const byRepository = new Map<string, RepositoryActivity>();
  const eventCounts = new Map<string, number>();

  for (const event of events) {
    const activity = byRepository.get(event.repository) ?? emptyActivity(event);
    byRepository.set(event.repository, activity);
    eventCounts.set(event.repository, (eventCounts.get(event.repository) ?? 0) + 1);

    switch (event.eventType) {
      case REPO_EVENT_TYPES.STAR_CREATED:
        activity.starsGained += 1;
        break;
      case REPO_EVENT_TYPES.STAR_DELETED:
        activity.starsGained -= 1;
        break;
      case REPO_EVENT_TYPES.FORK_CREATED:
        activity.forks += 1;
        break;
      case REPO_EVENT_TYPES.PUSH_DEFAULT_BRANCH:
        activity.commits += event.commitCount ?? 0;
        break;
      case REPO_EVENT_TYPES.PULL_REQUEST_OPENED:
        activity.pullRequestsOpened += 1;
        break;
      case REPO_EVENT_TYPES.PULL_REQUEST_MERGED:
        activity.pullRequestsMerged += 1;
        break;
      case REPO_EVENT_TYPES.ISSUE_OPENED:
        activity.issuesOpened += 1;
        break;
      case REPO_EVENT_TYPES.ISSUE_CLOSED:
        activity.issuesClosed += 1;
        break;
      case REPO_EVENT_TYPES.RELEASE_PUBLISHED:
        if (event.releaseTagName !== null && event.releaseUrl !== null) {
          activity.releases.push({ tagName: event.releaseTagName, url: event.releaseUrl });
        }
        break;
      default:
        break;
    }
  }

  return [...byRepository.values()].sort(
    (left, right) =>
      (eventCounts.get(right.repository) ?? 0) - (eventCounts.get(left.repository) ?? 0) ||
      left.repository.localeCompare(right.repository)
  );
}

export class DailyDigestSender {
  constructor(
    private readonly history: D1EventHistory,
    private readonly digestLog: D1DigestLog,
    private readonly dispatcher: NotificationDispatcher,
    private readonly options: { timeZone: string; hour: number }
  ) {}

  async sendDueDigest(now: Date): Promise<void> {
    if (!this.dispatcher.hasNotifiers()) {
      return;
    }

    const window = dueDigestWindow(now, this.options.timeZone, this.options.hour);
    if (!window) {
      return;
    }

    const digestId = `daily:${window.date}`;
    /** Provider name to the time of its claim. */
    const claimedProviders = new Map<string, string>();
    for (const notifier of this.dispatcher.getNotifiers()) {
      // `now` is the cron's scheduled time. A late run must not backdate its claim, or
      // its lease would end early and an on-time run could post the digest again.
      const claimedAt = await this.digestLog.claim(
        digestId,
        notifier.name,
        new Date(),
        DIGEST_CLAIM_LEASE_MS
      );
      if (claimedAt !== null) {
        claimedProviders.set(notifier.name, claimedAt);
      }
    }
    if (claimedProviders.size === 0) {
      return;
    }

    const events = await this.history.listActivityBetween(window.start, window.end);
    if (events.length === 0) {
      for (const [provider, claimedAt] of claimedProviders) {
        await this.digestLog.release(digestId, provider, claimedAt);
      }
      return;
    }

    const digest: DailyDigest = {
      date: window.date,
      timeZone: this.options.timeZone,
      windowStart: window.start,
      windowEnd: window.end,
      eventCount: events.length,
      repositories: summarizeRepositories(events),
    };
    const unclaimedProviders = new Set(
      this.dispatcher
        .getNotifiers()
        .map((notifier) => notifier.name)
        .filter((name) => !claimedProviders.has(name))
    );
    const results = await this.dispatcher.dispatchDigest(digest, {
      skipProviders: unclaimedProviders,
    });

    for (const result of results) {
      const claimedAt = claimedProviders.get(result.provider);
      if (claimedAt === undefined) {
        continue;
      }
      if (result.success) {
        await this.digestLog.markSent(digestId, result.provider, new Date());
      } else {
        await this.digestLog.release(digestId, result.provider, claimedAt);
      }
    }

    logger.info('daily_digest.dispatched', {
      component: 'daily_digest',
      digestDate: window.date,
      eventCount: digest.eventCount,
      succeeded: results.filter((result) => result.success).map((result) => result.provider),
      failed: results.filter((result) => !result.success).map((result) => result.provider),
    });
  }
}
