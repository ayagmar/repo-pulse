const REDACTED = '[redacted]';
/** Upstream error messages are kept to this many characters, after redaction. */
const MESSAGE_LIMIT = 200;
/** Shorter fragments of a key are too likely to match ordinary text. */
const MIN_FRAGMENT_LENGTH = 8;
const URL_PATTERN = /https?:\/\/[^\s"'<>`]+/g;
const CREDENTIAL_QUERY = /[?&](?:access_token|token|key|secret|sig|signature|code|password)=/i;
/** GitHub tokens and JWTs, recognizable whether or not this Worker issued them. */
const TOKEN_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)/g;

/** A URL that carries a credential: user info, a webhook path, or a credential parameter. */
function carriesCredential(url: string): boolean {
  return /^https?:\/\/[^/]*@/i.test(url) || /\/webhooks\//i.test(url) || CREDENTIAL_QUERY.test(url);
}

/**
 * Replaces every known secret value, any GitHub token or JWT, and any URL carrying
 * a credential with `[redacted]`. Tokens minted at run time are added as they are
 * created.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  constructor(secrets: Iterable<string | undefined>) {
    for (const secret of secrets) {
      if (secret !== undefined) {
        this.add(secret);
      }
    }
  }

  /** Every configured value is redacted whole, however short. */
  add(secret: string): void {
    for (const value of [secret, secret.trim()]) {
      if (value !== '') {
        this.secrets.add(value);
      }
    }
    for (const fragment of pemBodyLines(secret)) {
      if (fragment.length >= MIN_FRAGMENT_LENGTH) {
        this.secrets.add(fragment);
      }
    }
  }

  redact(text: string): string {
    let redacted = text;
    // Longest first, so a secret containing another is replaced whole.
    for (const secret of [...this.secrets].sort((left, right) => right.length - left.length)) {
      redacted = redacted.split(secret).join(REDACTED);
    }
    return redacted
      .replace(TOKEN_PATTERN, REDACTED)
      .replace(URL_PATTERN, (url) => (carriesCredential(url) ? REDACTED : url));
  }
}

/** The base64 lines of a PEM key, so a fragment of the key is redacted too. */
function pemBodyLines(value: string): string[] {
  if (!value.includes('-----BEGIN')) {
    return [];
  }
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('-----'));
}

/**
 * A fixed description of a request that got no response. The exception's own text
 * can contain the request URL or headers, so it is never kept.
 */
export function transportFailure(request: string, error: unknown): string {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : '';
  const timedOut = name === 'TimeoutError' || name === 'AbortError';
  return `${request} failed: ${timedOut ? 'timeout' : 'network error'}`;
}

/**
 * An upstream error: its status, plus the `message` field of a JSON body, redacted
 * and bounded. Any other body is dropped.
 */
export function upstreamFailure(
  request: string,
  status: number,
  body: string,
  redactor: Redactor
): string {
  const message = upstreamMessage(body);
  const description = `${request} failed with ${String(status)}`;
  return message === undefined
    ? description
    : `${description}: ${redactor.redact(message).slice(0, MESSAGE_LIMIT)}`;
}

function upstreamMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' &&
      parsed !== null &&
      'message' in parsed &&
      typeof parsed.message === 'string' &&
      parsed.message !== ''
      ? parsed.message
      : undefined;
  } catch {
    return undefined;
  }
}

/** Redact and bound a message from upstream that is not an HTTP error body. */
export function boundedMessage(message: string, redactor: Redactor): string {
  return redactor.redact(message).slice(0, MESSAGE_LIMIT);
}
