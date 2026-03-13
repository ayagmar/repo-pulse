export const APP_ERROR_CODES = {
  INTERNAL_ERROR: 'internal_error',
  UNAUTHORIZED: 'unauthorized',
  INVALID_WEBHOOK_REQUEST: 'invalid_webhook_request',
  INVALID_WEBHOOK_SIGNATURE: 'invalid_webhook_signature',
  INVALID_EVENT_PAYLOAD: 'invalid_event_payload',
  NOTIFICATION_PROVIDERS_UNAVAILABLE: 'notification_providers_unavailable',
  DELIVERY_NOT_FOUND: 'delivery_not_found',
  DELIVERY_RETRY_NOT_ALLOWED: 'delivery_retry_not_allowed',
  INVALID_DELIVERY_FILTER: 'invalid_delivery_filter',
} as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[keyof typeof APP_ERROR_CODES];

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: AppErrorCode,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
