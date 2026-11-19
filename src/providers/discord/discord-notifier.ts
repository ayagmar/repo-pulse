import type { NotificationResult, Notifier } from '../../core/interfaces/notifier.js';
import type { Digest } from '../../core/models/digest.js';
import { FAILURE_CLASSIFICATIONS } from '../../core/models/failure-classification.js';
import type { MomentumAlert } from '../../core/models/momentum-alert.js';
import type { RepoEvent } from '../../core/models/repo-event.js';
import { type Redactor, transportFailure, upstreamFailure } from '../../core/security/redact.js';
import {
  type DiscordWebhookPayload,
  formatDiscordAlert,
  formatDiscordDigest,
  formatDiscordEmbed,
  formatDiscordEmbedWithActions,
} from './embed-formatter.js';

interface DiscordNotifierConfig {
  webhookUrl: string;
  /** Issue alerts get Close and Label buttons. Needs an application-owned webhook. */
  actions: boolean;
  username?: string;
  avatarUrl?: string;
}

function isDiscordWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://discord.com' && url.pathname.startsWith('/api/webhooks/');
  } catch {
    return false;
  }
}

function parseRetryDelayMs(headers: Headers): number | undefined {
  const retryAfterHeader = headers.get('retry-after');
  if (retryAfterHeader !== null && retryAfterHeader !== '') {
    const numericValue = Number.parseFloat(retryAfterHeader);
    if (Number.isFinite(numericValue) && numericValue >= 0) {
      return Math.ceil(numericValue * 1000);
    }

    const retryAt = Date.parse(retryAfterHeader);
    if (Number.isFinite(retryAt)) {
      return Math.max(0, retryAt - Date.now());
    }
  }

  const resetAfterHeader = headers.get('x-ratelimit-reset-after');
  if (resetAfterHeader === null || resetAfterHeader === '') {
    return undefined;
  }

  const resetAfterSeconds = Number.parseFloat(resetAfterHeader);
  if (!Number.isFinite(resetAfterSeconds) || resetAfterSeconds < 0) {
    return undefined;
  }

  return Math.ceil(resetAfterSeconds * 1000);
}

/**
 * Discord webhook notifier implementation
 */
class DiscordNotifier implements Notifier {
  readonly name = 'discord';

  constructor(
    private readonly cfg: DiscordNotifierConfig,
    private readonly redactor: Redactor
  ) {}

  isConfigured(): boolean {
    return true;
  }

  notify(event: RepoEvent, deliveryId?: string): Promise<NotificationResult> {
    return this.post(
      this.cfg.actions && deliveryId !== undefined
        ? formatDiscordEmbedWithActions(event, deliveryId)
        : formatDiscordEmbed(event)
    );
  }

  notifyDigest(digest: Digest): Promise<NotificationResult> {
    return this.post(formatDiscordDigest(digest));
  }

  notifyAlert(alert: MomentumAlert): Promise<NotificationResult> {
    return this.post(formatDiscordAlert(alert));
  }

  private webhookUrl(payload: DiscordWebhookPayload): string {
    const url = new URL(this.cfg.webhookUrl);
    url.searchParams.set('wait', 'true');
    if (payload.components !== undefined) {
      url.searchParams.set('with_components', 'true');
    }
    return url.toString();
  }

  private async post(payload: DiscordWebhookPayload): Promise<NotificationResult> {
    if (this.cfg.username !== undefined && this.cfg.username !== '') {
      payload.username = this.cfg.username;
    }
    if (this.cfg.avatarUrl !== undefined && this.cfg.avatarUrl !== '') {
      payload.avatar_url = this.cfg.avatarUrl;
    }

    let response: Response;
    try {
      response = await fetch(this.webhookUrl(payload), {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        const message: unknown = await response.json();
        if (
          typeof message === 'object' &&
          message !== null &&
          'id' in message &&
          typeof message.id === 'string' &&
          /^[1-9]\d{0,19}$/.test(message.id)
        ) {
          return { success: true, provider: this.name };
        }
        return this.unconfirmed('Discord response did not confirm a created message');
      }
    } catch (error) {
      // The exception can quote the webhook URL or response body, so only its kind is kept.
      return this.unconfirmed(
        error instanceof SyntaxError
          ? 'Discord response did not confirm a created message'
          : transportFailure('Discord request', error)
      );
    }

    const errorText = await response.text().catch(() => '');
    const error = upstreamFailure('Discord request', response.status, errorText, this.redactor);

    if (response.status === 429 || response.status >= 500) {
      const retryAfterMs = parseRetryDelayMs(response.headers);
      return {
        success: false,
        provider: this.name,
        error,
        failureClassification: FAILURE_CLASSIFICATIONS.TRANSIENT,
        // A gateway can fail after Discord saved the message but before it returned the ID.
        ...([502, 503, 504].includes(response.status) ? { acceptanceUnknown: true as const } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    }

    return {
      success: false,
      provider: this.name,
      error,
      failureClassification: FAILURE_CLASSIFICATIONS.PERMANENT,
    };
  }

  private unconfirmed(error: string): NotificationResult {
    return {
      success: false,
      provider: this.name,
      error,
      failureClassification: FAILURE_CLASSIFICATIONS.TRANSIENT,
      acceptanceUnknown: true,
    };
  }
}

/**
 * Factory function to create a Discord notifier from environment config
 */
export function createDiscordNotifier(
  webhookUrl: string | undefined,
  redactor: Redactor,
  options: { actions?: boolean } = {}
): DiscordNotifier | null {
  if (webhookUrl === undefined || webhookUrl === '') {
    return null;
  }

  if (!isDiscordWebhookUrl(webhookUrl)) {
    throw new Error('Invalid DISCORD_WEBHOOK_URL: expected a Discord webhook URL');
  }

  return new DiscordNotifier(
    {
      webhookUrl,
      actions: options.actions === true,
      username: 'Repo Pulse',
      avatarUrl: 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
    },
    redactor
  );
}
