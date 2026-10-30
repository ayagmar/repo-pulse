import { decodeHex, encodeUtf8, timingSafeEqual } from '../../core/security/constant-time.js';

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

/** The digest in an `X-Hub-Signature-256` value, or null unless it is `sha256=` and 64 hex digits. */
export function decodeSignatureHeader(signature: string | undefined): Uint8Array | null {
  if (signature?.startsWith('sha256=') !== true) {
    return null;
  }
  const digest = decodeHex(signature.slice('sha256='.length));
  return digest?.byteLength === 32 ? digest : null;
}

/**
 * Verify GitHub webhook signature
 * @param payload Raw request body
 * @param signature X-Hub-Signature-256 header value
 * @param secret Webhook secret
 * @returns boolean indicating if signature is valid
 */
export async function verifyGitHubSignature(
  payload: string | Uint8Array,
  signature: string | undefined,
  secret: string
): Promise<boolean> {
  const receivedSignature = decodeSignatureHeader(signature);
  if (receivedSignature === null) {
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
    const payloadBytes = typeof payload === 'string' ? encodeUtf8(payload) : payload;
    const expectedSignature = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, toArrayBuffer(payloadBytes))
    );
    return await timingSafeEqual(receivedSignature, expectedSignature);
  } catch {
    return false;
  }
}
