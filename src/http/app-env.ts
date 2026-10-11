import type { ConfigEnv, createConfig } from '../config/env.js';
import type { D1DeliveryLedger } from '../core/services/d1-delivery-ledger.js';
import type { D1DatabaseLike } from '../core/services/d1-types.js';
import type { DurableEventProcessor } from '../core/services/durable-event-processor.js';
import type { NotificationDispatcher } from '../core/services/notification-dispatcher.js';

export interface HttpEnv {
  Bindings: ConfigEnv & { DB: D1DatabaseLike };
  Variables: {
    runtime: {
      config: ReturnType<typeof createConfig>;
      deliveryLedger: D1DeliveryLedger;
      notificationDispatcher: NotificationDispatcher;
      eventProcessor: DurableEventProcessor;
    };
  };
}
