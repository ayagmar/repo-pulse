import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeUtf8, timingSafeEqual } from '../core/security/constant-time.js';

function toUint8Array(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

describe('timingSafeEqual', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches equal byte sequences', async () => {
    await expect(timingSafeEqual(encodeUtf8('repo-pulse'), encodeUtf8('repo-pulse'))).resolves.toBe(
      true
    );
  });

  it('rejects different byte sequences', async () => {
    await expect(
      timingSafeEqual(encodeUtf8('repo-pulse'), encodeUtf8('repo-pulse-admin'))
    ).resolves.toBe(false);
  });

  it('hashes variable-length inputs before comparing', async () => {
    const digest = vi.fn((_algorithm: string, value: ArrayBuffer | ArrayBufferView) => {
      const bytes = toUint8Array(value);
      return Promise.resolve(new Uint8Array(32).fill(bytes.byteLength).buffer);
    });

    vi.stubGlobal('crypto', {
      subtle: {
        digest,
      },
    });

    await expect(
      timingSafeEqual(encodeUtf8('short'), encodeUtf8('much-longer-secret'))
    ).resolves.toBe(false);
    expect(digest).toHaveBeenCalledTimes(2);
  });
});
