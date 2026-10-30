export const WEBHOOK_DEFAULTS = {
  maxBodyBytes: 1024 * 1024,
} as const;

/** Where a webhook delivery comes from: a repository's own webhook, or the GitHub App. */
export const WEBHOOK_SOURCES = ['repository', 'app'] as const;

export type WebhookSource = (typeof WEBHOOK_SOURCES)[number];
