import { Hono } from 'hono';
import { type ConfigEnv, createConfig } from './config/env.js';
import { D1DeliveryLedger } from './core/services/d1-delivery-ledger.js';
import type { D1DatabaseLike } from './core/services/d1-types.js';
import { DurableEventProcessor } from './core/services/durable-event-processor.js';
import { logger } from './core/services/logger.js';
import { NotificationDispatcher } from './core/services/notification-dispatcher.js';
import { createAdminAuthMiddleware } from './http/middleware/admin-auth.js';
import { createErrorHandler } from './http/middleware/error-handler.js';
import { requestLogger } from './http/middleware/logger.js';
import { createAdminRoutes } from './http/routes/admin.js';
import { createWebhookRoutes } from './http/routes/webhook.js';
import { createDiscordNotifier } from './providers/discord/discord-notifier.js';

type AppEnv = ConfigEnv & {
  DB: D1DatabaseLike;
};

function buildRuntime(env: AppEnv) {
  const config = createConfig(env);
  logger.setLevel(config.server.logLevel);

  const deliveryLedger = new D1DeliveryLedger(env.DB);
  const notificationDispatcher = new NotificationDispatcher();
  const discordNotifier = createDiscordNotifier(config.discord.webhookUrl);

  if (discordNotifier) {
    notificationDispatcher.add(discordNotifier);
  }

  const eventProcessor = new DurableEventProcessor(
    deliveryLedger,
    notificationDispatcher,
    config.deliveryLedger
  );

  return {
    config,
    deliveryLedger,
    notificationDispatcher,
    eventProcessor,
  };
}

export function createApp(env: AppEnv) {
  const runtime = buildRuntime(env);
  const app = new Hono<{ Bindings: AppEnv }>();

  app.use('*', requestLogger);
  app.onError(createErrorHandler(runtime.config.server.isDev));

  app.route(
    '/webhook',
    createWebhookRoutes(runtime.eventProcessor, {
      maxBodyBytes: runtime.config.github.maxBodyBytes,
      webhookSecret: runtime.config.github.webhookSecret,
      isDevelopment: runtime.config.server.isDev,
    })
  );

  app.use('/admin/*', createAdminAuthMiddleware(runtime.config.admin.apiToken));
  app.route(
    '/admin',
    createAdminRoutes(
      runtime.notificationDispatcher,
      runtime.deliveryLedger,
      runtime.eventProcessor
    )
  );

  return app;
}

export async function drainDueDeliveries(
  env: AppEnv,
  options: {
    pruneSucceededDeliveries?: boolean;
  } = {}
): Promise<void> {
  const runtime = buildRuntime(env);
  await runtime.eventProcessor.drainDueDeliveries(options);
}
