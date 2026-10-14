import type { NotificationResult, Notifier } from '../interfaces/notifier.js';
import type { Digest } from '../models/digest.js';
import { FAILURE_CLASSIFICATIONS } from '../models/failure-classification.js';
import type { RepoEvent } from '../models/repo-event.js';
import { logger } from './logger.js';

interface DispatchMetadata {
  deliveryId?: string;
  skipProviders?: ReadonlySet<string>;
}

/**
 * Simple dispatcher that sends events to all configured notifiers.
 */
export class NotificationDispatcher {
  private readonly notifiers: Notifier[] = [];

  /**
   * Add a notifier to the dispatcher
   */
  add(notifier: Notifier): void {
    if (notifier.isConfigured()) {
      this.notifiers.push(notifier);
    }
  }

  /**
   * Get all configured notifiers
   */
  getNotifiers(): readonly Notifier[] {
    return this.notifiers;
  }

  /**
   * Dispatch an event to every configured notifier not in `skipProviders`
   * @returns Results from the notification attempts made
   */
  dispatch(event: RepoEvent, metadata: DispatchMetadata = {}): Promise<NotificationResult[]> {
    return this.sendToEach(metadata.skipProviders, (notifier) => notifier.notify(event), {
      deliveryId: metadata.deliveryId,
      eventType: event.type,
      repository: event.repository.fullName,
    });
  }

  /**
   * Dispatch a daily digest to every configured notifier not in `skipProviders`
   * @returns Results from the notification attempts made
   */
  dispatchDigest(
    digest: Digest,
    metadata: Pick<DispatchMetadata, 'skipProviders'> = {}
  ): Promise<NotificationResult[]> {
    return this.sendToEach(metadata.skipProviders, (notifier) => notifier.notifyDigest(digest), {
      digestDate: digest.date,
    });
  }

  /**
   * Check if any notifiers are configured
   */
  hasNotifiers(): boolean {
    return this.notifiers.length > 0;
  }

  private async sendToEach(
    skipProviders: ReadonlySet<string> | undefined,
    send: (notifier: Notifier) => Promise<NotificationResult>,
    logFields: Record<string, unknown>
  ): Promise<NotificationResult[]> {
    if (this.notifiers.length === 0) {
      throw new Error('No notification providers configured');
    }

    const notifiers = this.notifiers.filter(
      (notifier) => skipProviders?.has(notifier.name) !== true
    );
    const results = await Promise.all(
      notifiers.map(async (notifier) => {
        try {
          return {
            notifier,
            result: await send(notifier),
          } as const;
        } catch (reason) {
          return {
            notifier,
            reason,
          } as const;
        }
      })
    );

    return results.map((entry) => {
      if ('result' in entry) {
        if (!entry.result.success) {
          this.logFailure(entry.notifier.name, logFields, entry.result.error);
        }

        return entry.result;
      }

      const error =
        entry.reason instanceof Error
          ? (entry.reason.stack ?? entry.reason.message)
          : String(entry.reason);
      this.logFailure(entry.notifier.name, logFields, error);

      return {
        success: false,
        provider: entry.notifier.name,
        error,
        failureClassification: FAILURE_CLASSIFICATIONS.PERMANENT,
      };
    });
  }

  private logFailure(provider: string, logFields: Record<string, unknown>, error: string): void {
    logger.error('notifier.failed', {
      component: 'notification_dispatcher',
      provider,
      ...logFields,
      error,
    });
  }
}
