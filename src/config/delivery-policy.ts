export const DELIVERY_DEFAULTS = {
  maxAttempts: 5,
  retryBaseDelayMs: 30_000,
  retryMaxDelayMs: 15 * 60_000,
  succeededRetentionDays: 14,
} as const;
