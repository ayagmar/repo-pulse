import { createApp, drainDueDeliveries } from './app.js';

const worker = {
  fetch(request: Request, env: Env, executionCtx: ExecutionContext): Response | Promise<Response> {
    return createApp(env).fetch(request, env, executionCtx);
  },
  scheduled(_controller: ScheduledController, env: Env, executionCtx: ExecutionContext): void {
    executionCtx.waitUntil(drainDueDeliveries(env, { pruneSucceededDeliveries: true }));
  },
} satisfies ExportedHandler<Env>;

export default worker;
