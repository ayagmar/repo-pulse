/** What a Discord alert's buttons can do to an issue. Both are idempotent on GitHub. */
export type IssueActionKind = 'close' | 'label';

/** The latest attempt at one action on one alert. */
export interface IssueActionOutcome {
  action: IssueActionKind;
  succeeded: boolean;
  /** The label names added, comma-separated, or GitHub's error. Empty for a close. */
  detail: string;
  discordUserId: string;
}
