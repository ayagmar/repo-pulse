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

  describe('Discord actions', () => {
    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    // Through String() and variables, which check:secrets reads as expressions.
    const applicationId = String(100000000000000001n);
    const publicKey = 'ab'.repeat(32);
    const userIds = `${String(100000000000000002n)}, ${String(100000000000000003n)}`;
    const blankList = ' , ';
    const complete = {
      GITHUB_WEBHOOK_SECRET: 'test-secret',
      ADMIN_API_TOKEN: 'admin-token',
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/0/test-only',
      GITHUB_APP_ID: String(1),
      GITHUB_APP_INSTALLATION_ID: String(2),
      GITHUB_APP_PRIVATE_KEY: keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      DISCORD_ACTIONS: 'on',
      DISCORD_APPLICATION_ID: applicationId,
      DISCORD_PUBLIC_KEY: publicKey,
      DISCORD_ALLOWED_USER_IDS: userIds,
    };

    it('stays off while DISCORD_ACTIONS is unset or off, even with its secrets set', () => {
      const unset = Object.fromEntries(
        Object.entries(complete).filter(([name]) => name !== 'DISCORD_ACTIONS')
      );
      for (const env of [
        unset,
        { ...complete, DISCORD_ACTIONS: '' },
        { ...complete, DISCORD_ACTIONS: 'off' },
      ]) {
        expect(createConfig(env).discord.actions).toBeUndefined();
      }
    });

    it('reads a complete config', () => {
      expect(createConfig(complete).discord.actions).toEqual({
        applicationId,
        publicKey,
        allowedUserIds: new Set(userIds.split(', ')),
      });
    });

    it('refuses anything partial or malformed when on, without echoing the values', () => {
      const cases: [Partial<Record<keyof typeof complete, string>>, string][] = [
        [{ DISCORD_ACTIONS: 'yes' }, 'Invalid DISCORD_ACTIONS'],
        [
          { GITHUB_APP_ID: '', GITHUB_APP_INSTALLATION_ID: '', GITHUB_APP_PRIVATE_KEY: '' },
          'on needs GITHUB_APP_ID',
        ],
        [{ DISCORD_WEBHOOK_URL: '' }, 'on needs DISCORD_WEBHOOK_URL'],
        [{ DISCORD_APPLICATION_ID: '' }, 'Invalid DISCORD_APPLICATION_ID'],
        [{ DISCORD_APPLICATION_ID: 'test-application' }, 'Invalid DISCORD_APPLICATION_ID'],
        [{ DISCORD_PUBLIC_KEY: 'test-key' }, 'Invalid DISCORD_PUBLIC_KEY'],
        [{ DISCORD_ALLOWED_USER_IDS: blankList }, 'Invalid DISCORD_ALLOWED_USER_IDS'],
        [{ DISCORD_ALLOWED_USER_IDS: `${userIds},test-user` }, 'Invalid DISCORD_ALLOWED_USER_IDS'],
      ];
      for (const [overrides, expected] of cases) {
        let message = '';
        try {
          createConfig({ ...complete, ...overrides });
        } catch (error) {
          message = String(error);
        }
        expect(message, expected).toContain(expected);
        for (const value of Object.values(overrides)) {
          if (value !== '') {
            expect(message).not.toContain(value);
          }
        }
      }
    });
  });
});
