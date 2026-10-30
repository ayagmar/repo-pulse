import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAILURE_CLASSIFICATIONS } from '../core/models/failure-classification.js';
import { Redactor } from '../core/security/redact.js';
import { createDiscordNotifier } from '../providers/discord/discord-notifier.js';
import { createTestRepoEvent } from './test-helpers.js';

describe('createDiscordNotifier', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns null when no webhook URL is configured', () => {
    expect(createDiscordNotifier(undefined, new Redactor([]))).toBeNull();
  });

  it('throws for invalid webhook URLs instead of creating a broken notifier', () => {
    expect(() =>
      createDiscordNotifier('https://example.com/not-discord', new Redactor([]))
    ).toThrow('Invalid DISCORD_WEBHOOK_URL');
  });

  it('treats Discord rate limits as transient failures and respects retry headers', async () => {
    const notifier = createDiscordNotifier(
      'https://discord.com/api/webhooks/1/test-hook',
      new Redactor([])
    );
    if (!notifier) {
      throw new Error('Expected Discord notifier');
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'You are being rate limited.' }), {
          status: 429,
          headers: {
            'Retry-After': '2',
          },
        })
      )
    );

    const result = await notifier.notify(createTestRepoEvent());

    expect(result).toEqual({
      success: false,
      provider: 'discord',
      error: 'Discord request failed with 429: You are being rate limited.',
      failureClassification: FAILURE_CLASSIFICATIONS.TRANSIENT,
      retryAfterMs: 2000,
    });
  });

  it('treats Discord 5xx responses as transient failures', async () => {
    const notifier = createDiscordNotifier(
      'https://discord.com/api/webhooks/1/test-hook',
      new Redactor([])
    );
    if (!notifier) {
      throw new Error('Expected Discord notifier');
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('server error', { status: 503 }))
    );

    const result = await notifier.notify(createTestRepoEvent());

    expect(result).toEqual({
      success: false,
      provider: 'discord',
      error: 'Discord request failed with 503',
      failureClassification: FAILURE_CLASSIFICATIONS.TRANSIENT,
    });
  });

  it('classifies a timed-out Discord request as retryable', async () => {
    const notifier = createDiscordNotifier(
      'https://discord.com/api/webhooks/1/test-hook',
      new Redactor([])
    );
    if (!notifier) throw new Error('Expected Discord notifier');
    // Control the clock at the timeout API boundary; never wait ten seconds or use the network.
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('Timed out', 'TimeoutError'));
            });
          })
      )
    );
    const pending = notifier.notify(createTestRepoEvent());
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      success: false,
      failureClassification: FAILURE_CLASSIFICATIONS.TRANSIENT,
      error: 'Discord request failed: timeout',
    });
  });

  it('leaves Discord 4xx validation failures as permanent', async () => {
    const notifier = createDiscordNotifier(
      'https://discord.com/api/webhooks/1/test-hook',
      new Redactor([])
    );
    if (!notifier) {
      throw new Error('Expected Discord notifier');
    }

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ message: 'Invalid Form Body', code: 50035 }, { status: 400 })
        )
    );

    const result = await notifier.notify(createTestRepoEvent());

    expect(result).toEqual({
      success: false,
      provider: 'discord',
      error: 'Discord request failed with 400: Invalid Form Body',
      failureClassification: FAILURE_CLASSIFICATIONS.PERMANENT,
    });
  });
});
