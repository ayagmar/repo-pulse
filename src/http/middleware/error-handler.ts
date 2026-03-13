import type { ErrorHandler } from 'hono';
import { APP_ERROR_CODES, AppError, isAppError } from '../../core/errors/app-error.js';
import { logger } from '../../core/services/logger.js';
import { jsonError } from '../error-response.js';

export function createErrorHandler(includeDetails: boolean): ErrorHandler {
  return (error, c) => {
    logger.error('http.unhandled_error', {
      component: 'http',
      method: c.req.method,
      path: c.req.path,
      error,
    });

    const appError = isAppError(error)
      ? error
      : new AppError(
          500,
          APP_ERROR_CODES.INTERNAL_ERROR,
          'Internal server error',
          error instanceof Error ? { message: error.message, stack: error.stack } : { error }
        );

    return jsonError(c, appError, {
      includeDetails,
    });
  };
}
