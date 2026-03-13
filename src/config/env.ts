import type { LogLevel } from '../core/services/logger.js';
import { DELIVERY_DEFAULTS } from './delivery-policy.js';
import { WEBHOOK_DEFAULTS } from './webhook-policy.js';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

type ConfigEnvVarName =
  | 'NODE_ENV'
  | 'LOG_LEVEL'
  | 'GITHUB_WEBHOOK_SECRET'
  | 'WEBHOOK_MAX_BODY_BYTES'
  | 'ADMIN_API_TOKEN'
  | 'DISCORD_WEBHOOK_URL'
  | 'DELIVERY_MAX_ATTEMPTS'
  | 'DELIVERY_RETRY_BASE_DELAY_MS'
  | 'DELIVERY_RETRY_MAX_DELAY_MS'
  | 'DELIVERY_SUCCEEDED_RETENTION_DAYS'
  | 'DELIVERY_PROCESSING_LEASE_MS'
  | 'DELIVERY_DRAIN_BATCH_SIZE';

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
  if (parsedValue < minimum) {
    throw new Error(`Invalid ${name}: expected an integer >= ${String(minimum)}`);
  }

  return parsedValue;
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
} {
  const nodeEnv = getEnvVar(env, 'NODE_ENV') ?? 'development';
  const isDevelopment = nodeEnv === 'development';
  const webhookSecret = getEnvVar(env, 'GITHUB_WEBHOOK_SECRET', true);
  const adminApiToken = getEnvVar(env, 'ADMIN_API_TOKEN', true);
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
        25
      ),
    },
  };
}
