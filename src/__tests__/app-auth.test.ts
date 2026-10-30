import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubAppConfig } from '../config/env.js';
import { Redactor } from '../core/security/redact.js';
import {
  GitHubAppAuth,
  type InstallationTokenRequest,
  READ_TOKEN,
} from '../providers/github/app-auth.js';
import { GitHubInsights } from '../providers/github/github-insights.js';

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' });

const ISSUES_WRITE: InstallationTokenRequest = { permissions: { issues: 'write' } };

function issuesWriteFor(repository: string): InstallationTokenRequest {
  return { ...ISSUES_WRITE, repositories: [repository] };
}

interface Mint {
  jwt: string;
  body: { permissions: Record<string, string>; repositories?: string[] };
  token: string;
}

/**
 * GitHub's token endpoint and API. Each mint answers a new token that expires in an
 * hour, unless `failMint` is set; every other request records the token it used.
 */
function fakeGitHub(options: { failMint?: boolean } = {}): {
  mints: Mint[];
  usedTokens: string[];
} {
  const mints: Mint[] = [];
  const usedTokens: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      const authorization = new Headers(init.headers).get('Authorization') ?? '';
      const bearer = authorization.replace(/^Bearer /, '');
      if (url.endsWith('/access_tokens')) {
        if (options.failMint === true) {
          return Promise.resolve(Response.json({ message: 'Bad credentials' }, { status: 401 }));
        }
        const token = `installation-token-${String(mints.length + 1)}`;
        mints.push({ jwt: bearer, body: JSON.parse(init.body as string) as Mint['body'], token });
        return Promise.resolve(
          Response.json(
            { token, expires_at: new Date(Date.now() + 60 * 60_000).toISOString() },
            { status: 201 }
          )
        );
      }
      usedTokens.push(bearer);
      return Promise.resolve(
        url.endsWith('/graphql') ? Response.json({ data: {} }) : Response.json([])
      );
    })
  );
  return { mints, usedTokens };
}

describe('GitHub App installation tokens', () => {
  // The token cache lives as long as the isolate, so each test uses its own installation.
  let installationId = 1000;
  let app: GitHubAppConfig;

  beforeEach(() => {
    installationId += 1;
    app = { appId: 77, installationId, privateKey };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('signs an RS256 JWT for the App and asks only for read permissions', async () => {
    const github = fakeGitHub();
    await new GitHubAppAuth(app, new Redactor([])).installationToken(READ_TOKEN);

    expect(github.mints).toHaveLength(1);
    const [header, payload, signature] = (github.mints[0]?.jwt ?? '').split('.');
    const decode = (part: string | undefined): unknown =>
      JSON.parse(Buffer.from(part ?? '', 'base64url').toString());
    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const now = Date.parse('2026-10-30T12:00:00.000Z') / 1000;
    expect(decode(payload)).toEqual({ iat: now - 60, exp: now + 540, iss: 77 });
    expect(
      verify(
        'sha256',
        Buffer.from(`${header ?? ''}.${payload ?? ''}`),
        keyPair.publicKey,
        Buffer.from(signature ?? '', 'base64url')
      )
    ).toBe(true);
    expect(github.mints[0]?.body).toEqual({
      permissions: { administration: 'read', contents: 'read', metadata: 'read' },
    });
  });

  it('mints once for a digest and a star alert in the same invocation', async () => {
    const github = fakeGitHub();
    const redactor = new Redactor([]);
    const auth = new GitHubAppAuth(app, redactor);
    const insights = new GitHubInsights(() => auth.installationToken(READ_TOKEN), redactor);

    await Promise.all([
      insights.listUnreleasedWork(['myorg/repo']),
      insights.getUserProfiles(['octocat']),
      insights.listTopReferrers('myorg/repo'),
    ]);

    expect(github.mints).toHaveLength(1);
    expect(github.usedTokens).toEqual([
      'installation-token-1',
      'installation-token-1',
      'installation-token-1',
    ]);
  });

  it('tries a failed mint once per invocation, and every caller goes without', async () => {
    fakeGitHub({ failMint: true });
    const redactor = new Redactor([]);
    const auth = new GitHubAppAuth(app, redactor);
    const insights = new GitHubInsights(() => auth.installationToken(READ_TOKEN), redactor);

    const results = await Promise.allSettled([
      insights.listUnreleasedWork(['myorg/repo']),
      insights.listTopReferrers('myorg/repo'),
      insights.getUserProfiles(['octocat']),
    ]);

    expect(fetch).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result).toMatchObject({
        status: 'rejected',
        reason: new Error('GitHub App token request failed with 401: Bad credentials'),
      });
    }
  });

  it('reuses a token across invocations until five minutes before it expires', async () => {
    const github = fakeGitHub();
    const token = (): Promise<string> =>
      new GitHubAppAuth(app, new Redactor([])).installationToken(READ_TOKEN);

    await expect(token()).resolves.toBe('installation-token-1');
    vi.setSystemTime(new Date('2026-10-30T12:54:59.000Z'));
    await expect(token()).resolves.toBe('installation-token-1');
    vi.setSystemTime(new Date('2026-10-30T12:55:00.000Z'));
    await expect(token()).resolves.toBe('installation-token-2');
    expect(github.mints).toHaveLength(2);
  });

  it('never hands a cached read token to a write request, or the reverse', async () => {
    const github = fakeGitHub();
    const token = (request: InstallationTokenRequest): Promise<string> =>
      new GitHubAppAuth(app, new Redactor([])).installationToken(request);

    await expect(token(READ_TOKEN)).resolves.toBe('installation-token-1');
    await expect(token(ISSUES_WRITE)).resolves.toBe('installation-token-2');
    await expect(token(READ_TOKEN)).resolves.toBe('installation-token-1');
    await expect(token(ISSUES_WRITE)).resolves.toBe('installation-token-2');
    expect(github.mints.map((mint) => mint.body)).toEqual([
      { permissions: READ_TOKEN.permissions },
      { permissions: { issues: 'write' } },
    ]);

    // The other order, on a fresh installation.
    app = { ...app, installationId: app.installationId + 500 };
    await expect(token(ISSUES_WRITE)).resolves.toBe('installation-token-3');
    await expect(token(READ_TOKEN)).resolves.toBe('installation-token-4');
    await expect(token(ISSUES_WRITE)).resolves.toBe('installation-token-3');
  });

  it('mints once for each distinct token requested concurrently in one invocation', async () => {
    const github = fakeGitHub();
    const auth = new GitHubAppAuth(app, new Redactor([]));

    const tokens = await Promise.all([
      auth.installationToken(READ_TOKEN),
      auth.installationToken(ISSUES_WRITE),
      auth.installationToken({
        permissions: { metadata: 'read', contents: 'read', administration: 'read' },
      }),
      auth.installationToken(ISSUES_WRITE),
    ]);

    expect(github.mints).toHaveLength(2);
    expect(tokens[0]).toBe(tokens[2]);
    expect(tokens[1]).toBe(tokens[3]);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('keeps tokens restricted to different repositories apart', async () => {
    const github = fakeGitHub();
    const token = (request: InstallationTokenRequest): Promise<string> =>
      new GitHubAppAuth(app, new Redactor([])).installationToken(request);

    // A then B, then each again from the cache.
    const a = await token(issuesWriteFor('repo-a'));
    const b = await token(issuesWriteFor('repo-b'));
    await expect(token(issuesWriteFor('repo-a'))).resolves.toBe(a);
    await expect(token(issuesWriteFor('repo-b'))).resolves.toBe(b);
    expect(a).not.toBe(b);
    expect(github.mints.map((mint) => mint.body.repositories)).toEqual([['repo-a'], ['repo-b']]);

    // B then A, on a fresh installation.
    app = { ...app, installationId: app.installationId + 500 };
    const laterB = await token(issuesWriteFor('repo-b'));
    const laterA = await token(issuesWriteFor('repo-a'));
    expect(github.mints.slice(2).map((mint) => [mint.body.repositories, mint.token])).toEqual([
      [['repo-b'], laterB],
      [['repo-a'], laterA],
    ]);

    // A and B concurrently in one invocation, on another installation.
    app = { ...app, installationId: app.installationId + 500 };
    const auth = new GitHubAppAuth(app, new Redactor([]));
    const [concurrentA, concurrentB] = await Promise.all([
      auth.installationToken(issuesWriteFor('repo-a')),
      auth.installationToken(issuesWriteFor('repo-b')),
    ]);
    const lastTwo = github.mints.slice(4);
    expect(lastTwo).toHaveLength(2);
    expect(lastTwo.find((mint) => mint.token === concurrentA)?.body.repositories).toEqual([
      'repo-a',
    ]);
    expect(lastTwo.find((mint) => mint.token === concurrentB)?.body.repositories).toEqual([
      'repo-b',
    ]);
  });
});
