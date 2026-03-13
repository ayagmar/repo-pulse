import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAILURE_CLASSIFICATIONS } from '../core/models/failure-classification.js';
import { createDiscordNotifier } from '../providers/discord/discord-notifier.js';
import { createTestRepoEvent } from './test-helpers.js';

describe('createDiscordNotifier', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when no webhook URL is configured', () => {
    expect(createDiscordNotifier(undefined)).toBeNull();
  });

  it('throws for invalid webhook URLs instead of creating a broken notifier', () => {
    expect(() => createDiscordNotifier('https://example.com/not-discord')).toThrow(
      'Invalid DISCORD_WEBHOOK_URL'
    );
  });

  it('treats Discord rate limits as transient failures and respects retry headers', async () => {
    const notifier = createDiscordNotifier('https://discord.com/api/webhooks/1/test-hook');
    if (!notifier) {
      throw new Error('Expected Discord notifier');
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('rate limited', {
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
      error: 'Discord API error: 429 rate limited',
      failureClassification: FAILURE_CLASSIFICATIONS.TRANSIENT,
      retryAfterMs: 2000,
    });
  });

  it('treats Discord 5xx responses as transient failures', async () => {
    const notifier = createDiscordNotifier('https://discord.com/api/webhooks/1/test-hook');
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
      error: 'Discord API error: 503 server error',
      failureClassification: FAILURE_CLASSIFICATIONS.TRANSIENT,
    });
  });

  it('leaves Discord 4xx validation failures as permanent', async () => {
    const notifier = createDiscordNotifier('https://discord.com/api/webhooks/1/test-hook');
    if (!notifier) {
      throw new Error('Expected Discord notifier');
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad request', { status: 400 })));

    const result = await notifier.notify(createTestRepoEvent());

    expect(result).toEqual({
      success: false,
      provider: 'discord',
      error: 'Discord API error: 400 bad request',
      failureClassification: FAILURE_CLASSIFICATIONS.PERMANENT,
    });
  });
});
