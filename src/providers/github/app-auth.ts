import type { GitHubAppConfig } from '../../config/env.js';
import { type Redactor, transportFailure, upstreamFailure } from '../../core/security/redact.js';

const API_URL = 'https://api.github.com';
/** A token request, body included, gets this long before the caller goes without. */
const REQUEST_TIMEOUT_MS = 5_000;
/** GitHub rejects a JWT issued in the future, so allow for clock drift. */
const JWT_BACKDATE_SECONDS = 60;
/** GitHub accepts at most 10 minutes. */
const JWT_LIFETIME_SECONDS = 9 * 60;
/** A cached token is replaced this long before GitHub expires it. */
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;

type PermissionLevel = 'read' | 'write';

export interface InstallationTokenRequest {
  permissions: Readonly<Record<string, PermissionLevel>>;
  /** Names, without the owner, of the only repositories the token may access. All when omitted. */
  repositories?: readonly string[];
}

/** What digests and star alerts read: releases, commits and traffic. */
export const READ_TOKEN: InstallationTokenRequest = {
  permissions: { administration: 'read', contents: 'read', metadata: 'read' },
};

interface CachedToken {
  token: string;
  refreshAt: number;
}

/**
 * Completed tokens, kept in isolate memory across invocations. Plain values only: a
 * Worker request must not await a promise another request created.
 */
const isolateTokens = new Map<string, CachedToken>();

/**
 * The cache key: a token is only reused for the same App, installation, permissions
 * and repositories.
 */
function tokenKey(app: GitHubAppConfig, request: InstallationTokenRequest): string {
  const permissions = Object.entries(request.permissions)
    .map(([name, level]) => `${name}:${level}`)
    .sort()
    .join(',');
  const repositories =
    request.repositories === undefined ? '*' : [...request.repositories].sort().join(',');
  return `${String(app.appId)}|${String(app.installationId)}|${permissions}|${repositories}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  try {
    const base64 = pem.replace(/-----(?:BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s/g, '');
    const der = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    return await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
  } catch {
    // The error could describe the key; say only that it failed.
    throw new Error('GitHub App private key could not be imported');
  }
}

/** An RS256 JWT that authenticates as the App for `/app` endpoints. */
export async function signAppJwt(
  appId: number,
  privateKeyPem: string,
  nowSeconds: number
): Promise<string> {
  const signingInput = `${base64UrlJson({ alg: 'RS256', typ: 'JWT' })}.${base64UrlJson({
    iat: nowSeconds - JWT_BACKDATE_SECONDS,
    exp: nowSeconds + JWT_LIFETIME_SECONDS,
    iss: appId,
  })}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    await importPrivateKey(privateKeyPem),
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

/**
 * Installation tokens for the GitHub App. Create one per invocation: within it, the
 * first request for a token starts the acquisition and every later request for the
 * same token gets that result, success or failure, so a failed mint is not retried
 * until the next invocation.
 */
export class GitHubAppAuth {
  private readonly acquisitions = new Map<string, Promise<string>>();

  constructor(
    private readonly app: GitHubAppConfig,
    private readonly redactor: Redactor
  ) {}

  installationToken(request: InstallationTokenRequest): Promise<string> {
    const key = tokenKey(this.app, request);
    let acquisition = this.acquisitions.get(key);
    if (!acquisition) {
      acquisition = this.acquire(key, request);
      this.acquisitions.set(key, acquisition);
    }
    return acquisition;
  }

  private async acquire(key: string, request: InstallationTokenRequest): Promise<string> {
    const cached = isolateTokens.get(key);
    if (cached && Date.now() < cached.refreshAt) {
      this.redactor.add(cached.token);
      return cached.token;
    }

    const { token, expiresAt } = await this.mint(request);
    this.redactor.add(token);
    isolateTokens.set(key, { token, refreshAt: expiresAt - REFRESH_BEFORE_EXPIRY_MS });
    return token;
  }

  /** The response body holds the token, so it is never logged or kept in an error. */
  private async mint(request: InstallationTokenRequest): Promise<{
    token: string;
    expiresAt: number;
  }> {
    const jwt = await signAppJwt(
      this.app.appId,
      this.app.privateKey,
      Math.floor(Date.now() / 1000)
    );
    this.redactor.add(jwt);
    const label = 'GitHub App token request';
    let response: Response;
    let text: string;
    try {
      response = await fetch(
        `${API_URL}/app/installations/${String(this.app.installationId)}/access_tokens`,
        {
          method: 'POST',
          // Also bounds reading the body.
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
            'User-Agent': 'repo-pulse',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({
            permissions: request.permissions,
            ...(request.repositories === undefined
              ? {}
              : { repositories: [...request.repositories] }),
          }),
        }
      );
      text = await response.text();
    } catch (error) {
      // The exception can quote the request, so it is not kept as the cause.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(transportFailure(label, error));
    }
    if (!response.ok) {
      throw new Error(upstreamFailure(label, response.status, text, this.redactor));
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const { token, expires_at: expiresAtText } = (
      typeof body === 'object' && body !== null ? body : {}
    ) as { token?: unknown; expires_at?: unknown };
    const expiresAt = typeof expiresAtText === 'string' ? Date.parse(expiresAtText) : Number.NaN;
    if (typeof token !== 'string' || token === '' || !Number.isFinite(expiresAt)) {
      throw new Error(`${label} returned an unreadable token`);
    }
    return { token, expiresAt };
  }
}
