const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

type LogFields = Record<string, unknown>;

const LOG_PRIORITIES: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

interface LoggerOptions {
  level: LogLevel;
  service: string;
}

class StructuredLogger {
  constructor(private readonly options: LoggerOptions) {}

  setLevel(level: LogLevel): void {
    this.options.level = level;
  }

  debug(message: string, fields: LogFields = {}): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields: LogFields = {}): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields: LogFields): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: this.options.service,
      message,
      ...serializeLogFields(fields),
    });

    switch (level) {
      case 'debug':
        console.debug(entry);
        return;
      case 'info':
        console.info(entry);
        return;
      case 'warn':
        console.warn(entry);
        return;
      case 'error':
        console.error(entry);
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_PRIORITIES[level] >= LOG_PRIORITIES[this.options.level];
  }
}

function serializeLogFields(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, serializeLogValue(value)])
  );
}

function serializeLogValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => serializeLogValue(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, serializeLogValue(nestedValue)])
    );
  }

  return value;
}

export function createLogger(level: LogLevel, service: string): StructuredLogger {
  return new StructuredLogger({ level, service });
}

export const logger = createLogger('info', 'repo-pulse');
