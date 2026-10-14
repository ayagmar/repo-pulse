import type { D1DatabaseLike } from './d1-types.js';

/** Stars one repository gained in a recent window and in the period before it. */
export interface StarCounts {
  repository: string;
  recent: number;
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
   * Stars gained per repository in [recentStart, end) and in [earlierStart, recentStart).
   * Leaves out repositories whose alert, `alertPrefix` plus the repository's name, could
   * not be claimed at `now`.
   */
  async countStarsOutsideCooldown(input: {
    earlierStart: Date;
    recentStart: Date;
    end: Date;
    alertPrefix: string;
    now: Date;
    limits: { cooldownMs: number; leaseMs: number };
  }): Promise<StarCounts[]> {
    const rows = await this.db
      .prepare(
        `SELECT
           events.repository AS repository,
           SUM(CASE WHEN events.received_at >= ? THEN 1 ELSE 0 END) AS recent,
           SUM(CASE WHEN events.received_at < ? THEN 1 ELSE 0 END) AS earlier
         FROM events
         LEFT JOIN radar_alerts ON radar_alerts.alert_id = ? || events.repository
         WHERE events.event_type = 'star.created'
           AND events.received_at >= ? AND events.received_at < ?
           AND (radar_alerts.alert_id IS NULL OR ${AVAILABLE})
         GROUP BY events.repository`
      )
      .bind(
        input.recentStart.toISOString(),
        input.recentStart.toISOString(),
        input.alertPrefix,
        input.earlierStart.toISOString(),
        input.end.toISOString(),
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
