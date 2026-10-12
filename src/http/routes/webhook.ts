import type { Context } from 'hono';
import { Hono } from 'hono';
import { APP_ERROR_CODES, AppError } from '../../core/errors/app-error.js';
import { logger } from '../../core/services/logger.js';
import { EventMappingError, mapGitHubEvent } from '../../providers/github/event-mapper.js';
import {
  GitHubWebhookRequestError,
  parseGitHubWebhookRequest,
} from '../../providers/github/webhook-request.js';
import type { HttpEnv } from '../app-env.js';
import { jsonError } from '../error-response.js';

interface WebhookSuccessResponse {
  success: boolean;
  message: string;
  eventType?: string;
  repository?: string;
  duplicate?: boolean;
}

function parseContentLength(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const normalizedValue = value.trim();
  if (!/^\d+$/.test(normalizedValue)) {
    return null;
  }

  return Number.parseInt(normalizedValue, 10);
}

async function readRawBodyWithLimit(c: Context, maxBodyBytes: number): Promise<Uint8Array> {
  const contentLength = parseContentLength(c.req.header('Content-Length'));
  if (contentLength !== null && contentLength > maxBodyBytes) {
    throw new GitHubWebhookRequestError(
      413,
      `Payload too large: max ${String(maxBodyBytes)} bytes`
    );
  }

  const body = c.req.raw.body;
  if (!body) {
    return new Uint8Array();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBodyBytes) {
        await reader.cancel();
        throw new GitHubWebhookRequestError(
          413,
          `Payload too large: max ${String(maxBodyBytes)} bytes`
        );
      }

      chunks.push(value);
    }

    const rawBody = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      rawBody.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return rawBody;
  } finally {
    reader.releaseLock();
  }
}

export function createWebhookRoutes(): Hono<HttpEnv> {
  const router = new Hono<HttpEnv>();

  router.post('/', async (c) => {
    const { config, eventProcessor } = c.get('runtime');
    let rawBody: Uint8Array;
    try {
      rawBody = await readRawBodyWithLimit(c, config.github.maxBodyBytes);
    } catch (error) {
      if (error instanceof GitHubWebhookRequestError) {
        return jsonError(c, error);
      }

      throw error;
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
        repository: inbound.repository,
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
      repository: inbound.repository,
      sourceEventType: inbound.eventType,
    });

    if (config.server.isDev) {
      logger.debug('webhook.accepted', {
        component: 'webhook',
        deliveryId: inbound.deliveryId,
        eventType: event.type,
        repository: inbound.repository,
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
      repository: inbound.repository,
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
