import type { LogLevel } from '../core/services/logger.js';
import { DELIVERY_DEFAULTS } from './delivery-policy.js';
import { WEBHOOK_DEFAULTS } from './webhook-policy.js';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** Where a webhook delivery comes from: a repository's own webhook, or the GitHub App. */
const WEBHOOK_SOURCES = ['repository', 'app'] as const;

export type WebhookSource = (typeof WEBHOOK_SOURCES)[number];

type ConfigEnvVarName =
  | 'NODE_ENV'
  | 'LOG_LEVEL'
  | 'GITHUB_WEBHOOK_SECRET'
  | 'GITHUB_TOKEN'
  | 'GITHUB_PUBLIC_TOKEN'
  | 'GITHUB_WEBHOOK_SOURCES'
  | 'GITHUB_APP_ID'
  | 'GITHUB_APP_INSTALLATION_ID'
  | 'GITHUB_APP_PRIVATE_KEY'
  | 'WEBHOOK_MAX_BODY_BYTES'
  | 'ADMIN_API_TOKEN'
  | 'DISCORD_WEBHOOK_URL'
  | 'DELIVERY_MAX_ATTEMPTS'
  | 'DELIVERY_RETRY_BASE_DELAY_MS'
  | 'DELIVERY_RETRY_MAX_DELAY_MS'
  | 'DELIVERY_SUCCEEDED_RETENTION_DAYS'
  | 'DELIVERY_PROCESSING_LEASE_MS'
  | 'DELIVERY_DRAIN_BATCH_SIZE'
  | 'DIGEST_TIME_ZONE'
  | 'DIGEST_HOUR';

export type ConfigEnv = Partial<Record<ConfigEnvVarName, string>>;

function getEnvVar(env: ConfigEnv, name: ConfigEnvVarName, required: true): string;
function getEnvVar(env: ConfigEnv, name: ConfigEnvVarName, required?: false): string | undefined;
function getEnvVar(env: ConfigEnv, name: ConfigEnvVarName, required = false): string | undefined {
  const value = env[name];
  if (required && (value === undefined || value === '')) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return typeof value === 'string' ? value : undefined;
}

function parseLogLevel(value: string | undefined, isDevelopment: boolean): LogLevel {
  if (value === undefined || value === '') {
    return isDevelopment ? 'debug' : 'info';
  }

  if (LOG_LEVELS.includes(value as LogLevel)) {
    return value as LogLevel;
  }

  throw new Error(`Invalid LOG_LEVEL: ${value}`);
}

function parsePositiveInteger(
  name: string,
  value: string | undefined,
  defaultValue: number,
  minimum = 1
): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }

  const normalizedValue = value.trim();
  if (!/^\d+$/.test(normalizedValue)) {
    throw new Error(`Invalid ${name}: expected an integer >= ${String(minimum)}`);
  }

  const parsedValue = Number.parseInt(normalizedValue, 10);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < minimum) {
    throw new Error(`Invalid ${name}: expected an integer >= ${String(minimum)}`);
  }

  return parsedValue;
}

function parseTimeZone(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    return 'UTC';
  }

  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`Invalid DIGEST_TIME_ZONE: ${value}`);
  }
}

function parseHour(value: string | undefined, defaultValue: number): number {
  const hour = parsePositiveInteger('DIGEST_HOUR', value, defaultValue, 0);
  if (hour > 23) {
    throw new Error('Invalid DIGEST_HOUR: expected an integer from 0 to 23');
  }

  return hour;
}

/**
 * The webhook sources admitted: `repository` for per-repository webhooks, `app` for
 * the GitHub App's deliveries. Unset means `repository`; an empty or unknown entry
 * is an error rather than a silently narrower set.
 */
function parseWebhookSources(value: string | undefined): ReadonlySet<WebhookSource> {
  if (value === undefined) {
    return new Set(['repository']);
  }

  const sources = value.split(',').map((source) => source.trim());
  for (const source of sources) {
    if (!WEBHOOK_SOURCES.includes(source as WebhookSource)) {
      throw new Error(
        `Invalid GITHUB_WEBHOOK_SOURCES: expected a comma-separated list of ${WEBHOOK_SOURCES.join(', ')}`
      );
    }
  }

  return new Set(sources as WebhookSource[]);
}

export interface GitHubAppConfig {
  appId: number;
  installationId: number;
  /** PKCS#8 PEM. */
  privateKey: string;
}

const PKCS8_HEADER = '-----BEGIN PRIVATE KEY-----';
const PKCS1_HEADER = '-----BEGIN RSA PRIVATE KEY-----';

/**
 * The GitHub App's credentials, or undefined when none are set. Error messages
 * name the variable, never its value.
 */
function parseGitHubApp(env: ConfigEnv): GitHubAppConfig | undefined {
  const appId = getEnvVar(env, 'GITHUB_APP_ID') ?? '';
  const installationId = getEnvVar(env, 'GITHUB_APP_INSTALLATION_ID') ?? '';
  const privateKey = getEnvVar(env, 'GITHUB_APP_PRIVATE_KEY') ?? '';
  const setCount = [appId, installationId, privateKey].filter((value) => value !== '').length;
  if (setCount === 0) {
    return undefined;
  }
  if (setCount < 3) {
    throw new Error(
      'Incomplete GitHub App config: set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY together'
    );
  }

  const trimmedKey = privateKey.trim();
  if (trimmedKey.startsWith(PKCS1_HEADER)) {
    throw new Error(
      'Invalid GITHUB_APP_PRIVATE_KEY: expected PKCS#8, got PKCS#1. Convert it with `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pkcs8.pem`'
    );
  }
  if (!trimmedKey.startsWith(PKCS8_HEADER)) {
    throw new Error('Invalid GITHUB_APP_PRIVATE_KEY: expected a PKCS#8 PEM private key');
  }

  // Both are set by now, so the default of 0 is never used.
  return {
    appId: parsePositiveInteger('GITHUB_APP_ID', appId, 0),
    installationId: parsePositiveInteger('GITHUB_APP_INSTALLATION_ID', installationId, 0),
    privateKey: trimmedKey,
  };
}

export function createConfig(env: ConfigEnv): {
  server: {
    env: string;
    isDev: boolean;
    isProduction: boolean;
    logLevel: LogLevel;
  };
  github: {
    webhookSecret: string;
    maxBodyBytes: number;
    /** Read-only token for GitHub's API. Optional: without it, digests skip what it adds. */
    apiToken: string | undefined;
    webhookSources: ReadonlySet<WebhookSource>;
    /** When set, its installation token replaces `apiToken`. */
    app: GitHubAppConfig | undefined;
  };
  admin: {
    apiToken: string;
  };
  discord: {
    webhookUrl: string | undefined;
  };
  deliveryLedger: {
    maxAttempts: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    succeededRetentionDays: number;
    processingLeaseMs: number;
    drainBatchSize: number;
  };
  digest: {
    timeZone: string;
    hour: number;
  };
} {
  const nodeEnv = getEnvVar(env, 'NODE_ENV') ?? 'development';
  const isDevelopment = nodeEnv === 'development';
  const webhookSecret = getEnvVar(env, 'GITHUB_WEBHOOK_SECRET', true);
  const adminApiToken = getEnvVar(env, 'ADMIN_API_TOKEN', true);
  const githubToken = getEnvVar(env, 'GITHUB_TOKEN');
  const webhookSources = parseWebhookSources(getEnvVar(env, 'GITHUB_WEBHOOK_SOURCES'));
  const githubApp = parseGitHubApp(env);
  if (webhookSources.has('app') && githubApp === undefined) {
    throw new Error(
      'Invalid GITHUB_WEBHOOK_SOURCES: app needs GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY'
    );
  }
  const deliveryRetryBaseDelayMs = parsePositiveInteger(
    'DELIVERY_RETRY_BASE_DELAY_MS',
    getEnvVar(env, 'DELIVERY_RETRY_BASE_DELAY_MS'),
    DELIVERY_DEFAULTS.retryBaseDelayMs
  );
  const deliveryRetryMaxDelayMs = parsePositiveInteger(
    'DELIVERY_RETRY_MAX_DELAY_MS',
    getEnvVar(env, 'DELIVERY_RETRY_MAX_DELAY_MS'),
    DELIVERY_DEFAULTS.retryMaxDelayMs
  );

  if (deliveryRetryMaxDelayMs < deliveryRetryBaseDelayMs) {
    throw new Error('Invalid DELIVERY_RETRY_MAX_DELAY_MS: must be >= DELIVERY_RETRY_BASE_DELAY_MS');
  }

  return {
    server: {
      env: nodeEnv,
      isDev: isDevelopment,
      isProduction: nodeEnv === 'production',
      logLevel: parseLogLevel(getEnvVar(env, 'LOG_LEVEL'), isDevelopment),
    },

    github: {
      webhookSecret,
      maxBodyBytes: parsePositiveInteger(
        'WEBHOOK_MAX_BODY_BYTES',
        getEnvVar(env, 'WEBHOOK_MAX_BODY_BYTES'),
        WEBHOOK_DEFAULTS.maxBodyBytes
      ),
      apiToken: githubToken === '' ? undefined : githubToken,
      webhookSources,
      app: githubApp,
    },

    admin: {
      apiToken: adminApiToken,
    },

    discord: {
      webhookUrl: getEnvVar(env, 'DISCORD_WEBHOOK_URL'),
    },

    deliveryLedger: {
      maxAttempts: parsePositiveInteger(
        'DELIVERY_MAX_ATTEMPTS',
        getEnvVar(env, 'DELIVERY_MAX_ATTEMPTS'),
        DELIVERY_DEFAULTS.maxAttempts
      ),
      retryBaseDelayMs: deliveryRetryBaseDelayMs,
      retryMaxDelayMs: deliveryRetryMaxDelayMs,
      succeededRetentionDays: parsePositiveInteger(
        'DELIVERY_SUCCEEDED_RETENTION_DAYS',
        getEnvVar(env, 'DELIVERY_SUCCEEDED_RETENTION_DAYS'),
        DELIVERY_DEFAULTS.succeededRetentionDays
      ),
      processingLeaseMs: parsePositiveInteger(
        'DELIVERY_PROCESSING_LEASE_MS',
        getEnvVar(env, 'DELIVERY_PROCESSING_LEASE_MS'),
        5 * 60_000
      ),
      drainBatchSize: parsePositiveInteger(
        'DELIVERY_DRAIN_BATCH_SIZE',
        getEnvVar(env, 'DELIVERY_DRAIN_BATCH_SIZE'),
        DELIVERY_DEFAULTS.drainBatchSize
      ),
    },

    digest: {
      timeZone: parseTimeZone(getEnvVar(env, 'DIGEST_TIME_ZONE')),
      hour: parseHour(getEnvVar(env, 'DIGEST_HOUR'), 9),
    },
  };
}
