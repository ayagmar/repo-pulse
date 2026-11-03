import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          NODE_ENV: 'test',
          LOG_LEVEL: 'error',
          GITHUB_WEBHOOK_SECRET: 'test-secret',
          ADMIN_API_TOKEN: 'admin-token',
          DISCORD_WEBHOOK_URL: '',
          // Enough for config; a test that mints a token passes a generated key.
          GITHUB_APP_ID: String(1),
          GITHUB_APP_INSTALLATION_ID: String(1),
          GITHUB_APP_PRIVATE_KEY: ['-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----'].join(
            '\n'
          ),
          // wrangler.jsonc turns Discord actions on, which needs credentials these tests do
          // not have; the Ed25519 test turns them on with its own.
          DISCORD_ACTIONS: 'off',
        },
      },
    }),
  ],
  test: {
    include: ['src/__tests__/workers/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
