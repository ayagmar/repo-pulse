export const FAILURE_CLASSIFICATIONS = {
  TRANSIENT: 'transient',
  PERMANENT: 'permanent',
} as const;

export type FailureClassification =
  (typeof FAILURE_CLASSIFICATIONS)[keyof typeof FAILURE_CLASSIFICATIONS];
