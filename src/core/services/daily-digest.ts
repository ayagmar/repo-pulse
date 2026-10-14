import type { DailyDigest, RepositoryActivity } from '../models/daily-digest.js';
import { REPO_EVENT_TYPES } from '../models/repo-event.js';
import type { D1DigestLog } from './d1-digest-log.js';
import type { D1EventHistory, EventActivity } from './d1-event-history.js';
import { logger } from './logger.js';
import type { NotificationDispatcher } from './notification-dispatcher.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * The digest is due during the first minutes of its local hour. The cron runs every
 * minute, so a failed send is retried until this window closes.
 */
const SEND_WINDOW_MINUTES = 10;

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

function localDateTime(instant: Date, timeZone: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? '';

  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    hour: Number(part('hour')),
    minute: Number(part('minute')),
  };
}

/** Local time minus UTC at the given instant, to the minute. */
function utcOffsetMs(instant: Date, timeZone: string): number {
  const local = localDateTime(instant, timeZone);
  const [year, month, day] = local.date.split('-').map(Number) as [number, number, number];
  const localAsUtc = Date.UTC(year, month - 1, day, local.hour, local.minute);
  return localAsUtc - Math.floor(instant.getTime() / MINUTE_MS) * MINUTE_MS;
}

/**
 * The digest due at `now`, or null when none is. A digest covers the day up to the
 * digest hour: from that hour on the previous local day to that hour today. Around a
 * clock change this is 23 or 25 hours.
 */
export function dueDigestWindow(now: Date, timeZone: string, hour: number): DigestWindow | null {
  const local = localDateTime(now, timeZone);
  if (local.hour !== hour || local.minute >= SEND_WINDOW_MINUTES) {
    return null;
  }

  const end = new Date(
    Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS - local.minute * MINUTE_MS
  );
  const dayBefore = new Date(end.getTime() - DAY_MS);
  const start = new Date(
    dayBefore.getTime() + utcOffsetMs(end, timeZone) - utcOffsetMs(dayBefore, timeZone)
  );

  return { date: local.date, start, end };
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

    const sentProviders = await this.digestLog.listSentProviders(window.date);
    const pendingProviders = this.dispatcher
      .getNotifiers()
      .filter((notifier) => !sentProviders.has(notifier.name));
    if (pendingProviders.length === 0) {
      return;
    }

    const events = await this.history.listActivityBetween(window.start, window.end);
    if (events.length === 0) {
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
    const results = await this.dispatcher.dispatchDigest(digest, { skipProviders: sentProviders });

    for (const result of results) {
      if (result.success) {
        await this.digestLog.recordSent(window.date, result.provider, new Date());
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
