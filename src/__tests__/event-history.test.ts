import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, drainDueDeliveries } from '../app.js';
import { D1EventHistory } from '../core/services/d1-event-history.js';
import type { D1PreparedStatementLike } from '../core/services/d1-types.js';
import {
  createExecutionContext,
  createTempDatabasePath,
  createTestD1Database,
  createTestEnv,
} from './test-helpers.js';

const secret = 'test-secret';

function starWebhook(deliveryId: string, login: string, senderId = 1): Request {
  const payload = JSON.stringify({
    action: 'created',
    repository: {
      id: 1,
      name: 'repo',
      full_name: 'myorg/repo',
      owner: { login: 'myorg' },
      html_url: 'https://github.com/myorg/repo',
      private: false,
      description: null,
      stargazers_count: 1,
      forks_count: 0,
      language: 'TypeScript',
    },
    sender: {
      id: senderId,
      login,
      avatar_url: 'https://avatars.githubusercontent.com/u/1',
      html_url: `https://github.com/${login}`,
    },
  });

  return new Request('https://example.com/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'star',
      'X-GitHub-Delivery': deliveryId,
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`,
    },
    body: payload,
  });
}

function adminGet(path: string): Request {
  return new Request(`https://example.com/admin${path}`, {
    headers: { Authorization: 'Bearer admin-token' },
  });
}

describe('event history', () => {
  const cleanups: (() => void)[] = [];

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it('keeps every accepted event, once, after its delivery is pruned', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);
    const env = createTestEnv(tempDatabase.databasePath, {
      DELIVERY_SUCCEEDED_RETENTION_DAYS: '14',
    });
    cleanups.push(() => {
      env.DB.close();
    });
    const app = createApp();

    // An event stored by a release that did not record sender history.
    await env.DB.prepare(
      `INSERT INTO events (delivery_id, event_type, repository, received_at, event_json)
       VALUES ('delivery-old', 'star.created', 'myorg/repo', '2026-09-01T10:00:00.000Z', ?)`
    )
      .bind(
        JSON.stringify({
          type: 'star.created',
          action: 'created',
          repository: {
            fullName: 'myorg/repo',
            owner: 'myorg',
            url: 'https://github.com/myorg/repo',
            private: false,
          },
          sender: { id: 3, login: 'carol', url: 'https://github.com/carol', avatarUrl: '' },
          timestamp: '2026-09-01T10:00:00.000Z',
          star: { count: 1 },
        })
      )
      .run();

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T10:00:00.000Z'));
    const first = createExecutionContext();
    await app.fetch(starWebhook('delivery-first', 'alice'), env, first.executionCtx);
    await first.waitForBackground();

    vi.setSystemTime(new Date('2026-10-01T11:00:00.000Z'));
    const second = createExecutionContext();
    await app.fetch(starWebhook('delivery-second', 'bob', 2), env, second.executionCtx);
    await second.waitForBackground();
    // GitHub redelivers within the dedupe window.
    await app.fetch(
      starWebhook('delivery-second', 'bob', 2),
      env,
      createExecutionContext().executionCtx
    );
    // Alice comes back, so a recount would no longer call her first star her first time.
    const third = createExecutionContext();
    await app.fetch(starWebhook('delivery-third', 'alice'), env, third.executionCtx);
    await third.waitForBackground();

    vi.setSystemTime(new Date('2026-10-20T00:00:00.000Z'));
    await drainDueDeliveries(env, { pruneSucceededDeliveries: true });

    const deliveries = await app.fetch(
      adminGet('/deliveries'),
      env,
      createExecutionContext().executionCtx
    );
    await expect(deliveries.json()).resolves.toEqual({ deliveries: [] });

    // Manual redeliveries after pruning are queued again, but recorded only once, and
    // posted with the text they were first accepted with.
    const posts = vi.mocked(fetch);
    posts.mockClear();
    for (const deliveryId of ['delivery-first', 'delivery-old']) {
      await app.fetch(starWebhook(deliveryId, 'alice'), env, createExecutionContext().executionCtx);
    }
    await drainDueDeliveries(env);
    const descriptions = posts.mock.calls.map(
      ([, init]) =>
        (JSON.parse(init?.body as string) as { embeds: [{ description: string }] }).embeds[0]
          .description
    );
    expect(descriptions).toHaveLength(2);
    expect(descriptions).toContainEqual(
      expect.stringMatching(/\[alice\].*\n\n👋 First time here$/s)
    );
    expect(descriptions).toContainEqual(expect.stringMatching(/^\[carol\][^\n]*\n[^\n]*total$/));

    const history = await app.fetch(
      adminGet('/events'),
      env,
      createExecutionContext().executionCtx
    );
    expect(history.status).toBe(200);
    await expect(history.json()).resolves.toMatchObject({
      events: [
        {
          deliveryId: 'delivery-third',
          event: {
            sender: { login: 'alice' },
            senderHistory: {
              firstSeenAt: '2026-10-01T10:00:00.000Z',
              priorEvents: 1,
              priorRepositories: 1,
              priorInRepository: 1,
            },
          },
        },
        {
          deliveryId: 'delivery-second',
          receivedAt: '2026-10-01T11:00:00.000Z',
          event: {
            type: 'star.created',
            sender: { login: 'bob' },
            repository: { fullName: 'myorg/repo', private: false },
            senderHistory: { firstSeenAt: null, priorEvents: 0 },
          },
        },
        { deliveryId: 'delivery-first', event: { senderHistory: { priorEvents: 0 } } },
        { deliveryId: 'delivery-old', event: { sender: { login: 'carol' } } },
      ],
    });
  });

  it('backfills deliveries accepted before the history existed, marked private', async () => {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);
    const migrationsDirectoryUrl = new URL('../../migrations/', import.meta.url);
    const historyMigrationName = '0004_event_history.sql';
    const readMigration = (fileName: string): string =>
      readFileSync(new URL(fileName, migrationsDirectoryUrl), 'utf8');
    const earlierMigrations = readdirSync(migrationsDirectoryUrl)
      .filter((fileName) => fileName.endsWith('.sql') && fileName < historyMigrationName)
      .sort()
      .map(readMigration);

    const database = new Database(tempDatabase.databasePath);
    database.exec(earlierMigrations.join('\n'));
    database
      .prepare(
        `INSERT INTO deliveries (
           delivery_id, source_event_type, normalized_event_type, repository,
           normalized_event_json, accepted_at, status
         ) VALUES (?, 'star', 'star.created', 'myorg/repo', ?, '2026-10-03T15:53:35.324Z', 'succeeded')`
      )
      .run(
        'delivery-before-history',
        JSON.stringify({
          type: 'star.created',
          action: 'created',
          repository: { fullName: 'myorg/repo' },
          sender: { login: 'alice' },
          timestamp: '2026-10-03T15:53:35.000Z',
          star: { count: 1 },
        })
      );
    database.exec(readMigration(historyMigrationName));
    database.close();

    const d1 = createTestD1Database(tempDatabase.databasePath);
    cleanups.push(() => {
      d1.close();
    });

    await expect(new D1EventHistory(d1).listRecentEvents()).resolves.toMatchObject([
      {
        deliveryId: 'delivery-before-history',
        receivedAt: new Date('2026-10-03T15:53:35.324Z'),
        event: {
          type: 'star.created',
          repository: { fullName: 'myorg/repo', private: true },
          timestamp: new Date('2026-10-03T15:53:35.000Z'),
        },
      },
    ]);
  });
});

describe('sender history', () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  /** A migrated database, the history over it, and every query the history prepares. */
  function createHistory(): {
    raw: Database.Database;
    history: D1EventHistory;
    record: (deliveryId: string, repository: string, senderId: number, at: string) => void;
    queries: string[];
  } {
    const tempDatabase = createTempDatabasePath();
    cleanups.push(tempDatabase.cleanup);
    const d1 = createTestD1Database(tempDatabase.databasePath);
    const raw = new Database(tempDatabase.databasePath);
    cleanups.push(() => {
      d1.close();
      raw.close();
    });
    const queries: string[] = [];
    const insert = raw.prepare(
      `INSERT INTO events (delivery_id, event_type, repository, received_at, event_json)
       VALUES (?, 'star.created', ?, ?, ?)`
    );

    return {
      raw,
      history: new D1EventHistory({
        ...d1,
        prepare: (query): D1PreparedStatementLike => {
          queries.push(query);
          return d1.prepare(query);
        },
      }),
      record: (deliveryId, repository, senderId, at): void => {
        insert.run(
          deliveryId,
          repository,
          at,
          JSON.stringify({
            type: 'star.created',
            repository: { fullName: repository },
            sender: { id: senderId, login: `user${String(senderId)}` },
            timestamp: at,
          })
        );
      },
      queries,
    };
  }

  it('counts only the sender’s earlier events, through the sender index', async () => {
    const { raw, history, record, queries } = createHistory();

    await expect(history.readSenderHistory('delivery-new', 7, 'myorg/cli')).resolves.toEqual({
      senderHistory: {
        firstSeenAt: null,
        priorEvents: 0,
        priorRepositories: 0,
        priorInRepository: 0,
      },
    });

    record('delivery-1', 'myorg/cli', 7, '2026-10-02T10:00:00.000Z');
    record('delivery-2', 'myorg/web', 7, '2026-10-01T10:00:00.000Z');
    record('delivery-3', 'myorg/web', 7, '2026-10-03T10:00:00.000Z');
    record('delivery-4', 'myorg/cli', 8, '2026-09-01T10:00:00.000Z');

    await expect(history.readSenderHistory('delivery-new', 7, 'myorg/cli')).resolves.toEqual({
      senderHistory: {
        firstSeenAt: '2026-10-01T10:00:00.000Z',
        priorEvents: 3,
        priorRepositories: 2,
        priorInRepository: 1,
      },
    });
    await expect(history.readSenderHistory('delivery-3', 7, 'myorg/web')).resolves.toMatchObject({
      storedEvent: { repository: { fullName: 'myorg/web' }, sender: { id: 7 } },
    });

    const plan = raw
      .prepare(`EXPLAIN QUERY PLAN ${queries[0] ?? ''}`)
      .all('delivery-new', 'myorg/cli', 7) as { detail: string }[];
    expect(plan.map((step) => step.detail)).toContainEqual(
      expect.stringContaining('USING INDEX idx_events_sender_received_at')
    );
    expect(plan.map((step) => step.detail)).not.toContainEqual(
      expect.stringMatching(/^SCAN events/)
    );
  });
});
