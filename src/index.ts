import { createApp, drainDueDeliveries, sendDueDigests } from './app.js';

const app = createApp();

const worker = {
  fetch(request: Request, env: Env, executionCtx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, executionCtx);
  },
  scheduled(controller: ScheduledController, env: Env, executionCtx: ExecutionContext): void {
    executionCtx.waitUntil(drainDueDeliveries(env, { pruneSucceededDeliveries: true }));
    executionCtx.waitUntil(sendDueDigests(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;

export default worker;
