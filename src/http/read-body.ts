function parseContentLength(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const normalizedValue = value.trim();
  if (!/^\d+$/.test(normalizedValue)) {
    return null;
  }

  return Number.parseInt(normalizedValue, 10);
}

/**
 * The request body, or null when it is larger than `maxBodyBytes`. The stream is
 * counted as it is read, so a `Content-Length` that understates the size does not
 * get a larger body through.
 */
export async function readBodyWithLimit(
  request: Request,
  maxBodyBytes: number
): Promise<Uint8Array | null> {
  const contentLength = parseContentLength(request.headers.get('Content-Length'));
  if (contentLength !== null && contentLength > maxBodyBytes) {
    return null;
  }

  const body = request.body;
  if (!body) {
    return new Uint8Array();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBodyBytes) {
        await reader.cancel();
        return null;
      }

      chunks.push(value);
    }

    const rawBody = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      rawBody.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return rawBody;
  } finally {
    reader.releaseLock();
  }
}
