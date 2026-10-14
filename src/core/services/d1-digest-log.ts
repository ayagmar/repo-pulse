import type { D1DatabaseLike } from './d1-types.js';

/** Records which providers accepted each day's digest, so it is sent once. */
export class D1DigestLog {
  constructor(private readonly db: D1DatabaseLike) {}

  async listSentProviders(digestDate: string): Promise<Set<string>> {
    const rows = await this.db
      .prepare('SELECT provider_name AS provider FROM digest_sends WHERE digest_date = ?')
      .bind(digestDate)
      .all<{ provider: string }>();

    return new Set(rows.results.map((row) => row.provider));
  }

  async recordSent(digestDate: string, provider: string, sentAt: Date): Promise<void> {
    await this.db
      .prepare(
        'INSERT OR IGNORE INTO digest_sends (digest_date, provider_name, sent_at) VALUES (?, ?, ?)'
      )
      .bind(digestDate, provider, sentAt.toISOString())
      .run();
  }
}
