import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { ConfigEnv } from '../config/env.js';
import type { RepoEventOf } from '../core/models/repo-event.js';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
} from '../core/models/repo-event.js';
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
      private: false,
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
    return Promise.resolve(this.runNow());
  }

  runNow(): { success: boolean; meta: { changes: number; last_row_id?: number } } {
    const result = this.statement.run(...this.params);
    return {
      success: true,
      meta: {
        changes: result.changes,
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

interface TestD1Database extends D1DatabaseLike {
  close(): void;
}

type TestEnvOverrides = {
  [Key in keyof ConfigEnv]?: string | undefined;
};

type TestEnv = ConfigEnv & {
  DB: TestD1Database;
  FEED_RATE_LIMIT: RateLimit;
  DISCORD_RATE_LIMIT: RateLimit;
};

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
    batch(statements: readonly D1PreparedStatementLike[]): Promise<
      readonly {
        success: boolean;
        meta: { changes: number; last_row_id?: number };
      }[]
    > {
      // A D1 batch is one transaction: a failing statement rolls back the ones before it,
      // and no other query runs in between.
      const runAll = database.transaction(() =>
        statements.map((statement) => {
          if (!(statement instanceof TestD1PreparedStatement)) {
            throw new Error('A batch takes statements prepared on this database');
          }
          return statement.runNow();
        })
      );
      return new Promise((resolve) => {
        resolve(runAll());
      });
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

/**
 * Passes config but cannot sign, so a token mint fails before any request, as a
 * GitHub outage would. Tests that need a token use `mintingApp()`.
 */
const UNUSABLE_APP_KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'test-only',
  '-----END PRIVATE KEY-----',
].join('\n');

/** A fresh PKCS#8 PEM key, so no key is ever committed. */
function generateAppPrivateKey(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

/**
 * Overrides for an App that can mint tokens. Its own installation, because the
 * token cache lives as long as the module: another test on the default installation
 * must not pick up a token minted here.
 */
export function mintingApp(): Pick<
  ConfigEnv,
  'GITHUB_APP_PRIVATE_KEY' | 'GITHUB_APP_INSTALLATION_ID'
> {
  return { GITHUB_APP_PRIVATE_KEY: generateAppPrivateKey(), GITHUB_APP_INSTALLATION_ID: String(2) };
}

/** GitHub's answer to an installation token request, valid past every test clock. */
export function installationTokenResponse(token: string): Response {
  return Response.json({ token, expires_at: '2099-01-01T00:00:00Z' }, { status: 201 });
}

export function createTestEnv(databasePath: string, overrides: TestEnvOverrides = {}): TestEnv {
  return {
    DB: createTestD1Database(databasePath),
    FEED_RATE_LIMIT: { limit: () => Promise.resolve({ success: true }) },
    DISCORD_RATE_LIMIT: { limit: () => Promise.resolve({ success: true }) },
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    GITHUB_WEBHOOK_SECRET: 'test-secret',
    ADMIN_API_TOKEN: 'admin-token',
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/0/test-only',
    GITHUB_APP_ID: String(1),
    GITHUB_APP_INSTALLATION_ID: String(1),
    GITHUB_APP_PRIVATE_KEY: UNUSABLE_APP_KEY,
    ...overrides,
  } as TestEnv;
}

export function createExecutionContext(): {
  executionCtx: ExecutionContext;
  /** Waits for every background task, and says how each ended. */
  waitForBackground: () => Promise<PromiseSettledResult<unknown>[]>;
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
      get tracing(): Tracing {
        throw new Error('Tracing requires the Workers integration test runtime');
      },
      abort(): void {
        throw new Error('Execution context aborted');
      },
    },
    waitForBackground(): Promise<PromiseSettledResult<unknown>[]> {
      return Promise.allSettled(backgroundTasks);
    },
  };
}
