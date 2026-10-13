import { Hono } from 'hono';
import { APP_VERSION } from '../../config/app-version.js';
import { APP_ERROR_CODES, AppError } from '../../core/errors/app-error.js';
import { DELIVERY_STATUS_VALUES, type DeliveryStatus } from '../../core/models/delivery-ledger.js';
import type { HttpEnv } from '../app-env.js';
import { jsonError } from '../error-response.js';
import { createOpenApiDocument, renderSwaggerUiPage } from '../openapi.js';

function parseStatuses(rawValue: string | null): DeliveryStatus[] {
  if (rawValue === null || rawValue.trim() === '') {
    return [];
  }

  const statuses = rawValue
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');

  const invalidStatuses = statuses.filter(
    (status) => !DELIVERY_STATUS_VALUES.includes(status as DeliveryStatus)
  );

  if (invalidStatuses.length > 0) {
    throw new AppError(
      400,
      APP_ERROR_CODES.INVALID_DELIVERY_FILTER,
      `Invalid delivery status filter: ${invalidStatuses.join(', ')}`
    );
  }

  return statuses as DeliveryStatus[];
}

export function createAdminRoutes(): Hono<HttpEnv> {
  const router = new Hono<HttpEnv>();

  router.get('/status', async (c) => {
    const { deliveryLedger, notificationDispatcher } = c.get('runtime');
    const stats = await deliveryLedger.getStats();

    return c.json({
      name: 'repo-pulse',
      version: APP_VERSION,
      status: 'running',
      providers: notificationDispatcher.getNotifiers().map((notifier) => notifier.name),
      deliveryLedger: stats,
    });
  });

  router.get('/health', async (c) => {
    const { deliveryLedger, notificationDispatcher } = c.get('runtime');
    const stats = await deliveryLedger.getStats();

    return c.json({
      status: 'ok',
      providers: notificationDispatcher.getNotifiers().map((notifier) => notifier.name),
      trackedDeliveries: stats.total,
    });
  });

  router.get('/deliveries', async (c) => {
    let statuses: DeliveryStatus[];

    try {
      statuses = parseStatuses(c.req.query('status') ?? null);
    } catch (error) {
      if (error instanceof AppError) {
        return jsonError(c, error);
      }

      throw error;
    }

    const deliveries = await c.get('runtime').deliveryLedger.listDeliveries(statuses);
    return c.json({
      deliveries,
    });
  });

  router.get('/deliveries/:deliveryId', async (c) => {
    const delivery = await c.get('runtime').deliveryLedger.getDelivery(c.req.param('deliveryId'));
    if (!delivery) {
      return jsonError(
        c,
        new AppError(404, APP_ERROR_CODES.DELIVERY_NOT_FOUND, 'Delivery not found')
      );
    }

    return c.json(delivery);
  });

  router.post('/deliveries/:deliveryId/retry', async (c) => {
    const { deliveryLedger, eventProcessor } = c.get('runtime');
    const deliveryId = c.req.param('deliveryId');
    const result = await eventProcessor.retryDelivery(deliveryId);

    if (result.outcome === 'not_found') {
      return jsonError(
        c,
        new AppError(404, APP_ERROR_CODES.DELIVERY_NOT_FOUND, 'Delivery not found')
      );
    }

    if (result.outcome === 'not_retryable') {
      return jsonError(
        c,
        new AppError(
          409,
          APP_ERROR_CODES.DELIVERY_RETRY_NOT_ALLOWED,
          `Delivery status '${result.status}' cannot be retried`
        )
      );
    }

    const delivery = await deliveryLedger.getDelivery(deliveryId);
    c.executionCtx.waitUntil(eventProcessor.drainDueDeliveries());
    return c.json(
      {
        success: true,
        message: 'Delivery queued for retry',
        delivery,
      },
      202
    );
  });

  router.get('/openapi.json', (c) => {
    return c.json(createOpenApiDocument(new URL(c.req.url).origin));
  });

  router.get('/docs', (c) => {
    return c.html(renderSwaggerUiPage(createOpenApiDocument(new URL(c.req.url).origin)));
  });

  return router;
}
