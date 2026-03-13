import type { NotificationResult, Notifier } from '../../core/interfaces/notifier.js';
import { FAILURE_CLASSIFICATIONS } from '../../core/models/failure-classification.js';
import type { RepoEvent } from '../../core/models/repo-event.js';
import { formatDiscordEmbed } from './embed-formatter.js';

interface DiscordNotifierConfig {
  webhookUrl: string;
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
  if (retryAfterHeader) {
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
  if (!resetAfterHeader) {
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

  constructor(private readonly cfg: DiscordNotifierConfig) {}

  isConfigured(): boolean {
    return true;
  }

  async notify(event: RepoEvent): Promise<NotificationResult> {
    const payload = formatDiscordEmbed(event);

    if (this.cfg.username) {
      payload.username = this.cfg.username;
    }
    if (this.cfg.avatarUrl) {
      payload.avatar_url = this.cfg.avatarUrl;
    }

    let response: Response;
    try {
      response = await fetch(this.cfg.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        provider: this.name,
        error: `Discord request failed: ${errorMessage}`,
        failureClassification: FAILURE_CLASSIFICATIONS.TRANSIENT,
      };
    }

    if (response.ok) {
      return {
        success: true,
        provider: this.name,
      };
    }

    const errorText = await response.text().catch(() => 'Unknown error');
    const error = `Discord API error: ${response.status} ${errorText}`;

    if (response.status === 429 || response.status >= 500) {
      const retryAfterMs = parseRetryDelayMs(response.headers);
      return {
        success: false,
        provider: this.name,
        error,
        failureClassification: FAILURE_CLASSIFICATIONS.TRANSIENT,
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
}

/**
 * Factory function to create a Discord notifier from environment config
 */
export function createDiscordNotifier(webhookUrl: string | undefined): DiscordNotifier | null {
  if (!webhookUrl) {
    return null;
  }

  if (!isDiscordWebhookUrl(webhookUrl)) {
    throw new Error('Invalid DISCORD_WEBHOOK_URL: expected a Discord webhook URL');
  }

  return new DiscordNotifier({
    webhookUrl,
    username: 'Repo Pulse',
    avatarUrl: 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
  });
}
