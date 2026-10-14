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

  it('rejects overflowing integers instead of accepting unusable retry budgets', () => {
    expect(() =>
      createConfig({
        GITHUB_WEBHOOK_SECRET: 'test',
        ADMIN_API_TOKEN: 'test',
        DELIVERY_MAX_ATTEMPTS: '9007199254740992',
      })
    ).toThrow('Invalid DELIVERY_MAX_ATTEMPTS');
  });

  it('rejects a digest time zone or hour that would never match, instead of never posting', () => {
    const base = { GITHUB_WEBHOOK_SECRET: 'test', ADMIN_API_TOKEN: 'test' };

    expect(() => createConfig({ ...base, DIGEST_TIME_ZONE: 'Africa/Casablnca' })).toThrow(
      'Invalid DIGEST_TIME_ZONE: Africa/Casablnca'
    );
    expect(() => createConfig({ ...base, DIGEST_HOUR: '24' })).toThrow(
      'Invalid DIGEST_HOUR: expected an integer from 0 to 23'
    );
    expect(createConfig(base).digest).toEqual({ timeZone: 'UTC', hour: 9 });
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
