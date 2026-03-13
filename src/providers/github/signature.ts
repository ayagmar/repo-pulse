import { decodeHex, encodeUtf8, timingSafeEqual } from '../../core/security/constant-time.js';

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

/**
 * Verify GitHub webhook signature
 * @param payload Raw request body
 * @param signature X-Hub-Signature-256 header value
 * @param secret Webhook secret
 * @returns boolean indicating if signature is valid
 */
export async function verifyGitHubSignature(
  payload: string,
  signature: string | undefined,
  secret: string
): Promise<boolean> {
  if (!signature?.startsWith('sha256=')) {
    return false;
  }

  const receivedSignature = decodeHex(signature.slice('sha256='.length));
  if (!receivedSignature) {
    return false;
  }

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(encodeUtf8(secret)),
      {
        name: 'HMAC',
        hash: 'SHA-256',
      },
      false,
      ['sign']
    );
    const expectedSignature = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, toArrayBuffer(encodeUtf8(payload)))
    );
    return timingSafeEqual(receivedSignature, expectedSignature);
  } catch {
    return false;
  }
}
