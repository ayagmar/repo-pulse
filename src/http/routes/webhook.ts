import { Hono } from 'hono';
import type { Context } from 'hono';
import { APP_ERROR_CODES, AppError } from '../../core/errors/app-error.js';
import type { DurableEventProcessor } from '../../core/services/durable-event-processor.js';
import { logger } from '../../core/services/logger.js';
import { EventMappingError, mapGitHubEvent } from '../../providers/github/event-mapper.js';
import {
  GitHubWebhookRequestError,
  parseGitHubWebhookRequest,
} from '../../providers/github/webhook-request.js';
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

async function readRawBodyWithLimit(c: Context, maxBodyBytes: number): Promise<string> {
  const contentLength = parseContentLength(c.req.header('Content-Length'));
  if (contentLength !== null && contentLength > maxBodyBytes) {
    throw new GitHubWebhookRequestError(413, `Payload too large: max ${maxBodyBytes} bytes`);
  }

  const body = c.req.raw.body;
  if (!body) {
    return '';
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
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
        throw new GitHubWebhookRequestError(413, `Payload too large: max ${maxBodyBytes} bytes`);
      }

      chunks.push(decoder.decode(value, { stream: true }));
    }

    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

/**
 * Create webhook routes with injected dependencies
 */
export function createWebhookRoutes(
  eventProcessor: DurableEventProcessor,
  options: {
    maxBodyBytes: number;
    webhookSecret: string;
    isDevelopment: boolean;
  }
): Hono {
  const router = new Hono();

  router.post('/', async (c: Context) => {
    let rawBody: string;
    try {
      rawBody = await readRawBodyWithLimit(c, options.maxBodyBytes);
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
        secret: options.webhookSecret,
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
        message: `Event type '${inbound.eventType}' is not supported`,
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

    if (options.isDevelopment) {
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
