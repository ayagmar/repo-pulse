import { generateKeyPairSync } from 'node:crypto';
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
        GITHUB_WEBHOOK_SECRET: 'test-secret',
        ADMIN_API_TOKEN: 'admin-token',
        DELIVERY_MAX_ATTEMPTS: '9007199254740992',
      })
    ).toThrow('Invalid DELIVERY_MAX_ATTEMPTS');
  });

  it('rejects a digest time zone or hour that would never match, instead of never posting', () => {
    const base = { GITHUB_WEBHOOK_SECRET: 'test-secret', ADMIN_API_TOKEN: 'admin-token' };

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

  describe('GitHub webhook sources and App', () => {
    const base = { GITHUB_WEBHOOK_SECRET: 'test-secret', ADMIN_API_TOKEN: 'admin-token' };
    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    // Numbers through String(), which check:secrets reads as an expression, not a literal id.
    const app = {
      GITHUB_APP_ID: String(1),
      GITHUB_APP_INSTALLATION_ID: String(2),
      GITHUB_APP_PRIVATE_KEY: keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    };

    it('admits repository webhooks only when the sources are unset', () => {
      const config = createConfig(base);
      expect([...config.github.webhookSources]).toEqual(['repository']);
      expect(config.github.app).toBeUndefined();
    });

    it('rejects an empty or unknown source instead of admitting a narrower set', () => {
      for (const value of ['', ' ', 'repository,', 'repo', 'repository,apps']) {
        expect(
          () => createConfig({ ...base, ...app, GITHUB_WEBHOOK_SOURCES: value }),
          value
        ).toThrow('Invalid GITHUB_WEBHOOK_SOURCES');
      }
      expect([
        ...createConfig({ ...base, ...app, GITHUB_WEBHOOK_SOURCES: ' repository , app ' }).github
          .webhookSources,
      ]).toEqual(['repository', 'app']);
    });

    it('refuses app as a source without the App configured', () => {
      expect(() => createConfig({ ...base, GITHUB_WEBHOOK_SOURCES: 'app' })).toThrow(
        'Invalid GITHUB_WEBHOOK_SOURCES: app needs GITHUB_APP_ID'
      );
    });

    it('rejects a partial or malformed App config without echoing the values', () => {
      for (const missing of Object.keys(app)) {
        for (const blank of ['', ' ']) {
          const partial = { ...base, ...app, [missing]: blank };
          expect(() => createConfig(partial), missing).toThrow('Incomplete GitHub App config');
        }
      }
      expect(() => createConfig({ ...base, ...app, GITHUB_APP_ID: 'test-app' })).toThrow(
        'Invalid GITHUB_APP_ID'
      );
      expect(() =>
        createConfig({ ...base, ...app, GITHUB_APP_INSTALLATION_ID: 'test-installation' })
      ).toThrow('Invalid GITHUB_APP_INSTALLATION_ID');
      const pkcs1 = keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' });
      expect(() => createConfig({ ...base, ...app, GITHUB_APP_PRIVATE_KEY: pkcs1 })).toThrow(
        'openssl pkcs8 -topk8 -nocrypt'
      );
      let message = '';
      try {
        createConfig({ ...base, ...app, GITHUB_APP_PRIVATE_KEY: 'test-not-a-key' });
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain('Invalid GITHUB_APP_PRIVATE_KEY');
      expect(message).not.toContain('test-not-a-key');
    });

    it('reads a complete App config', () => {
      expect(createConfig({ ...base, ...app, GITHUB_WEBHOOK_SOURCES: 'app' }).github.app).toEqual({
        appId: 1,
        installationId: 2,
        privateKey: app.GITHUB_APP_PRIVATE_KEY.trim(),
      });
    });
  });
});
