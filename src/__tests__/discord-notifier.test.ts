import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Digest } from '../core/models/digest.js';
import { FAILURE_CLASSIFICATIONS } from '../core/models/failure-classification.js';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
} from '../core/models/repo-event.js';
import { Redactor } from '../core/security/redact.js';
import { createDiscordNotifier } from '../providers/discord/discord-notifier.js';
import { formatDiscordDigest, formatDiscordEmbed } from '../providers/discord/embed-formatter.js';
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
      'https://discord.com/api/webhooks/0/test-only',
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
      'https://discord.com/api/webhooks/0/test-only',
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
      'https://discord.com/api/webhooks/0/test-only',
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
      'https://discord.com/api/webhooks/0/test-only',
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

  describe('issue actions', () => {
    const webhookUrl = 'https://discord.com/api/webhooks/0/test-only';
    const deliveryId = '0b5a3a0e-1f6b-4c49-9d3c-6f2b0a1d2e3f';
    const star = createTestRepoEvent();
    const issue = createRepoEvent(REPO_EVENT_TYPES.ISSUE_OPENED, {
      action: REPO_EVENT_ACTIONS.OPENED,
      repository: star.repository,
      sender: star.sender,
      issue: {
        number: 12,
        title: 'Crash on start',
        url: 'https://github.com/myorg/repo/issues/12',
        state: 'open',
        body: null,
        labels: [],
      },
    });
    const pullRequest = createRepoEvent(REPO_EVENT_TYPES.PULL_REQUEST_OPENED, {
      action: REPO_EVENT_ACTIONS.OPENED,
      repository: star.repository,
      sender: star.sender,
      pullRequest: {
        number: 3,
        title: 'Fix it',
        url: 'https://github.com/myorg/repo/pull/3',
        state: 'open',
        merged: false,
        draft: false,
        body: null,
        headBranch: 'fix',
        baseBranch: 'main',
      },
    });
    const digest: Digest = {
      period: 'daily',
      date: '2026-10-30',
      windowStart: new Date('2026-10-29T09:00:00.000Z'),
      windowEnd: new Date('2026-10-30T09:00:00.000Z'),
      timeZone: 'UTC',
      eventCount: 0,
      repositories: [],
      unreleased: [],
      people: [],
    };
    const sender = { username: 'Repo Pulse', avatar_url: expect.any(String) as string };

    function posts(): { url: string; body: unknown }[] {
      return vi.mocked(fetch).mock.calls.map(([url, init]) => ({
        url: url as string,
        body: JSON.parse(init?.body as string) as unknown,
      }));
    }

    it('posts exactly the plain payloads while actions are off', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
      const notifier = createDiscordNotifier(webhookUrl, new Redactor([]));

      await notifier?.notify(issue, deliveryId);

      expect(posts()).toEqual([
        { url: webhookUrl, body: { ...formatDiscordEmbed(issue), ...sender } },
      ]);
    });

    it('adds Close and Label to issue-opened alerts only, asking Discord to keep them', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
      const notifier = createDiscordNotifier(webhookUrl, new Redactor([]), { actions: true });

      await notifier?.notify(issue, deliveryId);
      await notifier?.notify(issue, 'not-a-guid');
      await notifier?.notify(pullRequest, deliveryId);
      await notifier?.notify(star, deliveryId);
      await notifier?.notifyDigest(digest);

      expect(posts()).toEqual([
        {
          url: `${webhookUrl}?with_components=true`,
          body: {
            ...formatDiscordEmbed(issue),
            ...sender,
            components: [
              {
                type: 1,
                components: [
                  { type: 2, style: 4, label: 'Close', custom_id: `v1:close:${deliveryId}` },
                  { type: 2, style: 2, label: 'Label…', custom_id: `v1:label:${deliveryId}` },
                ],
              },
            ],
          },
        },
        { url: webhookUrl, body: { ...formatDiscordEmbed(issue), ...sender } },
        { url: webhookUrl, body: { ...formatDiscordEmbed(pullRequest), ...sender } },
        { url: webhookUrl, body: { ...formatDiscordEmbed(star), ...sender } },
        { url: webhookUrl, body: { ...formatDiscordDigest(digest), ...sender } },
      ]);
    });
  });
});
