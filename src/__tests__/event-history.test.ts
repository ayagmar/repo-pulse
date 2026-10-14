import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, drainDueDeliveries } from '../app.js';
import { D1EventHistory } from '../core/services/d1-event-history.js';
import {
  createExecutionContext,
  createTempDatabasePath,
  createTestD1Database,
  createTestEnv,
} from './test-helpers.js';

const secret = 'test-secret';

function starWebhook(deliveryId: string, login: string): Request {
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
      id: 1,
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

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T10:00:00.000Z'));
    const first = createExecutionContext();
    await app.fetch(starWebhook('delivery-first', 'alice'), env, first.executionCtx);
    await first.waitForBackground();

    vi.setSystemTime(new Date('2026-10-01T11:00:00.000Z'));
    const second = createExecutionContext();
    await app.fetch(starWebhook('delivery-second', 'bob'), env, second.executionCtx);
    await second.waitForBackground();
    // GitHub redelivers within the dedupe window.
    await app.fetch(
      starWebhook('delivery-second', 'bob'),
      env,
      createExecutionContext().executionCtx
    );

    vi.setSystemTime(new Date('2026-10-20T00:00:00.000Z'));
    await drainDueDeliveries(env, { pruneSucceededDeliveries: true });

    const deliveries = await app.fetch(
      adminGet('/deliveries'),
      env,
      createExecutionContext().executionCtx
    );
    await expect(deliveries.json()).resolves.toEqual({ deliveries: [] });

    // A manual redelivery after pruning is queued again, but recorded only once.
    await app.fetch(
      starWebhook('delivery-first', 'alice'),
      env,
      createExecutionContext().executionCtx
    );

    const history = await app.fetch(
      adminGet('/events'),
      env,
      createExecutionContext().executionCtx
    );
    expect(history.status).toBe(200);
    await expect(history.json()).resolves.toMatchObject({
      events: [
        {
          deliveryId: 'delivery-second',
          receivedAt: '2026-10-01T11:00:00.000Z',
          event: {
            type: 'star.created',
            sender: { login: 'bob' },
            repository: { fullName: 'myorg/repo', private: false },
          },
        },
        { deliveryId: 'delivery-first' },
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
