import type { FailureClassification } from './failure-classification.js';
import type { RepoEvent } from './repo-event.js';

export const DELIVERY_STATUSES = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
} as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[keyof typeof DELIVERY_STATUSES];

export const DELIVERY_STATUS_VALUES = Object.values(DELIVERY_STATUSES) as DeliveryStatus[];

export interface DeliverySummary {
  deliveryId: string;
  sourceEventType: string;
  eventType: RepoEvent['type'];
  repository: string;
  status: DeliveryStatus;
  acceptedAt: Date;
  nextAttemptAt: Date | null;
  processingStartedAt: Date | null;
  processingFinishedAt: Date | null;
  processingAttempts: number;
  maxAttempts: number;
  providerAttemptCount: number;
  lastError: string | null;
  lastFailureClassification: FailureClassification | null;
}

export interface ProviderAttemptRecord {
  id: number;
  deliveryAttempt: number;
  provider: string;
  attemptedAt: Date;
  success: boolean;
  error: string | null;
}

export interface DeliveryDetails extends DeliverySummary {
  event: RepoEvent;
  attempts: ProviderAttemptRecord[];
}

export interface DeliveryStats {
  total: number;
  pending: number;
  processing: number;
  failed: number;
  succeeded: number;
}
