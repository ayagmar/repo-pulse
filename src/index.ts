import {
  checkMomentum,
  createApp,
  drainDueDeliveries,
  InvocationInsights,
  recoverGitHubWebhooks,
  sendDueDigests,
} from './app.js';
import { isWebhookRecoveryDue } from './providers/github/webhook-recovery.js';

const app = createApp();

const worker = {
  fetch(request: Request, env: Env, executionCtx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, executionCtx);
  },
  scheduled(controller: ScheduledController, env: Env, executionCtx: ExecutionContext): void {
    const now = new Date(controller.scheduledTime);
    const recovering = isWebhookRecoveryDue(now);
    executionCtx.waitUntil(
      drainDueDeliveries(env, {
        runMaintenance: true,
        batchLimit: recovering ? 4 : 5,
      })
    );
    if (recovering) executionCtx.waitUntil(recoverGitHubWebhooks(env));
    // Digest and radar share one GitHub token acquisition.
    const insights = new InvocationInsights();
    executionCtx.waitUntil(sendDueDigests(env, undefined, insights));
    executionCtx.waitUntil(checkMomentum(env, now, insights));
  },
} satisfies ExportedHandler<Env>;

export default worker;
