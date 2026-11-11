function invalidField(field: string): never {
  throw new Error(`Invalid ${field}`);
}

export function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    invalidField(field);
  }

  return value as Record<string, unknown>;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    invalidField(field);
  }

  return value;
}

/** A string, or null when it is null or empty: GitHub sends `""` for cleared text. */
export function requireNullableString(value: unknown, field: string): string | null {
  if (value === null || value === '') {
    return null;
  }

  return requireString(value, field);
}

export function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidField(field);
  }

  return value;
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    invalidField(field);
  }

  return value;
}

export function requireState(value: unknown, field: string): 'open' | 'closed' {
  if (value === 'open' || value === 'closed') {
    return value;
  }

  invalidField(field);
}

export function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    invalidField(field);
  }

  return value;
}

export function requireStringArrayFromObjects(
  value: unknown,
  field: string,
  nestedField: string
): string[] {
  return requireArray(value, field).map((entry, index) => {
    const object = requireObject(entry, `${field}[${String(index)}]`);
    return requireString(object[nestedField], `${field}[${String(index)}].${nestedField}`);
  });
}

const GITHUB_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A GitHub timestamp as ISO 8601 in UTC, or undefined when it is missing or not a
 * valid time. Times are optional facts: an event is not refused for lacking one.
 */
export function optionalTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !GITHUB_TIME.test(value)) {
    return undefined;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** Markdown text a person wrote, or null when it is null, empty or only whitespace. */
export function optionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    invalidField(field);
  }
  return value.trim() === '' ? null : value;
}

/** A non-empty string, or undefined when it is missing or anything else. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A non-negative integer, or undefined when it is missing or anything else. */
export function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** GitHub's `author_association` (`FIRST_TIME_CONTRIBUTOR`), lowercase, or undefined. */
export function optionalAssociation(value: unknown): string | undefined {
  return optionalString(value)?.toLowerCase();
}
