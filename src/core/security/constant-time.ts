const textEncoder = new TextEncoder();

export function encodeUtf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(value)));
}

function fixedLengthConstantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const maxLength = Math.max(left.length, right.length);

  for (let index = 0; index < maxLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return difference === 0;
}

export async function timingSafeEqual(left: Uint8Array, right: Uint8Array): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([sha256(left), sha256(right)]);
  return fixedLengthConstantTimeEqual(leftDigest, rightDigest);
}

export function decodeHex(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 2 !== 0 || /[^a-f0-9]/i.test(value)) {
    return null;
  }

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    const parsed = Number.parseInt(value.slice(index, index + 2), 16);
    if (Number.isNaN(parsed)) {
      return null;
    }

    bytes[index / 2] = parsed;
  }

  return bytes;
}
