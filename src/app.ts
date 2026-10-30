import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { createConfig } from './config/env.js';
import type { RepositoryInsights } from './core/interfaces/repository-insights.js';
import { Redactor } from './core/security/redact.js';
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
import { createDiscordInteractionRoutes } from './http/routes/discord-interactions.js';
import { createPublicFeedRoutes } from './http/routes/public-feed.js';
import { createWebhookRoutes } from './http/routes/webhook.js';
import { createDiscordNotifier } from './providers/discord/discord-notifier.js';
import { GitHubAppAuth, READ_TOKEN } from './providers/github/app-auth.js';
import { GitHubInsights } from './providers/github/github-insights.js';

function buildRuntime(env: HttpEnv['Bindings']): HttpEnv['Variables']['runtime'] {
  const config = createConfig(env);
  logger.setLevel(config.server.logLevel);
  const redactor = new Redactor([
    config.github.webhookSecret,
    config.github.apiToken,
    config.github.app?.privateKey,
    config.admin.apiToken,
    config.discord.webhookUrl,
    env.GITHUB_PUBLIC_TOKEN,
  ]);

  const deliveryLedger = new D1DeliveryLedger(env.DB);
  const eventHistory = new D1EventHistory(env.DB);
  const notificationDispatcher = new NotificationDispatcher(redactor);
  const discordNotifier = createDiscordNotifier(config.discord.webhookUrl, redactor, {
    actions: config.discord.actions !== undefined,
  });

  if (discordNotifier) {
    notificationDispatcher.add(discordNotifier);
  }

  const eventProcessor = new DurableEventProcessor(
    deliveryLedger,
    notificationDispatcher,
    config.deliveryLedger,
    { ignoredLogins: config.people.ignoredLogins }
  );

  return {
    config,
    redactor,
    deliveryLedger,
    eventHistory,
    notificationDispatcher,
    eventProcessor,
  };
}

export function createApp(): Hono<HttpEnv> {
  const app = new Hono<HttpEnv>();

  // Reuse routes, but derive clients and configuration from each request's bindings.
  // The public feed needs neither, so a missing secret does not break it.
  const runtime: MiddlewareHandler<HttpEnv> = async (c, next) => {
    c.set('runtime', buildRuntime(c.env));
    await next();
  };
  app.use('/webhook/*', runtime);
  app.use('/admin/*', runtime);
  app.use('/discord/*', runtime);
  app.use('*', requestLogger);
  app.onError((error, c) =>
    createErrorHandler((c.env.NODE_ENV ?? 'development') === 'development')(error, c)
  );

  app.route('/webhook', createWebhookRoutes());
  app.use('/admin/*', createAdminAuthMiddleware());
  app.route('/admin', createAdminRoutes());
  app.route('/public', createPublicFeedRoutes());
  app.route('/discord', createDiscordInteractionRoutes());

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

/**
 * GitHub insights for one scheduled invocation. Digest and radar given the same
 * instance share one token acquisition, so a cold App token is minted once, and a
 * failed mint is not retried until the next invocation.
 */
export class InvocationInsights {
  private insights: RepositoryInsights | null | undefined;

  get(runtime: HttpEnv['Variables']['runtime']): RepositoryInsights | null {
    this.insights ??= createInsights(runtime);
    return this.insights;
  }
}

/** The App's installation token when the App is configured, else `GITHUB_TOKEN`. */
function createInsights({
  config,
  redactor,
}: HttpEnv['Variables']['runtime']): GitHubInsights | null {
  const { app, apiToken } = config.github;
  if (app) {
    const auth = new GitHubAppAuth(app, redactor);
    return new GitHubInsights(() => auth.installationToken(READ_TOKEN), redactor);
  }
  return apiToken === undefined
    ? null
    : new GitHubInsights(() => Promise.resolve(apiToken), redactor);
}

export async function sendDueDigests(
  env: HttpEnv['Bindings'],
  now: Date,
  insights = new InvocationInsights()
): Promise<void> {
  const runtime = buildRuntime(env);
  const sender = new DigestSender(
    runtime.eventHistory,
    new D1DigestLog(env.DB),
    runtime.notificationDispatcher,
    { ...runtime.config.digest, ignoredLogins: runtime.config.people.ignoredLogins },
    insights.get(runtime)
  );
  await sender.sendDueDigests(now);
}

export async function checkMomentum(
  env: HttpEnv['Bindings'],
  now: Date,
  insights = new InvocationInsights()
): Promise<void> {
  const runtime = buildRuntime(env);
  const radar = new MomentumRadar(
    runtime.eventHistory,
    new D1RadarLog(env.DB),
    runtime.notificationDispatcher,
    insights.get(runtime)
  );
  await radar.check(now);
}
