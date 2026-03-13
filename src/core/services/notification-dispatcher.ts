import type { NotificationResult, Notifier } from '../interfaces/notifier.js';
import { FAILURE_CLASSIFICATIONS } from '../models/failure-classification.js';
import type { RepoEvent } from '../models/repo-event.js';
import { logger } from './logger.js';

interface DispatchMetadata {
  deliveryId?: string;
}

/**
 * Simple dispatcher that sends events to all configured notifiers.
 * Replaces the over-engineered registry pattern.
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
   * Dispatch an event to all configured notifiers
   * @returns Results from all notification attempts
   */
  async dispatch(event: RepoEvent, metadata: DispatchMetadata = {}): Promise<NotificationResult[]> {
    if (this.notifiers.length === 0) {
      throw new Error('No notification providers configured');
    }

    const results = await Promise.all(
      this.notifiers.map(async (notifier) => {
        try {
          return {
            notifier,
            result: await notifier.notify(event),
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
          this.logFailure(entry.notifier.name, event, metadata.deliveryId, entry.result.error);
        }

        return entry.result;
      }

      const error =
        entry.reason instanceof Error
          ? (entry.reason.stack ?? entry.reason.message)
          : String(entry.reason);
      this.logFailure(entry.notifier.name, event, metadata.deliveryId, error);

      return {
        success: false,
        provider: entry.notifier.name,
        error,
        failureClassification: FAILURE_CLASSIFICATIONS.PERMANENT,
      };
    });
  }

  /**
   * Check if any notifiers are configured
   */
  hasNotifiers(): boolean {
    return this.notifiers.length > 0;
  }

  private logFailure(
    provider: string,
    event: RepoEvent,
    deliveryId: string | undefined,
    error: string | undefined
  ): void {
    logger.error('notifier.failed', {
      component: 'notification_dispatcher',
      provider,
      deliveryId,
      eventType: event.type,
      repository: event.repository.fullName,
      error: error ?? 'Unknown error',
    });
  }
}
