import { Hono } from 'hono';
import { createConfig } from './config/env.js';
import { D1DeliveryLedger } from './core/services/d1-delivery-ledger.js';
import { D1DigestLog } from './core/services/d1-digest-log.js';
import { D1EventHistory } from './core/services/d1-event-history.js';
import { D1RadarLog } from './core/services/d1-radar-log.js';
import { DigestSender } from './core/services/digest.js';
import { DurableEventProcessor } from './core/services/durable-event-processor.js';
import { logger } from './core/services/logger.js';
import { MomentumRadar } from './core/services/momentum-radar.js';
import { NotificationDispatcher } from './core/services/notification-dispatcher.js';
import type { HttpEnv } from './http/app-env.js';
import { createAdminAuthMiddleware } from './http/middleware/admin-auth.js';
import { createErrorHandler } from './http/middleware/error-handler.js';
import { requestLogger } from './http/middleware/logger.js';
import { createAdminRoutes } from './http/routes/admin.js';
import { createWebhookRoutes } from './http/routes/webhook.js';
import { createDiscordNotifier } from './providers/discord/discord-notifier.js';
import { GitHubInsights } from './providers/github/github-insights.js';

function buildRuntime(env: HttpEnv['Bindings']): HttpEnv['Variables']['runtime'] {
  const config = createConfig(env);
  logger.setLevel(config.server.logLevel);

  const deliveryLedger = new D1DeliveryLedger(env.DB);
  const eventHistory = new D1EventHistory(env.DB);
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
    eventHistory,
    notificationDispatcher,
    eventProcessor,
  };
}

export function createApp(): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();

  // Reuse routes, but derive clients and configuration from each request's bindings.
  app.use('*', async (c, next) => {
    c.set('runtime', buildRuntime(c.env));
    await next();
  });
  app.use('*', requestLogger);
  app.onError((error, c) =>
    createErrorHandler((c.env.NODE_ENV ?? 'development') === 'development')(error, c)
  );

  app.route('/webhook', createWebhookRoutes());
  app.use('/admin/*', createAdminAuthMiddleware());
  app.route('/admin', createAdminRoutes());

  return app;
}

export async function drainDueDeliveries(
  env: HttpEnv['Bindings'],
  options: {
    pruneSucceededDeliveries?: boolean;
  } = {}
): Promise<void> {
  const runtime = buildRuntime(env);
  await runtime.eventProcessor.drainDueDeliveries(options);
}

function createInsights(apiToken: string | undefined): GitHubInsights | null {
  return apiToken === undefined ? null : new GitHubInsights(apiToken);
}

export async function sendDueDigests(env: HttpEnv['Bindings'], now: Date): Promise<void> {
  const runtime = buildRuntime(env);
  const sender = new DigestSender(
    runtime.eventHistory,
    new D1DigestLog(env.DB),
    runtime.notificationDispatcher,
    runtime.config.digest,
    createInsights(runtime.config.github.apiToken)
  );
  await sender.sendDueDigests(now);
}

export async function checkMomentum(env: HttpEnv['Bindings'], now: Date): Promise<void> {
  const runtime = buildRuntime(env);
  const radar = new MomentumRadar(
    runtime.eventHistory,
    new D1RadarLog(env.DB),
    runtime.notificationDispatcher,
    createInsights(runtime.config.github.apiToken)
  );
  await radar.check(now);
}
