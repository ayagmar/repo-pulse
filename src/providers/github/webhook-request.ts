import { APP_ERROR_CODES, AppError } from '../../core/errors/app-error.js';
import { normalizeRepoFullName } from '../../core/repository-identity.js';
import { verifyGitHubSignature } from './signature.js';
import type { GitHubWebhookPayload } from './types.js';

interface ParseGitHubWebhookInput {
  rawBody: string;
  signature: string | undefined;
  eventType: string | undefined;
  deliveryId: string | undefined;
  secret: string;
}

interface ParsedGitHubWebhook {
  deliveryId: string;
  eventType: string;
  payload: GitHubWebhookPayload;
  repository: string;
}

export class GitHubWebhookRequestError extends AppError {
  constructor(statusCode: 400 | 401 | 413, message: string) {
    super(
      statusCode,
      statusCode === 401
        ? APP_ERROR_CODES.INVALID_WEBHOOK_SIGNATURE
        : APP_ERROR_CODES.INVALID_WEBHOOK_REQUEST,
      message
    );
    this.name = 'GitHubWebhookRequestError';
  }
}

export async function parseGitHubWebhookRequest(
  input: ParseGitHubWebhookInput
): Promise<ParsedGitHubWebhook> {
  if (!input.eventType) {
    throw new GitHubWebhookRequestError(400, 'Missing X-GitHub-Event header');
  }

  if (!input.deliveryId) {
    throw new GitHubWebhookRequestError(400, 'Missing X-GitHub-Delivery header');
  }

  if (!(await verifyGitHubSignature(input.rawBody, input.signature, input.secret))) {
    throw new GitHubWebhookRequestError(401, 'Invalid signature');
  }

  let payload: unknown;

  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    throw new GitHubWebhookRequestError(400, 'Invalid JSON payload');
  }

  return {
    deliveryId: input.deliveryId,
    eventType: input.eventType,
    payload: payload as GitHubWebhookPayload,
    repository: extractGitHubRepositoryFullName(payload),
  };
}

export function extractGitHubRepositoryFullName(payload: unknown): string {
  const repository = getObjectField(payload, 'repository');
  const fullName = getStringField(repository, 'full_name');

  if (fullName) {
    return normalizeRepositoryIdentity(fullName);
  }

  const owner = getObjectField(repository, 'owner');
  const ownerLogin = getStringField(owner, 'login');
  const name = getStringField(repository, 'name');

  if (!(ownerLogin && name)) {
    throw new GitHubWebhookRequestError(400, 'Missing repository identity');
  }

  return normalizeRepositoryIdentity(`${ownerLogin}/${name}`);
}

function normalizeRepositoryIdentity(value: string): string {
  try {
    return normalizeRepoFullName(value);
  } catch {
    throw new GitHubWebhookRequestError(400, `Invalid repository identity: ${value}`);
  }
}

function getObjectField(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || !(field in value)) {
    throw new GitHubWebhookRequestError(400, `Missing ${field} data`);
  }

  const fieldValue = (value as Record<string, unknown>)[field];

  if (typeof fieldValue !== 'object' || fieldValue === null) {
    throw new GitHubWebhookRequestError(400, `Invalid ${field} data`);
  }

  return fieldValue as Record<string, unknown>;
}

function getStringField(value: Record<string, unknown>, field: string): string | undefined {
  const fieldValue = value[field];
  return typeof fieldValue === 'string' ? fieldValue : undefined;
}
