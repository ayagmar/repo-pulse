import type { Context, Next } from 'hono';
import { logger } from '../../core/services/logger.js';

export async function requestLogger(c: Context, next: Next): Promise<void> {
  const start = performance.now();
  const method = c.req.method;
  const path = c.req.path;
  const eventType = c.req.header('X-GitHub-Event');
  const deliveryId = c.req.header('X-GitHub-Delivery');
  const userAgent = c.req.header('User-Agent');

  await next();

  const durationMs = Math.round((performance.now() - start) * 100) / 100;
  const statusCode = c.res.status;
  const fields = {
    component: 'http',
    method,
    path,
    statusCode,
    durationMs,
    eventType,
    deliveryId,
    userAgent,
  };

  if (statusCode >= 500) {
    logger.error('http.request.completed', fields);
    return;
  }

  if (statusCode >= 400) {
    logger.warn('http.request.completed', fields);
    return;
  }

  logger.info('http.request.completed', fields);
}
