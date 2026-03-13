import { vi } from 'vitest';

// Mock console methods in tests to reduce noise
// Use vi.spyOn(console, 'log').mockRestore() to restore for specific tests
globalThis.console = {
  ...console,
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
