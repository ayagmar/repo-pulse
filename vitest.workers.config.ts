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
          // wrangler.jsonc admits only App deliveries, which need App credentials these
          // tests do not have; they send repository webhooks.
          GITHUB_WEBHOOK_SOURCES: 'repository',
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
