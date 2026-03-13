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

export function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }

  return requireString(value, field);
}

export function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
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

export function requireStringArrayFromObjects(
  value: unknown,
  field: string,
  nestedField: string
): string[] {
  if (!Array.isArray(value)) {
    invalidField(field);
  }

  return value.map((entry, index) => {
    const object = requireObject(entry, `${field}[${String(index)}]`);
    return requireString(object[nestedField], `${field}[${String(index)}].${nestedField}`);
  });
}
