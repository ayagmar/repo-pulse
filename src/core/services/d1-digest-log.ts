import type { D1DatabaseLike } from './d1-types.js';

const RECENT_RECOVERY_MS = 20 * 60_000;

/**
 * Records which providers were sent each digest. A provider claims a digest before
 * posting it, so two overlapping cron runs cannot both post.
 */
export class D1DigestLog {
  constructor(private readonly db: D1DatabaseLike) {}

  /**
   * Claim a digest for a provider. Returns the claim's time, which `release` takes to
   * give up only this claim. Returns null when the provider was
   * already sent the digest, another run still has the send lease, or a catch-up
   * is waiting for webhook recovery. Waiting does not start the send lease.
   */
  async claim(
    digestId: string,
    provider: string,
    now: Date,
    leaseMs: number,
    recoveryGraceMs = 0
  ): Promise<string | null> {
    const claimedAt = now.toISOString();
    const claimed = await this.db
      .prepare(
        `WITH input(digest_id, provider_name, claimed_at, now_ms, recent_since, wait_since) AS (VALUES (?, ?, ?, ?, ?, ?)),
         readiness AS MATERIALIZED (
           SELECT input.*, CASE WHEN recent_since IS NOT NULL AND previous.retry_at IS NULL AND (
             EXISTS (SELECT 1 FROM webhook_recovery_attempts WHERE last_requested_at > recent_since)
             OR (previous.recovery_wait_at IS NULL OR (
               previous.recovery_wait_at > wait_since AND NOT EXISTS (
                 SELECT 1 FROM webhook_recovery_scan WHERE singleton = 1
                   AND completed_walk_started_at > previous.recovery_wait_at
               )
             ))
           ) THEN COALESCE(previous.recovery_wait_at, now_ms) END AS wait_at
           FROM input LEFT JOIN digest_sends AS previous USING (digest_id, provider_name)
         )
         INSERT INTO digest_sends (digest_id, provider_name, claimed_at, recovery_wait_at)
         SELECT digest_id, provider_name, claimed_at, wait_at FROM readiness WHERE true
         ON CONFLICT (digest_id, provider_name) DO UPDATE
           SET claimed_at = excluded.claimed_at, recovery_wait_at = excluded.recovery_wait_at, retry_at = NULL
           WHERE digest_sends.sent_at IS NULL AND (
             (digest_sends.recovery_wait_at IS NOT NULL AND excluded.recovery_wait_at IS NULL)
             OR CASE WHEN digest_sends.retry_at IS NOT NULL THEN digest_sends.retry_at <= (SELECT now_ms FROM input)
                     ELSE digest_sends.recovery_wait_at IS NULL AND digest_sends.claimed_at <= ? END
           )
         RETURNING recovery_wait_at AS waitAt`
      )
      .bind(
        digestId,
        provider,
        claimedAt,
        now.getTime(),
        recoveryGraceMs > 0 ? now.getTime() - RECENT_RECOVERY_MS : null,
        now.getTime() - recoveryGraceMs,
        new Date(now.getTime() - leaseMs).toISOString()
      )
      .first<{ waitAt: number | null }>();

    return claimed?.waitAt === null ? claimedAt : null;
  }

  /**
   * Record that the digest was posted. A run whose claim another run took over still
   * records its post, so the other run cannot release the claim and cause a repeat.
   */
  async markSent(digestId: string, provider: string, sentAt: Date): Promise<void> {
    await this.db
      .prepare('UPDATE digest_sends SET sent_at = ? WHERE digest_id = ? AND provider_name = ?')
      .bind(sentAt.toISOString(), digestId, provider)
      .run();
  }

  /** Keep a short retry deadline for a definite transient rejection, without reopening recovery grace. */
  async defer(
    digestId: string,
    provider: string,
    claimedAt: string,
    retryAt: number
  ): Promise<void> {
    await this.db
      .prepare(`UPDATE digest_sends SET retry_at = ?
      WHERE digest_id = ? AND provider_name = ? AND claimed_at = ? AND sent_at IS NULL`)
      .bind(retryAt, digestId, provider, claimedAt)
      .run();
  }

  /**
   * Give up a claim that was not sent, so the next run can retry it. A claim another
   * run took over after the lease ran out is left alone.
   */
  async release(digestId: string, provider: string, claimedAt: string): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM digest_sends
         WHERE digest_id = ? AND provider_name = ? AND claimed_at = ? AND sent_at IS NULL`
      )
      .bind(digestId, provider, claimedAt)
      .run();
  }
}
