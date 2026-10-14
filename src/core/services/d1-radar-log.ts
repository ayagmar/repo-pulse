import type { D1DatabaseLike } from './d1-types.js';

/** Stars one repository gained in a recent window and in the period before it. */
export interface StarCounts {
  repository: string;
  recent: number;
  earlier: number;
}

/** Counts stars for the momentum radar and records when each alert was last sent. */
export class D1RadarLog {
  constructor(private readonly db: D1DatabaseLike) {}

  /**
   * Stars gained per repository in [recentStart, end) and in [earlierStart, recentStart).
   * Leaves out repositories whose alert, `alertPrefix` plus the repository's name, was
   * sent after `cooldownEnd`.
   */
  async countStarsOutsideCooldown(input: {
    earlierStart: Date;
    recentStart: Date;
    end: Date;
    alertPrefix: string;
    cooldownEnd: Date;
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
           AND (radar_alerts.alerted_at IS NULL OR radar_alerts.alerted_at <= ?)
         GROUP BY events.repository`
      )
      .bind(
        input.recentStart.toISOString(),
        input.recentStart.toISOString(),
        input.alertPrefix,
        input.earlierStart.toISOString(),
        input.end.toISOString(),
        input.cooldownEnd.toISOString()
      )
      .all<StarCounts>();

    return rows.results;
  }

  /**
   * Claim an alert unless it was sent less than `cooldownMs` ago. Returns the claim's
   * time, which `release` takes, or null when the alert is cooling down.
   */
  async claim(alertId: string, now: Date, cooldownMs: number): Promise<string | null> {
    const alertedAt = now.toISOString();
    const claimed = await this.db
      .prepare(
        `INSERT INTO radar_alerts (alert_id, alerted_at)
         VALUES (?, ?)
         ON CONFLICT (alert_id) DO UPDATE
           SET alerted_at = excluded.alerted_at
           WHERE radar_alerts.alerted_at <= ?
         RETURNING alert_id`
      )
      .bind(alertId, alertedAt, new Date(now.getTime() - cooldownMs).toISOString())
      .first<{ alert_id: string }>();

    return claimed === null ? null : alertedAt;
  }

  /** Give up a claim whose alert was not sent, so a later check can send it. */
  async release(alertId: string, alertedAt: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM radar_alerts WHERE alert_id = ? AND alerted_at = ?')
      .bind(alertId, alertedAt)
      .run();
  }
}
