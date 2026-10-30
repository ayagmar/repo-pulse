import type { WebhookSource } from '../../config/webhook-policy.js';
import { APP_ERROR_CODES, AppError } from '../../core/errors/app-error.js';
import { normalizeRepoFullName } from '../../core/repository-identity.js';
import { requireBoolean, requireNumber, requireObject } from './mappers/validation.js';
import { verifyGitHubSignature } from './signature.js';
import type { GitHubWebhookPayload } from './types.js';

/**
 * Events about the webhook or the App installation itself. They are acknowledged
 * once signed, with or without a repository, and never become notifications.
 */
const CONTROL_EVENTS: ReadonlySet<string> = new Set([
  'ping',
  'installation',
  'installation_repositories',
]);

interface ParseGitHubWebhookInput {
  rawBody: string | Uint8Array;
  signature: string | undefined;
  eventType: string | undefined;
  deliveryId: string | undefined;
  secret: string;
}

type ParsedGitHubWebhook =
  | {
      kind: 'control';
      deliveryId: string;
      eventType: string;
      payload: unknown;
      repository?: undefined;
    }
  | {
      kind: 'repository';
      deliveryId: string;
      eventType: string;
      source: WebhookSource;
      payload: GitHubWebhookPayload;
      /** Undefined only for an App delivery, which is checked for admission first. */
      repository: string | undefined;
    };

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
  if (input.eventType === undefined || input.eventType === '') {
    throw new GitHubWebhookRequestError(400, 'Missing X-GitHub-Event header');
  }

  if (input.deliveryId === undefined || input.deliveryId === '') {
    throw new GitHubWebhookRequestError(400, 'Missing X-GitHub-Delivery header');
  }

  if (!(await verifyGitHubSignature(input.rawBody, input.signature, input.secret))) {
    throw new GitHubWebhookRequestError(401, 'Invalid signature');
  }

  let payload: unknown;

  try {
    const bodyText =
      typeof input.rawBody === 'string'
        ? input.rawBody
        : new TextDecoder('utf-8', { fatal: true }).decode(input.rawBody);
    payload = JSON.parse(bodyText);
  } catch {
    throw new GitHubWebhookRequestError(400, 'Invalid JSON payload');
  }

  if (CONTROL_EVENTS.has(input.eventType)) {
    return { kind: 'control', deliveryId: input.deliveryId, eventType: input.eventType, payload };
  }

  const source = webhookSource(payload);
  return {
    kind: 'repository',
    deliveryId: input.deliveryId,
    eventType: input.eventType,
    source,
    payload: payload as GitHubWebhookPayload,
    // A repository webhook without a repository is a bad request, as before. An App
    // delivery may come from a repository it ignores, so it is checked first.
    repository: source === 'repository' ? extractGitHubRepositoryFullName(payload) : undefined,
  };
}

/** App deliveries carry the installation they were sent for; repository webhooks do not. */
function webhookSource(payload: unknown): WebhookSource {
  return typeof payload === 'object' && payload !== null && 'installation' in payload
    ? 'app'
    : 'repository';
}

/**
 * Why an App delivery is not admitted, or null when it is: it must come from the
 * configured installation and from a public repository that is not a fork. A
 * missing, null or mistyped field rejects it.
 */
export function rejectAppDelivery(payload: unknown, installationId: number): string | null {
  try {
    const body = requireObject(payload, 'payload');
    const installation = requireObject(body.installation, 'installation');
    if (requireNumber(installation.id, 'installation.id') !== installationId) {
      return 'installation.id is not GITHUB_APP_INSTALLATION_ID';
    }
    const repository = requireObject(body.repository, 'repository');
    if (requireBoolean(repository.private, 'repository.private')) {
      return 'private repository';
    }
    if (requireBoolean(repository.fork, 'repository.fork')) {
      return 'fork';
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid payload';
  }
}

export function extractGitHubRepositoryFullName(payload: unknown): string {
  const repository = getObjectField(payload, 'repository');
  const fullName = getStringField(repository, 'full_name');

  if (fullName !== undefined && fullName !== '') {
    return normalizeRepositoryIdentity(fullName);
  }

  const owner = getObjectField(repository, 'owner');
  const ownerLogin = getStringField(owner, 'login');
  const name = getStringField(repository, 'name');

  if (ownerLogin === undefined || ownerLogin === '' || name === undefined || name === '') {
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
