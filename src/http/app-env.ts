import type { ConfigEnv, createConfig } from '../config/env.js';
import type { Redactor } from '../core/security/redact.js';
import type { D1DeliveryLedger } from '../core/services/d1-delivery-ledger.js';
import type { D1EventHistory } from '../core/services/d1-event-history.js';
import type { D1DatabaseLike } from '../core/services/d1-types.js';
import type { DurableEventProcessor } from '../core/services/durable-event-processor.js';
import type { NotificationDispatcher } from '../core/services/notification-dispatcher.js';

export interface HttpEnv {
  Bindings: ConfigEnv & {
    DB: D1DatabaseLike;
    FEED_RATE_LIMIT: RateLimit;
    DISCORD_RATE_LIMIT: RateLimit;
  };
  Variables: {
    runtime: {
      config: ReturnType<typeof createConfig>;
      redactor: Redactor;
      deliveryLedger: D1DeliveryLedger;
      eventHistory: D1EventHistory;
      notificationDispatcher: NotificationDispatcher;
      eventProcessor: DurableEventProcessor;
    };
  };
}
