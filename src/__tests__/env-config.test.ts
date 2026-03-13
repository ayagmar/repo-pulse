import { describe, expect, it } from 'vitest';
import { createConfig } from '../config/env.js';
import { createTempDatabasePath, createTestEnv } from './test-helpers.js';

describe('createConfig', () => {
  it('rejects malformed retry values instead of truncating them', () => {
    const tempDatabase = createTempDatabasePath();
    const env = createTestEnv(tempDatabase.databasePath, {
      DELIVERY_MAX_ATTEMPTS: '5oops',
    });

    expect(() => createConfig(env)).toThrow(
      'Invalid DELIVERY_MAX_ATTEMPTS: expected an integer >= 1'
    );

    env.DB.close();
    tempDatabase.cleanup();
  });

  it('rejects retry max values smaller than the base delay', () => {
    const tempDatabase = createTempDatabasePath();
    const env = createTestEnv(tempDatabase.databasePath, {
      DELIVERY_RETRY_BASE_DELAY_MS: '100',
      DELIVERY_RETRY_MAX_DELAY_MS: '99',
    });

    expect(() => createConfig(env)).toThrow(
      'Invalid DELIVERY_RETRY_MAX_DELAY_MS: must be >= DELIVERY_RETRY_BASE_DELAY_MS'
    );

    env.DB.close();
    tempDatabase.cleanup();
  });
});
