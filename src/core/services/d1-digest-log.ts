import type { D1DatabaseLike } from './d1-types.js';

/**
 * Records which providers were sent each digest. A provider claims a digest before
 * posting it, so two overlapping cron runs cannot both post.
 */
export class D1DigestLog {
  constructor(private readonly db: D1DatabaseLike) {}

  /**
   * Claim a digest for a provider. Fails when the provider was already sent it, or
   * another run claimed it less than `leaseMs` ago and may still be posting.
   */
  async claim(digestId: string, provider: string, now: Date, leaseMs: number): Promise<boolean> {
    const claimed = await this.db
      .prepare(
        `INSERT INTO digest_sends (digest_id, provider_name, claimed_at, sent_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT (digest_id, provider_name) DO UPDATE
           SET claimed_at = excluded.claimed_at
           WHERE digest_sends.sent_at IS NULL AND digest_sends.claimed_at <= ?
         RETURNING provider_name`
      )
      .bind(digestId, provider, now.toISOString(), new Date(now.getTime() - leaseMs).toISOString())
      .first<{ provider_name: string }>();

    return claimed !== null;
  }

  async markSent(digestId: string, provider: string, sentAt: Date): Promise<void> {
    await this.db
      .prepare('UPDATE digest_sends SET sent_at = ? WHERE digest_id = ? AND provider_name = ?')
      .bind(sentAt.toISOString(), digestId, provider)
      .run();
  }

  /** Give up a claim that was not sent, so the next run can retry it. */
  async release(digestId: string, provider: string): Promise<void> {
    await this.db
      .prepare(
        'DELETE FROM digest_sends WHERE digest_id = ? AND provider_name = ? AND sent_at IS NULL'
      )
      .bind(digestId, provider)
      .run();
  }
}
