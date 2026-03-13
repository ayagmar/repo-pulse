import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { APP_ERROR_CODES, AppError } from '../core/errors/app-error.js';
import { createErrorHandler } from '../http/middleware/error-handler.js';

describe('errorHandler', () => {
  it('returns the standardized shape for application errors', async () => {
    const app = new Hono();
    app.onError(createErrorHandler(false));
    app.get('/denied', () => {
      throw new AppError(401, APP_ERROR_CODES.UNAUTHORIZED, 'Unauthorized');
    });

    const response = await app.request('/denied');

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      code: APP_ERROR_CODES.UNAUTHORIZED,
      message: 'Unauthorized',
    });
  });

  it('returns the standardized shape for unexpected errors', async () => {
    const app = new Hono();
    app.onError(createErrorHandler(false));
    app.get('/boom', () => {
      throw new Error('boom');
    });

    const response = await app.request('/boom');

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      code: APP_ERROR_CODES.INTERNAL_ERROR,
      message: 'Internal server error',
    });
  });
});
