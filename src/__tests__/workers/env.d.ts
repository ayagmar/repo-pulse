import type { D1Migration } from '@cloudflare/vitest-plugin';

// Test-only bindings are deliberately separate from Wrangler's generated Env.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
