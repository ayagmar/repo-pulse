import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../core/services/logger.js';

describe('StructuredLogger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('filters logs below the configured level', () => {
    const logger = createLogger('warn', 'repo-pulse-test');

    logger.debug('debug.message', { component: 'test' });
    logger.info('info.message', { component: 'test' });
    logger.warn('warn.message', { component: 'test' });

    expect(console.debug).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('emits structured json with level, message, and fields', () => {
    const logger = createLogger('debug', 'repo-pulse-test');

    logger.error('test.failed', {
      component: 'test',
      deliveryId: 'delivery-1',
      error: new Error('boom'),
    });

    expect(console.error).toHaveBeenCalledTimes(1);

    const firstCall = vi.mocked(console.error).mock.calls[0] as [string] | undefined;
    const output = firstCall?.[0];

    if (typeof output !== 'string') {
      throw new Error('Expected logger output to be a string');
    }

    const entry = JSON.parse(output) as Record<string, unknown>;

    expect(entry.level).toBe('error');
    expect(entry.service).toBe('repo-pulse-test');
    expect(entry.message).toBe('test.failed');
    expect(entry.component).toBe('test');
    expect(entry.deliveryId).toBe('delivery-1');
    expect(entry.timestamp).toEqual(expect.any(String));
    expect(entry.error).toMatchObject({
      name: 'Error',
      message: 'boom',
    });
  });
});
