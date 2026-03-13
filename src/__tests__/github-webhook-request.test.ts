import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GitHubWebhookRequestError,
  extractGitHubRepositoryFullName,
  parseGitHubWebhookRequest,
} from '../providers/github/webhook-request.js';

function createSignature(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

describe('parseGitHubWebhookRequest', () => {
  const secret = 'test-secret';

  it('rejects invalid signatures before parsing', async () => {
    const payload = JSON.stringify({
      repository: { full_name: 'owner/repo' },
    });

    await expect(
      parseGitHubWebhookRequest({
        rawBody: payload,
        signature: 'sha256=invalid',
        eventType: 'star',
        deliveryId: 'delivery-1',
        secret,
      })
    ).rejects.toThrowError(new GitHubWebhookRequestError(401, 'Invalid signature'));
  });

  it('rejects missing event headers', async () => {
    const payload = JSON.stringify({
      repository: { full_name: 'owner/repo' },
    });

    await expect(
      parseGitHubWebhookRequest({
        rawBody: payload,
        signature: createSignature(payload, secret),
        eventType: undefined,
        deliveryId: 'delivery-1',
        secret,
      })
    ).rejects.toThrowError(new GitHubWebhookRequestError(400, 'Missing X-GitHub-Event header'));
  });

  it('rejects missing delivery headers', async () => {
    const payload = JSON.stringify({
      repository: { full_name: 'owner/repo' },
    });

    await expect(
      parseGitHubWebhookRequest({
        rawBody: payload,
        signature: createSignature(payload, secret),
        eventType: 'star',
        deliveryId: undefined,
        secret,
      })
    ).rejects.toThrowError(new GitHubWebhookRequestError(400, 'Missing X-GitHub-Delivery header'));
  });

  it('parses valid requests and extracts canonical repository identity', async () => {
    const payload = JSON.stringify({
      action: 'created',
      repository: {
        full_name: 'https://github.com/MyOrg/Repo/',
      },
      sender: { login: 'octocat' },
    });

    const result = await parseGitHubWebhookRequest({
      rawBody: payload,
      signature: createSignature(payload, secret),
      eventType: 'star',
      deliveryId: 'delivery-2',
      secret,
    });

    expect(result.eventType).toBe('star');
    expect(result.deliveryId).toBe('delivery-2');
    expect(result.repository).toBe('MyOrg/Repo');
  });
});

describe('extractGitHubRepositoryFullName', () => {
  it('falls back to owner/name when full_name is missing', () => {
    const repository = extractGitHubRepositoryFullName({
      repository: {
        owner: { login: 'myorg' },
        name: 'repo',
      },
    });

    expect(repository).toBe('myorg/repo');
  });

  it('throws for missing repository identity', () => {
    expect(() =>
      extractGitHubRepositoryFullName({
        repository: {},
      })
    ).toThrow(GitHubWebhookRequestError);
  });
});
