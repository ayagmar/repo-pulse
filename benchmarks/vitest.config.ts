import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['benchmarks/ledger.test.ts'],
    testTimeout: 30_000,
    reporters: ['verbose'],
  },
});
