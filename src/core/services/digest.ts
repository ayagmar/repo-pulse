import type { RepositoryInsights } from '../interfaces/repository-insights.js';
import type {
  Digest,
  DigestPeriod,
  PersonActivity,
  RepositoryActivity,
  ResponseTimes,
  UnreleasedWork,
  WaitingThread,
} from '../models/digest.js';
import { REPO_EVENT_TYPES } from '../models/repo-event.js';
import type { D1DigestLog } from './d1-digest-log.js';
import type { D1EventHistory, EventActivity, ThreadActivityMaterial } from './d1-event-history.js';
import { logger } from './logger.js';
import type { NotificationDispatcher } from './notification-dispatcher.js';
import { isBotLogin, isOutsidePerson } from './people.js';
import { summarizeThreadActivity } from './thread-activity.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Space out replays of an ambiguous send, even across Worker restarts. */
const DIGEST_CLAIM_LEASE_MS = 60 * MINUTE_MS;
const ON_TIME_MS = 10 * MINUTE_MS;
const RECOVERY_GRACE_MS = 20 * MINUTE_MS;
const RECOVERY_CUTOFF_MS = 60 * MINUTE_MS;

const MONDAY = 1;

/** The daily digest checks repositories active this recently for unreleased work. */
const UNRELEASED_LOOKBACK_MS = 30 * DAY_MS;
const UNRELEASED_MAX_REPOSITORIES = 20;

/**
 * The waiting list and response times read the events of the threads active this
 * recently: at most this many threads, events per thread and rows. A wait whose thread
 * had no event in the lookback is not listed, nor one whose thread has more events.
 */
const THREAD_LOOKBACK_MS = 90 * DAY_MS;
const THREAD_LIMITS = { threads: 200, eventsPerThread: 100, rows: 2000 };

/** The weekly digest lists this many of the week's most active outside people. */
const LISTED_PEOPLE = 5;

interface DigestWindow {
  period: DigestPeriod;
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

function shiftDate(date: string, days: number): string {
  const [year, month, day] = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function weekday(date: string): number {
  const [year, month, day] = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * The digest of `period` due at `now`, or null when none is. A daily digest covers the
 * day up to the digest hour, from that hour on the previous local day; a weekly digest,
 * due on Mondays, covers the seven days before. Both ends come from the same local-hour
 * instant, so consecutive digests meet exactly, even across a clock change.
 */
export function dueDigestWindow(
  now: Date,
  timeZone: string,
  hour: number,
  period: DigestPeriod = 'daily'
): DigestWindow | null {
  const today = localDateTime(now, timeZone).date;
  // A digest hour skipped by a clock change can move into the next local day, as 23:00
  // does in America/Nuuk each March, so yesterday's digest may be the one due.
  for (const date of [today, shiftDate(today, -1)]) {
    if (period === 'weekly' && weekday(date) !== MONDAY) {
      continue;
    }
    const end = localHourInstant(date, hour, timeZone);
    if (now >= end && (date === today || localDateTime(end, timeZone).date === today)) {
      const startDate = shiftDate(date, period === 'weekly' ? -7 : -1);
      return { period, date, start: localHourInstant(startDate, hour, timeZone), end };
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
    pullRequestsOpenedByBots: 0,
    pullRequestsMerged: [],
    issuesOpened: 0,
    issuesClosed: 0,
    releases: [],
  };
}

/** The author is the pull request's, not whoever acted on it, when the event recorded it. */
function openedByBot(event: EventActivity): boolean {
  return isBotLogin(event.pullRequestAuthor ?? event.senderLogin ?? '');
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
        if (openedByBot(event)) {
          activity.pullRequestsOpenedByBots += 1;
        }
        break;
      case REPO_EVENT_TYPES.PULL_REQUEST_MERGED:
        if (
          event.pullRequestNumber !== null &&
          event.pullRequestTitle !== null &&
          event.pullRequestUrl !== null
        ) {
          activity.pullRequestsMerged.push({
            number: event.pullRequestNumber,
            title: event.pullRequestTitle,
            url: event.pullRequestUrl,
            byBot: openedByBot(event),
          });
        }
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

interface WindowPerson {
  senderId: number;
  login: string;
  url: string;
  events: number;
  repositories: Set<string>;
}

/**
 * The window's most active outside people: most repositories, then most events, then
 * lowest sender id. Events are oldest first, so each keeps the latest login seen.
 */
function mostActivePeople(
  events: readonly EventActivity[],
  ignoredLogins: ReadonlySet<string>
): WindowPerson[] {
  const bySender = new Map<number, WindowPerson>();
  for (const event of events) {
    if (
      event.senderId === null ||
      !isOutsidePerson(
        { id: event.senderId, login: event.senderLogin },
        event.repositoryOwner,
        ignoredLogins
      )
    ) {
      continue;
    }
    const person = bySender.get(event.senderId) ?? {
      senderId: event.senderId,
      login: '',
      url: '',
      events: 0,
      repositories: new Set<string>(),
    };
    bySender.set(event.senderId, person);
    person.login = event.senderLogin ?? person.login;
    person.url = event.senderUrl ?? person.url;
    person.events += 1;
    person.repositories.add(event.repository);
  }

  return [...bySender.values()]
    .sort(
      (left, right) =>
        right.repositories.size - left.repositories.size ||
        right.events - left.events ||
        left.senderId - right.senderId
    )
    .slice(0, LISTED_PEOPLE);
}

const PERIODS: readonly DigestPeriod[] = ['daily', 'weekly'];

export class DigestSender {
  /**
   * The thread read per digest end. On Mondays the daily and weekly digests end at the
   * same instant, so they share one read.
   */
  private readonly threadReads = new Map<number, Promise<ThreadActivityMaterial>>();

  constructor(
    private readonly history: D1EventHistory,
    private readonly digestLog: D1DigestLog,
    private readonly dispatcher: NotificationDispatcher,
    private readonly options: {
      timeZone: string;
      hour: number;
      ignoredLogins: ReadonlySet<string>;
    },
    private readonly insights: RepositoryInsights | null = null
  ) {}

  /** Send each digest still due when its turn comes. */
  async sendDueDigests(clock: () => Date): Promise<void> {
    if (!this.dispatcher.hasNotifiers()) {
      return;
    }

    const errors: unknown[] = [];
    for (const period of PERIODS) {
      try {
        await this.sendDigest(period, clock);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Digests could not finish');
  }

  /** Unreleased work in recently active repositories, or none when GitHub cannot say. */
  private async listUnreleasedWork(end: Date): Promise<UnreleasedWork[]> {
    if (!this.insights) {
      return [];
    }

    try {
      const repositories = await this.history.listActiveRepositories(
        new Date(end.getTime() - UNRELEASED_LOOKBACK_MS),
        UNRELEASED_MAX_REPOSITORIES
      );
      return await this.insights.listUnreleasedWork(repositories);
    } catch (error) {
      logger.warn('digest.unreleased_work_failed', {
        component: 'digest',
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * The window's most active outside people, each marked new when first seen inside the
   * window, or none when their first-seen times cannot be read.
   */
  private async listPeople(
    events: readonly EventActivity[],
    window: DigestWindow
  ): Promise<PersonActivity[]> {
    const people = mostActivePeople(events, this.options.ignoredLogins);
    if (people.length === 0) {
      return [];
    }

    try {
      const firstSeen = await this.history.readFirstSeen(people.map((person) => person.senderId));
      return people.map((person) => ({
        login: person.login,
        url: person.url,
        events: person.events,
        repositories: person.repositories.size,
        isNew: (firstSeen.get(person.senderId)?.getTime() ?? 0) >= window.start.getTime(),
      }));
    } catch {
      // No exception text: D1 errors can quote bound values.
      logger.warn('people.digest_read_failed', { component: 'digest' });
      return [];
    }
  }

  /**
   * Who is waiting on the owner's side, and on weekly digests the window's response
   * times, or null when the threads cannot be read.
   */
  private async readThreads(
    window: DigestWindow
  ): Promise<{ waiting: WaitingThread[]; responseTimes: ResponseTimes } | null> {
    const end = window.end.getTime();
    let read = this.threadReads.get(end);
    if (read === undefined) {
      read = this.history.readThreadActivity(new Date(end - THREAD_LOOKBACK_MS), THREAD_LIMITS);
      this.threadReads.set(end, read);
    }
    try {
      const material = await read;
      const summary = summarizeThreadActivity(material, window, this.options.ignoredLogins);
      if (summary.incompleteThreads > 0 || summary.untimedThreads > 0) {
        logger.warn('thread_activity.threads_omitted', {
          component: 'digest',
          incompleteThreads: summary.incompleteThreads,
          untimedThreads: summary.untimedThreads,
        });
      }
      return summary;
    } catch {
      // No exception text: D1 errors can quote bound values.
      logger.warn('thread_activity.digest_read_failed', { component: 'digest' });
      return null;
    }
  }

  private async releaseClaims(
    digestId: string,
    claimedProviders: ReadonlyMap<string, string>
  ): Promise<void> {
    for (const [provider, claimedAt] of claimedProviders) {
      try {
        await this.digestLog.release(digestId, provider, claimedAt);
      } catch {
        // The claim stays held until its lease ends. Carry on with the other providers,
        // and keep the caller's own error. No exception text: D1 errors can quote bound
        // values.
        logger.warn('digest.release_failed', { component: 'digest', digestId, provider });
      }
    }
  }

  private async sendDigest(period: DigestPeriod, clock: () => Date): Promise<void> {
    const { timeZone, hour } = this.options;
    const now = clock();
    const window = dueDigestWindow(now, timeZone, hour, period);
    if (window === null) return;
    const digestId = `${period}:${window.date}`;
    const catchUp = now.getTime() - window.end.getTime() > ON_TIME_MS;
    const waitForRecovery =
      catchUp &&
      now.getTime() <
        localHourInstant(shiftDate(localDateTime(now, timeZone).date, 1), 0, timeZone).getTime() -
          RECOVERY_CUTOFF_MS;
    /** Provider name to the time of its claim. */
    const claimedProviders = new Map<string, string>();
    for (const notifier of this.dispatcher.getNotifiers()) {
      // Claim with the current time, not the cron's scheduled time. A late run must not
      // backdate its claim, or its lease would end early and an on-time run could post
      // the digest again.
      const claimedAt = await this.digestLog.claim(
        digestId,
        notifier.name,
        now,
        DIGEST_CLAIM_LEASE_MS,
        waitForRecovery ? RECOVERY_GRACE_MS : 0
      );
      if (claimedAt !== null) {
        claimedProviders.set(notifier.name, claimedAt);
      }
    }
    if (claimedProviders.size === 0) {
      return;
    }

    let events: EventActivity[];
    try {
      events = await this.history.listActivityBetween(window.start, window.end);
    } catch (error) {
      // Nothing was posted: give the claims up so the next minute retries, instead of
      // holding them for the lease while the digest window runs out.
      await this.releaseClaims(digestId, claimedProviders);
      throw error;
    }
    const threads = await this.readThreads(window);
    const waiting = threads?.waiting ?? [];
    const responseTimes = window.period === 'weekly' ? (threads?.responseTimes ?? null) : null;
    const hasResponseTimes =
      responseTimes !== null && (responseTimes.merge !== null || responseTimes.firstReply !== null);
    if (events.length === 0 && waiting.length === 0 && !hasResponseTimes) {
      // A truly empty window does not need to be read every minute. Keep it eligible
      // after the lease in case recovery fills it; a failed thread read retries sooner.
      if (threads === null) await this.releaseClaims(digestId, claimedProviders);
      return;
    }

    const digest: Digest = {
      period: window.period,
      date: window.date,
      timeZone: this.options.timeZone,
      windowStart: window.start,
      windowEnd: window.end,
      eventCount: events.length,
      repositories: summarizeRepositories(events),
      unreleased: window.period === 'daily' ? await this.listUnreleasedWork(window.end) : [],
      people: window.period === 'weekly' ? await this.listPeople(events, window) : [],
      waiting,
      responseTimes,
    };
    const unclaimedProviders = new Set(
      this.dispatcher
        .getNotifiers()
        .map((notifier) => notifier.name)
        .filter((name) => !claimedProviders.has(name))
    );
    if (dueDigestWindow(clock(), timeZone, hour, period)?.date !== window.date) {
      await this.releaseClaims(digestId, claimedProviders);
      return;
    }
    const results = await this.dispatcher.dispatchDigest(digest, {
      skipProviders: unclaimedProviders,
    });

    const outcomeErrors: unknown[] = [];
    for (const result of results) {
      const claimedAt = claimedProviders.get(result.provider);
      if (claimedAt === undefined) {
        continue;
      }
      try {
        if (result.success) {
          const sentAt = new Date();
          try {
            await this.digestLog.markSent(digestId, result.provider, sentAt);
          } catch {
            await this.digestLog.markSent(digestId, result.provider, sentAt);
          }
        } else if (
          result.acceptanceUnknown !== true &&
          clock().getTime() - window.end.getTime() < ON_TIME_MS
        ) {
          // Only a definite rejection in the first ten minutes is worth retrying next tick.
          await this.releaseClaims(digestId, new Map([[result.provider, claimedAt]]));
        }
      } catch (error) {
        outcomeErrors.push(error);
      }
    }
    if (outcomeErrors.length > 0)
      throw new AggregateError(outcomeErrors, 'Digest outcome not recorded');

    logger.info('digest.dispatched', {
      component: 'digest',
      digestId,
      eventCount: digest.eventCount,
      waitingCount: waiting.length,
      succeeded: results.filter((result) => result.success).map((result) => result.provider),
      failed: results.filter((result) => !result.success).map((result) => result.provider),
    });
  }
}
