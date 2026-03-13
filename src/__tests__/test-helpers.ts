import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { ConfigEnv } from '../config/env.js';
import {
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
  createRepoEvent,
} from '../core/models/repo-event.js';
import type { RepoEventOf } from '../core/models/repo-event.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../core/services/d1-types.js';

const migrationsDirectoryUrl = new URL('../../migrations/', import.meta.url);
const deliveryLedgerSchemaSql = readdirSync(migrationsDirectoryUrl)
  .filter((fileName) => fileName.endsWith('.sql'))
  .sort()
  .map((fileName) => readFileSync(new URL(fileName, migrationsDirectoryUrl), 'utf8'))
  .join('\n');

export function createTestRepoEvent(): RepoEventOf<typeof REPO_EVENT_TYPES.STAR_CREATED> {
  return createRepoEvent(REPO_EVENT_TYPES.STAR_CREATED, {
    action: REPO_EVENT_ACTIONS.CREATED,
    repository: {
      id: 1,
      name: 'repo',
      fullName: 'myorg/repo',
      owner: 'myorg',
      url: 'https://github.com/myorg/repo',
      description: null,
      stars: 1,
      forks: 0,
      language: 'TypeScript',
    },
    sender: {
      id: 1,
      login: 'octocat',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1',
      url: 'https://github.com/octocat',
    },
    star: {
      count: 1,
    },
  });
}

export function createTempDatabasePath(): { databasePath: string; cleanup: () => void } {
  const tempDir = mkdtempSync(join(tmpdir(), 'repo-pulse-'));

  return {
    databasePath: join(tempDir, 'deliveries.sqlite'),
    cleanup: (): void => {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

class TestD1PreparedStatement implements D1PreparedStatementLike {
  constructor(
    private readonly statement: Database.Statement<unknown[], Record<string, unknown>>,
    private readonly params: readonly unknown[] = []
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new TestD1PreparedStatement(this.statement, values);
  }

  first<Row>(): Promise<Row | null> {
    const row = this.statement.get(...this.params) as Row | undefined;
    return Promise.resolve(row ?? null);
  }

  // The D1 test double mirrors the generic D1 API shape used by the app code.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  all<Row>(): Promise<{ results: Row[]; success: boolean; meta: { changes: number } }> {
    const results = this.statement.all(...this.params) as Row[];
    return Promise.resolve({
      results,
      success: true,
      meta: { changes: 0 },
    });
  }

  run(): Promise<{ success: boolean; meta: { changes: number; last_row_id?: number } }> {
    const result = this.statement.run(...this.params);
    return Promise.resolve({
      success: true,
      meta: {
        changes: result.changes,
        last_row_id: Number(result.lastInsertRowid),
      },
    });
  }
}

interface TestD1Database extends D1DatabaseLike {
  close(): void;
}

type TestEnvOverrides = {
  [Key in keyof ConfigEnv]?: string | undefined;
};

type TestEnv = ConfigEnv & { DB: TestD1Database };

export function createTestD1Database(databasePath: string): TestD1Database {
  const database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  const hasDeliveriesTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deliveries' LIMIT 1")
    .get();
  if (hasDeliveriesTable === undefined) {
    database.exec(deliveryLedgerSchemaSql);
  }

  return {
    prepare(query: string): D1PreparedStatementLike {
      return new TestD1PreparedStatement(
        database.prepare<Record<string, unknown>[], Record<string, unknown>>(query)
      );
    },
    async batch(statements: readonly D1PreparedStatementLike[]): Promise<
      readonly {
        success: boolean;
        meta: { changes: number; last_row_id?: number };
      }[]
    > {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }

      return results;
    },
    exec(sql: string): Promise<void> {
      database.exec(sql);
      return Promise.resolve();
    },
    close(): void {
      database.close();
    },
  };
}

export function createTestEnv(databasePath: string, overrides: TestEnvOverrides = {}): TestEnv {
  return {
    DB: createTestD1Database(databasePath),
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    GITHUB_WEBHOOK_SECRET: 'test-secret',
    ADMIN_API_TOKEN: 'admin-token',
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc',
    ...overrides,
  } as TestEnv;
}

export function createExecutionContext(): {
  executionCtx: ExecutionContext;
  waitForBackground: () => Promise<void>;
} {
  const backgroundTasks: Promise<unknown>[] = [];

  return {
    executionCtx: {
      waitUntil(promise: Promise<unknown>): void {
        backgroundTasks.push(promise);
      },
      passThroughOnException(): void {
        return;
      },
      exports: {} as Cloudflare.Exports,
      props: {},
    },
    async waitForBackground(): Promise<void> {
      await Promise.allSettled(backgroundTasks);
    },
  };
}
