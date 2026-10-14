import type { Digest } from '../models/digest.js';
import type { FailureClassification } from '../models/failure-classification.js';
import type { MomentumAlert } from '../models/momentum-alert.js';
import type { RepoEvent } from '../models/repo-event.js';

/**
 * Result of a notification attempt
 */
interface NotificationSuccessResult {
  success: true;
  provider: string;
}

export interface NotificationFailureResult {
  success: false;
  provider: string;
  error: string;
  failureClassification: FailureClassification;
  retryAfterMs?: number;
}

export type NotificationResult = NotificationSuccessResult | NotificationFailureResult;

/**
 * Interface for notification providers.
 * Implementations handle formatting and delivery to specific platforms.
 */
export interface Notifier {
  readonly name: string;

  /**
   * Check if this notifier is properly configured and ready to send
   */
  isConfigured(): boolean;

  /**
   * Send a notification for the given repository event
   */
  notify(event: RepoEvent): Promise<NotificationResult>;

  /**
   * Send a daily or weekly summary of recorded events
   */
  notifyDigest(digest: Digest): Promise<NotificationResult>;

  /**
   * Send an alert that a repository is gaining stars unusually fast
   */
  notifyAlert(alert: MomentumAlert): Promise<NotificationResult>;
}
