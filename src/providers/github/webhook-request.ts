import type { WebhookSource } from '../../config/env.js';
import { APP_ERROR_CODES, AppError } from '../../core/errors/app-error.js';
import { normalizeRepoFullName } from '../../core/repository-identity.js';
import { requireBoolean, requireNumber, requireObject } from './mappers/validation.js';
import { decodeSignatureHeader, verifyGitHubSignature } from './signature.js';
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

interface GitHubWebhookHeaders {
  signature: string | undefined;
  eventType: string | undefined;
  deliveryId: string | undefined;
}

interface ParseGitHubWebhookInput extends GitHubWebhookHeaders {
  rawBody: string | Uint8Array;
  secret: string;
}

/**
 * A signed delivery. Its repository is read only once the delivery is admitted, so
 * one from an ignored source or repository is never refused for lacking it.
 */
type ParsedGitHubWebhook =
  | { kind: 'control'; deliveryId: string; eventType: string; payload: unknown }
  | {
      kind: 'repository';
      deliveryId: string;
      eventType: string;
      source: WebhookSource;
      payload: GitHubWebhookPayload;
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

/**
 * The event and delivery id of a request whose headers could belong to a GitHub
 * delivery: both present, and a signature that is `sha256=` and 64 hex digits.
 * Needs no body, so a request refused here costs no body read.
 */
export function checkGitHubWebhookHeaders(headers: GitHubWebhookHeaders): {
  eventType: string;
  deliveryId: string;
} {
  if (headers.eventType === undefined || headers.eventType === '') {
    throw new GitHubWebhookRequestError(400, 'Missing X-GitHub-Event header');
  }

  if (headers.deliveryId === undefined || headers.deliveryId === '') {
    throw new GitHubWebhookRequestError(400, 'Missing X-GitHub-Delivery header');
  }

  if (decodeSignatureHeader(headers.signature) === null) {
    throw new GitHubWebhookRequestError(401, 'Invalid signature');
  }

  return { eventType: headers.eventType, deliveryId: headers.deliveryId };
}

export async function parseGitHubWebhookRequest(
  input: ParseGitHubWebhookInput
): Promise<ParsedGitHubWebhook> {
  const { eventType, deliveryId } = checkGitHubWebhookHeaders(input);

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

  if (CONTROL_EVENTS.has(eventType)) {
    return { kind: 'control', deliveryId, eventType, payload };
  }

  return {
    kind: 'repository',
    deliveryId,
    eventType,
    source: webhookSource(payload),
    payload: payload as GitHubWebhookPayload,
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
