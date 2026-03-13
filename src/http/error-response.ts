import type { Context } from 'hono';
import type { AppError, AppErrorCode } from '../core/errors/app-error.js';

interface ApiErrorResponse {
  success: false;
  code: AppErrorCode;
  message: string;
  details?: unknown;
}

export function jsonError(
  c: Context,
  error: AppError,
  options: { includeDetails?: boolean } = {}
): Response {
  const response: ApiErrorResponse = {
    success: false,
    code: error.code,
    message: error.message,
  };

  if (options.includeDetails === true && error.details !== undefined) {
    response.details = error.details;
  }

  return c.json<ApiErrorResponse>(response, error.statusCode as never);
}
