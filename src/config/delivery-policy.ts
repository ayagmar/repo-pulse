export const DELIVERY_DEFAULTS = {
  maxAttempts: 5,
  retryBaseDelayMs: 30_000,
  retryMaxDelayMs: 15 * 60_000,
  succeededRetentionDays: 14,
  // On the Workers Free plan an invocation may make 50 subrequests, D1 queries
  // included. Each delivery takes about five, and the cron run also sends digests.
  drainBatchSize: 5,
} as const;
