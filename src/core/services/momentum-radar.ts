import type { RepositoryInsights } from '../interfaces/repository-insights.js';
import type { MomentumAlert, NotableStargazer, Referrer } from '../models/momentum-alert.js';
import type { D1EventHistory } from './d1-event-history.js';
import type { D1RadarLog, StarCounts } from './d1-radar-log.js';
import { logger } from './logger.js';
import type { NotificationDispatcher } from './notification-dispatcher.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The every-minute cron checks for spikes at minutes 5, 15, 25, and so on, away from
 * the digest at the top of the hour, so both fit in one run's subrequest budget.
 */
const CHECK_INTERVAL_MINUTES = 10;
const CHECK_MINUTE = 5;

const RECENT_WINDOW_HOURS = 3;
const BASELINE_DAYS = 14;
/** A spike is at least this many stars in the recent window... */
const MIN_SPIKE_STARS = 5;
/** ...and at least this many times the stars such a window usually gets. */
const SPIKE_FACTOR = 4;
/** An alert is sent at most once in this long per repository. */
const ALERT_COOLDOWN_MS = DAY_MS;
/** A claimed alert never marked sent or released, after a crash, can be retried after this. */
const ALERT_CLAIM_LEASE_MS = 5 * 60_000;
const ALERT_LIMITS = { cooldownMs: ALERT_COOLDOWN_MS, leaseMs: ALERT_CLAIM_LEASE_MS };
const ALERT_PREFIX = 'stars:';

/** Recent stargazers whose profiles are looked up, newest first. */
const STARGAZERS_CHECKED = 20;
const NOTABLE_FOLLOWERS = 100;
const LISTED_STARGAZERS = 3;
const LISTED_REFERRERS = 3;

interface StarSpike {
  repository: string;
  recentStars: number;
  expectedStars: number;
}

function isRadarCheckDue(now: Date): boolean {
  return now.getUTCMinutes() % CHECK_INTERVAL_MINUTES === CHECK_MINUTE;
}

/**
 * Repositories gaining stars much faster than over the two weeks before, most recent
 * stars first. History shorter than two weeks makes the usual rate look lower.
 */
function findStarSpikes(counts: readonly StarCounts[]): StarSpike[] {
  const windowsInBaseline = (BASELINE_DAYS * 24) / RECENT_WINDOW_HOURS;
  return counts
    .map((count) => ({
      repository: count.repository,
      recentStars: count.recent,
      expectedStars: count.earlier / windowsInBaseline,
    }))
    .filter(
      (spike) =>
        spike.recentStars >= MIN_SPIKE_STARS &&
        spike.recentStars >= SPIKE_FACTOR * spike.expectedStars
    )
    .sort((left, right) => right.recentStars - left.recentStars);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Alerts when a repository suddenly gains stars, at most once a day per repository. */
export class MomentumRadar {
  constructor(
    private readonly history: D1EventHistory,
    private readonly radarLog: D1RadarLog,
    private readonly dispatcher: NotificationDispatcher,
    private readonly insights: RepositoryInsights | null = null
  ) {}

  async check(now: Date): Promise<void> {
    if (!(isRadarCheckDue(now) && this.dispatcher.hasNotifiers())) {
      return;
    }

    const recentStart = new Date(now.getTime() - RECENT_WINDOW_HOURS * HOUR_MS);
    const counts = await this.radarLog.countStarsOutsideCooldown({
      earlierStart: new Date(recentStart.getTime() - BASELINE_DAYS * DAY_MS),
      recentStart,
      end: now,
      alertPrefix: ALERT_PREFIX,
      now: new Date(),
      limits: ALERT_LIMITS,
    });

    for (const spike of findStarSpikes(counts)) {
      const alertId = `${ALERT_PREFIX}${spike.repository}`;
      // Claim with the current time, not the cron's scheduled time, so a late check
      // does not shorten its own lease.
      const claimedAt = await this.radarLog.claim(alertId, new Date(), ALERT_LIMITS);
      if (claimedAt === null) {
        continue;
      }

      // If this check fails before marking the alert sent or releasing it, the claim's
      // lease runs out before the next check, which retries the alert.
      const alert = await this.buildAlert(spike, now, recentStart);
      const results = await this.dispatcher.dispatchAlert(alert);
      const sent = results.some((result) => result.success);
      if (sent) {
        await this.radarLog.markSent(alertId, new Date());
      } else {
        await this.radarLog.release(alertId, claimedAt);
      }
      logger.info('radar.star_spike', {
        component: 'radar',
        repository: spike.repository,
        recentStars: spike.recentStars,
        expectedStars: spike.expectedStars,
        sent,
      });
      // One alert per check keeps the run within the Workers Free plan's 50
      // subrequests. Other spikes are sent by the next checks.
      return;
    }
  }

  private async buildAlert(spike: StarSpike, now: Date, recentStart: Date): Promise<MomentumAlert> {
    const stars = await this.history.listRecentStars(
      spike.repository,
      recentStart,
      STARGAZERS_CHECKED
    );
    return {
      repository: spike.repository,
      url: stars[0]?.repositoryUrl ?? `https://github.com/${spike.repository}`,
      detectedAt: now,
      windowHours: RECENT_WINDOW_HOURS,
      recentStars: spike.recentStars,
      expectedStars: spike.expectedStars,
      totalStars: stars[0]?.starCount ?? spike.recentStars,
      notableStargazers: await this.findNotableStargazers([
        ...new Set(stars.map((star) => star.login)),
      ]),
      referrers: await this.listTopReferrers(spike.repository),
    };
  }

  private async findNotableStargazers(logins: readonly string[]): Promise<NotableStargazer[]> {
    if (!this.insights) {
      return [];
    }

    try {
      const profiles = await this.insights.getUserProfiles(logins);
      return profiles
        .filter((profile) => profile.followers >= NOTABLE_FOLLOWERS)
        .sort((left, right) => right.followers - left.followers)
        .slice(0, LISTED_STARGAZERS);
    } catch (error) {
      logger.warn('radar.stargazer_lookup_failed', {
        component: 'radar',
        error: errorMessage(error),
      });
      return [];
    }
  }

  private async listTopReferrers(repository: string): Promise<Referrer[]> {
    if (!this.insights) {
      return [];
    }

    try {
      return (await this.insights.listTopReferrers(repository)).slice(0, LISTED_REFERRERS);
    } catch (error) {
      logger.warn('radar.referrer_lookup_failed', {
        component: 'radar',
        repository,
        error: errorMessage(error),
      });
      return [];
    }
  }
}
