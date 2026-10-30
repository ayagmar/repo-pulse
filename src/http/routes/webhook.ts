import { Hono } from 'hono';
import { APP_ERROR_CODES, AppError } from '../../core/errors/app-error.js';
import { logger } from '../../core/services/logger.js';
import { EventMappingError, mapGitHubEvent } from '../../providers/github/event-mapper.js';
import {
  extractGitHubRepositoryFullName,
  GitHubWebhookRequestError,
  parseGitHubWebhookRequest,
  rejectAppDelivery,
} from '../../providers/github/webhook-request.js';
import type { HttpEnv } from '../app-env.js';
import { jsonError } from '../error-response.js';
import { readBodyWithLimit } from '../read-body.js';

interface WebhookSuccessResponse {
  success: boolean;
  message: string;
  eventType?: string;
  repository?: string;
  duplicate?: boolean;
}

function repositoryNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry: unknown) =>
    typeof entry === 'object' &&
    entry !== null &&
    'full_name' in entry &&
    typeof entry.full_name === 'string'
      ? [entry.full_name]
      : []
  );
}

/** Installation changes are logged so the owner can see which repositories the App covers. */
function logControlEvent(deliveryId: string, eventType: string, payload: unknown): void {
  if (eventType === 'ping' || typeof payload !== 'object' || payload === null) {
    return;
  }
  const body = payload as Record<string, unknown>;
  logger.info('webhook.installation_changed', {
    component: 'webhook',
    deliveryId,
    eventType,
    action: typeof body.action === 'string' ? body.action : undefined,
    added: repositoryNames(body.repositories_added),
    removed: repositoryNames(body.repositories_removed),
  });
}

export function createWebhookRoutes(): Hono<HttpEnv> {
  const router = new Hono<HttpEnv>();

  router.post('/', async (c) => {
    const { config, eventProcessor } = c.get('runtime');
    const rawBody = await readBodyWithLimit(c.req.raw, config.github.maxBodyBytes);
    if (rawBody === null) {
      return jsonError(
        c,
        new GitHubWebhookRequestError(
          413,
          `Payload too large: max ${String(config.github.maxBodyBytes)} bytes`
        )
      );
    }

    let inbound: Awaited<ReturnType<typeof parseGitHubWebhookRequest>>;

    try {
      inbound = await parseGitHubWebhookRequest({
        rawBody,
        signature: c.req.header('X-Hub-Signature-256'),
        eventType: c.req.header('X-GitHub-Event'),
        deliveryId: c.req.header('X-GitHub-Delivery'),
        secret: config.github.webhookSecret,
      });
    } catch (error) {
      if (error instanceof GitHubWebhookRequestError) {
        return jsonError(c, error);
      }

      throw error;
    }

    if (inbound.kind === 'control') {
      logControlEvent(inbound.deliveryId, inbound.eventType, inbound.payload);
      return c.json<WebhookSuccessResponse>(
        {
          success: true,
          message: `Event '${inbound.eventType}' acknowledged`,
          eventType: inbound.eventType,
        },
        200
      );
    }

    if (!config.github.webhookSources.has(inbound.source)) {
      return c.json<WebhookSuccessResponse>(
        {
          success: true,
          message: `Event '${inbound.eventType}' ignored: ${inbound.source} deliveries are not admitted`,
          eventType: inbound.eventType,
        },
        200
      );
    }

    if (inbound.source === 'app') {
      // createConfig admits `app` only with the App configured; this check fails closed.
      const rejection = config.github.app
        ? rejectAppDelivery(inbound.payload, config.github.app.installationId)
        : 'GitHub App is not configured';
      if (rejection !== null) {
        logger.info('webhook.app_delivery_rejected', {
          component: 'webhook',
          deliveryId: inbound.deliveryId,
          eventType: inbound.eventType,
          reason: rejection,
        });
        return c.json<WebhookSuccessResponse>(
          {
            success: true,
            message: `Event '${inbound.eventType}' ignored: ${rejection}`,
            eventType: inbound.eventType,
          },
          200
        );
      }
    }

    let repository: string;
    try {
      repository = extractGitHubRepositoryFullName(inbound.payload);
    } catch (error) {
      if (error instanceof GitHubWebhookRequestError) {
        return jsonError(c, error);
      }

      throw error;
    }

    let event: ReturnType<typeof mapGitHubEvent>;
    try {
      event = mapGitHubEvent(inbound.eventType, inbound.payload);
    } catch (error) {
      return jsonError(
        c,
        error instanceof EventMappingError
          ? error
          : new AppError(400, APP_ERROR_CODES.INVALID_EVENT_PAYLOAD, 'Failed to parse event')
      );
    }

    if (!event) {
      const unsupportedResponse: WebhookSuccessResponse = {
        success: true,
        message: `Event '${inbound.eventType}' ignored: unsupported, or filtered out as noise`,
        eventType: inbound.eventType,
        repository,
      };

      return c.json<WebhookSuccessResponse>(unsupportedResponse, 200);
    }

    if (!eventProcessor.hasHandlers()) {
      return jsonError(
        c,
        new AppError(
          500,
          APP_ERROR_CODES.NOTIFICATION_PROVIDERS_UNAVAILABLE,
          'No notification providers configured'
        )
      );
    }

    const enqueueResult = await eventProcessor.enqueue(event, {
      deliveryId: inbound.deliveryId,
      repository,
      sourceEventType: inbound.eventType,
    });

    if (config.server.isDev) {
      logger.debug('webhook.accepted', {
        component: 'webhook',
        deliveryId: inbound.deliveryId,
        eventType: event.type,
        repository,
        duplicate: enqueueResult.outcome === 'duplicate',
      });
    }

    const acceptedResponse: WebhookSuccessResponse = {
      success: true,
      message:
        enqueueResult.outcome === 'duplicate'
          ? 'Duplicate delivery acknowledged'
          : 'Webhook accepted for asynchronous processing',
      eventType: event.type,
      repository,
    };

    if (enqueueResult.outcome === 'duplicate') {
      acceptedResponse.duplicate = true;
    }

    if (enqueueResult.outcome === 'accepted') {
      c.executionCtx.waitUntil(eventProcessor.drainDueDeliveries());
    }

    return c.json<WebhookSuccessResponse>(
      acceptedResponse,
      enqueueResult.outcome === 'duplicate' ? 200 : 202
    );
  });
  return router;
}
