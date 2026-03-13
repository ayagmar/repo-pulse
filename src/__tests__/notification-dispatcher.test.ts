import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationResult, Notifier } from '../core/interfaces/notifier.js';
import { FAILURE_CLASSIFICATIONS } from '../core/models/failure-classification.js';
import {
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
  createRepoEvent,
} from '../core/models/repo-event.js';
import type { RepoEvent } from '../core/models/repo-event.js';
import { NotificationDispatcher } from '../core/services/notification-dispatcher.js';

function createMockNotifier(
  name: string,
  configured: boolean,
  notify: Notifier['notify']
): Notifier {
  return {
    name,
    isConfigured: () => configured,
    notify,
  };
}

function createMockEvent(): RepoEvent {
  return createRepoEvent(REPO_EVENT_TYPES.STAR_CREATED, {
    action: REPO_EVENT_ACTIONS.CREATED,
    repository: {
      id: 1,
      name: 'test-repo',
      fullName: 'owner/test-repo',
      owner: 'owner',
      url: 'https://github.com/owner/test-repo',
      description: null,
      stars: 1,
      forks: 0,
      language: 'TypeScript',
    },
    sender: {
      id: 1,
      login: 'testuser',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1',
      url: 'https://github.com/testuser',
    },
    star: {
      count: 1,
    },
  });
}

describe('NotificationDispatcher', () => {
  let dispatcher: NotificationDispatcher;

  beforeEach(() => {
    dispatcher = new NotificationDispatcher();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('only adds configured notifiers', () => {
    const configured = createMockNotifier(
      'configured',
      true,
      vi
        .fn()
        .mockResolvedValue({ success: true, provider: 'configured' } satisfies NotificationResult)
    );
    const unconfigured = createMockNotifier(
      'unconfigured',
      false,
      vi
        .fn()
        .mockResolvedValue({ success: true, provider: 'unconfigured' } satisfies NotificationResult)
    );

    dispatcher.add(configured);
    dispatcher.add(unconfigured);

    const [registeredNotifier] = dispatcher.getNotifiers();

    if (registeredNotifier === undefined) {
      throw new Error('Expected one configured notifier');
    }

    expect(dispatcher.getNotifiers()).toHaveLength(1);
    expect(registeredNotifier.name).toBe('configured');
  });

  it('rejects dispatching when no notifiers are configured', async () => {
    await expect(dispatcher.dispatch(createMockEvent())).rejects.toThrow(
      'No notification providers configured'
    );
  });

  it('dispatches to all configured notifiers', async () => {
    const event = createMockEvent();
    const notifier1 = createMockNotifier(
      'notifier1',
      true,
      vi
        .fn()
        .mockResolvedValue({ success: true, provider: 'notifier1' } satisfies NotificationResult)
    );
    const notifier2 = createMockNotifier(
      'notifier2',
      true,
      vi
        .fn()
        .mockResolvedValue({ success: true, provider: 'notifier2' } satisfies NotificationResult)
    );

    dispatcher.add(notifier1);
    dispatcher.add(notifier2);

    const results = await dispatcher.dispatch(event, { deliveryId: 'delivery-1' });

    expect(results).toHaveLength(2);
    expect(notifier1.notify).toHaveBeenCalledWith(event);
    expect(notifier2.notify).toHaveBeenCalledWith(event);
  });

  it('tracks whether any notifiers are configured', () => {
    expect(dispatcher.hasNotifiers()).toBe(false);

    dispatcher.add(
      createMockNotifier(
        'test',
        true,
        vi.fn().mockResolvedValue({ success: true, provider: 'test' } satisfies NotificationResult)
      )
    );

    expect(dispatcher.hasNotifiers()).toBe(true);
  });

  it('keeps dispatching when a notifier returns a failure result', async () => {
    dispatcher.add(
      createMockNotifier(
        'success',
        true,
        vi
          .fn()
          .mockResolvedValue({ success: true, provider: 'success' } satisfies NotificationResult)
      )
    );
    dispatcher.add(
      createMockNotifier(
        'failure',
        true,
        vi.fn().mockResolvedValue({
          success: false,
          provider: 'failure',
          error: 'Test error',
          failureClassification: FAILURE_CLASSIFICATIONS.PERMANENT,
        } satisfies NotificationResult)
      )
    );

    const results = await dispatcher.dispatch(createMockEvent(), { deliveryId: 'delivery-2' });

    expect(results).toEqual([
      { success: true, provider: 'success' },
      {
        success: false,
        provider: 'failure',
        error: 'Test error',
        failureClassification: FAILURE_CLASSIFICATIONS.PERMANENT,
      },
    ]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('"message":"notifier.failed"')
    );
  });

  it('converts thrown notifier errors into failure results without aborting others', async () => {
    dispatcher.add(
      createMockNotifier('throws', true, vi.fn().mockRejectedValue(new Error('boom')))
    );
    dispatcher.add(
      createMockNotifier(
        'still-runs',
        true,
        vi.fn().mockResolvedValue({
          success: true,
          provider: 'still-runs',
        } satisfies NotificationResult)
      )
    );

    const results = await dispatcher.dispatch(createMockEvent(), { deliveryId: 'delivery-3' });
    const thrownResult = results[0];
    const successResult = results[1];

    if (thrownResult === undefined || successResult === undefined) {
      throw new Error('Expected two dispatch results');
    }

    expect(results).toHaveLength(2);
    expect(thrownResult.success).toBe(false);
    expect(thrownResult.provider).toBe('throws');
    if (thrownResult.success) {
      throw new Error('Expected thrown notifier result to be a failure');
    }
    expect(thrownResult.error).toContain('boom');
    expect(thrownResult.failureClassification).toBe(FAILURE_CLASSIFICATIONS.PERMANENT);
    expect(successResult).toEqual({ success: true, provider: 'still-runs' });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('"deliveryId":"delivery-3"')
    );
  });
});
