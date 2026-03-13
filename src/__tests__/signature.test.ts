import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGitHubSignature } from '../providers/github/signature.js';

describe('verifyGitHubSignature', () => {
  const secret = 'my-webhook-secret';
  const payload = '{"action":"opened"}';

  it('returns false when signature is missing', async () => {
    await expect(verifyGitHubSignature(payload, undefined, secret)).resolves.toBe(false);
  });

  it('returns false when signature is invalid', async () => {
    await expect(verifyGitHubSignature(payload, 'sha256=invalid', secret)).resolves.toBe(false);
  });

  it('returns false when signature format is wrong', async () => {
    await expect(verifyGitHubSignature(payload, 'invalid-format', secret)).resolves.toBe(false);
  });

  it('verifies valid signature correctly', async () => {
    const expectedSig = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;

    await expect(verifyGitHubSignature(payload, expectedSig, secret)).resolves.toBe(true);
  });

  it('returns false for tampered payload', async () => {
    const originalPayload = '{"action":"opened"}';
    const tamperedPayload = '{"action":"closed"}';
    const sigForOriginal = `sha256=${createHmac('sha256', secret).update(originalPayload).digest('hex')}`;

    await expect(verifyGitHubSignature(tamperedPayload, sigForOriginal, secret)).resolves.toBe(
      false
    );
  });
});
