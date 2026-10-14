import type { D1DatabaseLike } from './d1-types.js';

/**
 * Records which providers were sent each digest. A provider claims a digest before
 * posting it, so two overlapping cron runs cannot both post.
 */
export class D1DigestLog {
  constructor(private readonly db: D1DatabaseLike) {}

  /**
   * Claim a digest for a provider. Returns the claim's time, which `release` takes to
   * give up only this claim. Returns null when the provider was
   * already sent the digest, or another run claimed it less than `leaseMs` ago and
   * may still be posting.
   */
  async claim(
    digestId: string,
    provider: string,
    now: Date,
    leaseMs: number
  ): Promise<string | null> {
    const claimedAt = now.toISOString();
    const claimed = await this.db
      .prepare(
        `INSERT INTO digest_sends (digest_id, provider_name, claimed_at, sent_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT (digest_id, provider_name) DO UPDATE
           SET claimed_at = excluded.claimed_at
           WHERE digest_sends.sent_at IS NULL AND digest_sends.claimed_at <= ?
         RETURNING provider_name`
      )
      .bind(digestId, provider, claimedAt, new Date(now.getTime() - leaseMs).toISOString())
      .first<{ provider_name: string }>();

    return claimed === null ? null : claimedAt;
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
