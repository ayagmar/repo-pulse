import type { Context, MiddlewareHandler, Next } from 'hono';
import { APP_ERROR_CODES, AppError } from '../../core/errors/app-error.js';
import { encodeUtf8, timingSafeEqual } from '../../core/security/constant-time.js';
import { logger } from '../../core/services/logger.js';
import { jsonError } from '../error-response.js';

async function isAuthorized(
  authorizationHeader: string | undefined,
  expectedToken: string
): Promise<boolean> {
  if (authorizationHeader === undefined) {
    return false;
  }

  const prefix = 'Bearer ';
  if (!authorizationHeader.startsWith(prefix)) {
    return false;
  }

  const receivedToken = authorizationHeader.slice(prefix.length);
  return timingSafeEqual(encodeUtf8(receivedToken), encodeUtf8(expectedToken));
}

export function createAdminAuthMiddleware(expectedToken: string): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (await isAuthorized(c.req.header('Authorization'), expectedToken)) {
      await next();
      return;
    }

    logger.warn('admin_auth.rejected', {
      component: 'admin_auth',
      method: c.req.method,
      path: c.req.path,
      userAgent: c.req.header('User-Agent'),
    });

    c.header('WWW-Authenticate', 'Bearer realm="repo-pulse-admin"');
    return jsonError(c, new AppError(401, APP_ERROR_CODES.UNAUTHORIZED, 'Unauthorized'));
  };
}
