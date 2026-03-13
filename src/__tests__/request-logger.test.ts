import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createErrorHandler } from '../http/middleware/error-handler.js';
import { requestLogger } from '../http/middleware/logger.js';

describe('requestLogger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs request completion for handled 500 responses', async () => {
    const app = new Hono();
    app.use('*', requestLogger);
    app.onError(createErrorHandler(false));
    app.get('/boom', () => {
      throw new Error('boom');
    });

    const response = await app.request('/boom');

    expect(response.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('"message":"http.request.completed"')
    );
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"statusCode":500'));
  });
});
