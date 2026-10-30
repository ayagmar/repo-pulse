import type { IssueActionKind, IssueActionOutcome } from '../models/issue-action.js';
import type { D1DatabaseLike } from './d1-types.js';

interface OutcomeRow {
  action: IssueActionKind;
  outcome: 'succeeded' | 'failed';
  detail: string;
  discordUserId: string;
}

/**
 * Discord interactions taken up, and the outcome of each action taken from an alert.
 * Nothing is claimed before the GitHub call, so nothing can be left stuck: both
 * actions are idempotent, and a crash leaves at worst a missing receipt.
 */
export class D1DiscordActions {
  constructor(private readonly db: D1DatabaseLike) {}

  /** Records an interaction id; false when it was recorded before, so a replay does nothing. */
  async takeInteraction(interactionId: string, receivedAt: Date): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO discord_interactions (interaction_id, received_at)
         VALUES (?, ?)`
      )
      .bind(interactionId, receivedAt.toISOString())
      .run();
    return result.meta.changes === 1;
  }

  /** Replaces the action's previous outcome on this alert. */
  async recordOutcome(
    deliveryId: string,
    outcome: IssueActionOutcome,
    finishedAt: Date
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO discord_actions (
           delivery_id, action, outcome, detail, discord_user_id, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (delivery_id, action) DO UPDATE SET
           outcome = excluded.outcome,
           detail = excluded.detail,
           discord_user_id = excluded.discord_user_id,
           finished_at = excluded.finished_at`
      )
      .bind(
        deliveryId,
        outcome.action,
        outcome.succeeded ? 'succeeded' : 'failed',
        outcome.detail,
        outcome.discordUserId,
        finishedAt.toISOString()
      )
      .run();
  }

  /** Every action's latest outcome on this alert, close first. */
  async listOutcomes(deliveryId: string): Promise<IssueActionOutcome[]> {
    const rows = await this.db
      .prepare(
        `SELECT action, outcome, detail, discord_user_id AS discordUserId
         FROM discord_actions
         WHERE delivery_id = ?
         ORDER BY action ASC`
      )
      .bind(deliveryId)
      .all<OutcomeRow>();
    return rows.results.map((row) => ({
      action: row.action,
      succeeded: row.outcome === 'succeeded',
      detail: row.detail,
      discordUserId: row.discordUserId,
    }));
  }
}
