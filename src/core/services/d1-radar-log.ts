import type { D1DatabaseLike } from './d1-types.js';

/** Stars one repository got in a recent window, and in the period before it. */
export interface StarCounts {
  repository: string;
  /** People who starred it in the recent window. */
  recent: number;
  /** Stars it got in the period before. */
  earlier: number;
}

/** A `radar_alerts` row that can be claimed: sent long enough ago, or claimed and abandoned. */
const AVAILABLE = `(radar_alerts.sent_at IS NOT NULL AND radar_alerts.sent_at <= ?)
  OR (radar_alerts.sent_at IS NULL AND radar_alerts.claimed_at <= ?)`;

function availableBindings(now: Date, limits: { cooldownMs: number; leaseMs: number }): string[] {
  return [
    new Date(now.getTime() - limits.cooldownMs).toISOString(),
    new Date(now.getTime() - limits.leaseMs).toISOString(),
  ];
}

/** Counts stars for the momentum radar and records when each alert was last sent. */
export class D1RadarLog {
  constructor(private readonly db: D1DatabaseLike) {}

  /**
   * Repositories starred by at least `minimumRecent` people in [recentStart, end), with
   * how many people that is and how many stars they got in [earlierStart, recentStart).
   * Leaves out repositories whose alert, `alertPrefix` plus the repository's name,
   * could not be claimed at `now`. Only those candidates have their earlier stars read.
   */
  async listStarCandidates(input: {
    earlierStart: Date;
    recentStart: Date;
    end: Date;
    minimumRecent: number;
    alertPrefix: string;
    now: Date;
    limits: { cooldownMs: number; leaseMs: number };
  }): Promise<StarCounts[]> {
    const rows = await this.db
      .prepare(
        `WITH recent AS (
           SELECT
             repository,
             COUNT(DISTINCT json_extract(event_json, '$.sender.login')) AS recent
           FROM events
           WHERE event_type = 'star.created' AND received_at >= ? AND received_at < ?
           GROUP BY repository
           HAVING recent >= ?
         )
         SELECT
           recent.repository AS repository,
           recent.recent AS recent,
           (SELECT COUNT(*)
            FROM events
            WHERE events.repository = recent.repository
              AND events.event_type = 'star.created'
              AND events.received_at >= ? AND events.received_at < ?) AS earlier
         FROM recent
         LEFT JOIN radar_alerts ON radar_alerts.alert_id = ? || recent.repository
         WHERE radar_alerts.alert_id IS NULL OR ${AVAILABLE}`
      )
      .bind(
        input.recentStart.toISOString(),
        input.end.toISOString(),
        input.minimumRecent,
        input.earlierStart.toISOString(),
        input.recentStart.toISOString(),
        input.alertPrefix,
        ...availableBindings(input.now, input.limits)
      )
      .all<StarCounts>();

    return rows.results;
  }

  /**
   * Claim an alert. Fails while the alert is cooling down, `cooldownMs` after it was
   * last sent, or while another check claimed it less than `leaseMs` ago and may still
   * be posting. Returns the claim's time, which `release` takes, or null.
   */
  async claim(
    alertId: string,
    now: Date,
    limits: { cooldownMs: number; leaseMs: number }
  ): Promise<string | null> {
    const claimedAt = now.toISOString();
    const claimed = await this.db
      .prepare(
        `INSERT INTO radar_alerts (alert_id, claimed_at, sent_at)
         VALUES (?, ?, NULL)
         ON CONFLICT (alert_id) DO UPDATE
           SET claimed_at = excluded.claimed_at, sent_at = NULL
           WHERE ${AVAILABLE}
         RETURNING alert_id`
      )
      .bind(alertId, claimedAt, ...availableBindings(now, limits))
      .first<{ alert_id: string }>();

    return claimed === null ? null : claimedAt;
  }

  /**
   * Record that the alert was posted, which starts its cooldown. A check whose claim
   * another check took over still records its post.
   */
  async markSent(alertId: string, sentAt: Date): Promise<void> {
    await this.db
      .prepare('UPDATE radar_alerts SET sent_at = ? WHERE alert_id = ?')
      .bind(sentAt.toISOString(), alertId)
      .run();
  }

  /** Give up a claim whose alert was not sent, so a later check can send it. */
  async release(alertId: string, claimedAt: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM radar_alerts WHERE alert_id = ? AND claimed_at = ? AND sent_at IS NULL')
      .bind(alertId, claimedAt)
      .run();
  }
}
