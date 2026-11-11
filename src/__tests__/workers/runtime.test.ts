import {
  applyD1Migrations,
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRepoEvent,
  REPO_EVENT_ACTIONS,
  REPO_EVENT_TYPES,
  type RepoEvent,
  serializeRepoEvent,
} from '../../core/models/repo-event.js';
import { Redactor } from '../../core/security/redact.js';
import { D1DeliveryLedger } from '../../core/services/d1-delivery-ledger.js';
import { D1DiscordActions } from '../../core/services/d1-discord-actions.js';
import {
  D1EventHistory,
  type ThreadActivityMaterial,
} from '../../core/services/d1-event-history.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../../core/services/d1-types.js';
import { dueDigestWindow } from '../../core/services/digest.js';
import { DurableEventProcessor } from '../../core/services/durable-event-processor.js';
import { NotificationDispatcher } from '../../core/services/notification-dispatcher.js';
import { summarizeThreadActivity } from '../../core/services/thread-activity.js';
import worker from '../../index.js';
import { signAppJwt } from '../../providers/github/app-auth.js';

// Local workerd/D1 integration only: no remote bindings, secrets or outbound requests.
describe('Workers runtime integration', () => {
  const ledger = new D1DeliveryLedger(env.DB);
  const event = createRepoEvent(REPO_EVENT_TYPES.STAR_CREATED, {
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
      avatarUrl: 'https://example.com/avatar',
      url: 'https://github.com/octocat',
    },
    star: { count: 1 },
  });

  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM deliveries').run();
    await env.DB.prepare('DELETE FROM events').run();
    await env.DB.prepare('DELETE FROM digest_sends').run();
    await env.DB.prepare('DELETE FROM feature_activations').run();
    await env.DB.prepare('DELETE FROM star_milestone_baselines').run();
    await env.DB.prepare('DELETE FROM star_milestones').run();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('protects the admin surface through the exported Worker', async () => {
    const denied = await exports.default.fetch(new Request('https://example.com/admin/status'));
    expect(denied.status).toBe(401);
    const allowed = await exports.default.fetch(
      new Request('https://example.com/admin/status', {
        headers: { Authorization: 'Bearer admin-token' },
      })
    );
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ deliveryLedger: { total: 0 } });
  });

  it('verifies original webhook bytes before decoding JSON, including a UTF-8 BOM', async () => {
    const text = JSON.stringify({ repository: { full_name: 'myorg/repo' }, sender: {} });
    const encoded = new TextEncoder().encode(text);
    const body = new Uint8Array(encoded.length + 3);
    body.set([0xef, 0xbb, 0xbf]);
    body.set(encoded, 3);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('test-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
    const signature = `sha256=${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const headers = {
      'X-GitHub-Event': 'ping',
      'X-GitHub-Delivery': 'bom',
      'X-Hub-Signature-256': signature,
    };
    const valid = await exports.default.fetch(
      new Request('https://example.com/webhook', {
        method: 'POST',
        headers,
        body,
      })
    );
    expect(valid.status).toBe(200);
    const changed = await exports.default.fetch(
      new Request('https://example.com/webhook', {
        method: 'POST',
        headers,
        body: encoded,
      })
    );
    expect(changed.status).toBe(401);
  });

  it('rejects oversized streamed bodies even when Content-Length understates their size', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array(524_288));
        controller.enqueue(new Uint8Array(524_289));
        controller.close();
      },
    });
    const response = await exports.default.fetch(
      new Request('https://example.com/webhook', {
        method: 'POST',
        // Well-formed GitHub headers, so the request gets as far as reading the body.
        headers: {
          'Content-Length': '10',
          'X-GitHub-Event': 'ping',
          'X-GitHub-Delivery': 'oversized',
          'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}`,
        },
        body,
      })
    );
    expect(response.status).toBe(413);
    await expect(ledger.getStats()).resolves.toMatchObject({ total: 0 });
  });

  it('claims a persisted delivery only once when two D1 consumers race', async () => {
    await ledger.persistAcceptedDelivery({
      deliveryId: 'race',
      sourceEventType: 'star',
      repository: event.repository.fullName,
      event,
      maxAttempts: 5,
    });
    const claims = await Promise.all([
      ledger.claimNextPendingDelivery(new Date(), 1000),
      ledger.claimNextPendingDelivery(new Date(), 1000),
    ]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    await expect(ledger.getDelivery('race')).resolves.toMatchObject({ processingAttempts: 1 });
  });

  it('records an accepted delivery in the event history in the same D1 batch', async () => {
    await expect(
      ledger.persistAcceptedDelivery({
        deliveryId: 'recorded',
        sourceEventType: 'star',
        repository: event.repository.fullName,
        event,
        maxAttempts: 5,
      })
    ).resolves.toEqual({ outcome: 'accepted' });
    await expect(
      ledger.persistAcceptedDelivery({
        deliveryId: 'recorded',
        sourceEventType: 'star',
        repository: event.repository.fullName,
        event,
        maxAttempts: 5,
      })
    ).resolves.toEqual({ outcome: 'duplicate' });

    await expect(new D1EventHistory(env.DB).listRecentEvents()).resolves.toMatchObject([
      { deliveryId: 'recorded', event: { type: 'star.created' } },
    ]);
  });

  /** Real D1, and the rows D1 says the last statement read. */
  function countingRowsRead(): { db: D1DatabaseLike; rowsRead: () => number } {
    let rowsRead = Number.NaN;
    const counted = async <Result extends D1Result>(pending: Promise<Result>): Promise<Result> => {
      const result = await pending;
      rowsRead = result.meta.rows_read;
      return result;
    };
    const db = {
      prepare: (query: string): Pick<D1PreparedStatement, 'bind'> => {
        const statement = env.DB.prepare(query);
        return {
          bind: (...values: unknown[]): D1PreparedStatement => {
            const bound = statement.bind(...values);
            return Object.assign(Object.create(bound) as D1PreparedStatement, {
              all: <Row>(): Promise<D1Result<Row>> => counted(bound.all<Row>()),
              run: (): Promise<D1Result> => counted(bound.run()),
            });
          },
        };
      },
    } as unknown as D1DatabaseLike;
    return { db, rowsRead: () => rowsRead };
  }

  /** The digest's thread read on real D1, and the rows D1 says it read. */
  async function readThreadsCountingRows(
    now: number
  ): Promise<{ material: ThreadActivityMaterial; rowsRead: number }> {
    const { db, rowsRead } = countingRowsRead();
    const material = await new D1EventHistory(db).readThreadActivity(
      new Date(now - 90 * 24 * 3_600_000),
      { threads: 200, eventsPerThread: 100, rows: 2000 }
    );
    return { material, rowsRead: rowsRead() };
  }

  it('prunes expired succeeded deliveries on real D1, reading rows by what expired, not what is kept', async () => {
    const insertDelivery = (
      id: string,
      status: string,
      finishedAt: string | null
    ): D1PreparedStatement =>
      env.DB.prepare(
        `INSERT INTO deliveries (
           delivery_id, source_event_type, normalized_event_type, repository,
           normalized_event_json, accepted_at, status, processing_finished_at
         ) VALUES (?, 'star', 'star.created', 'myorg/repo', '{}', ?, ?, ?)`
      ).bind(id, finishedAt ?? '2026-01-01T00:00:00.000Z', status, finishedAt);
    const olderThan = new Date('2026-06-01T00:00:00.000Z');
    const expired = '2026-05-31T23:59:59.999Z';
    // Five thousand rows still inside retention, as the cron finds the ledger every minute.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 4999)
       INSERT INTO deliveries (
         delivery_id, source_event_type, normalized_event_type, repository,
         normalized_event_json, accepted_at, status, processing_finished_at
       )
       SELECT 'kept-' || i, 'star', 'star.created', 'myorg/repo', '{}', ?1, 'succeeded', ?1 FROM n`
    )
      .bind(olderThan.toISOString())
      .run();
    const { db, rowsRead } = countingRowsRead();
    const counted = new D1DeliveryLedger(db);

    await expect(counted.pruneSucceededDeliveries(olderThan)).resolves.toBe(0);
    expect(rowsRead()).toBeLessThanOrEqual(1);

    await env.DB.batch([
      insertDelivery('expired-1', 'succeeded', expired),
      insertDelivery('expired-2', 'succeeded', '2026-01-01T00:00:00.000Z'),
      insertDelivery('old-failed', 'failed', expired),
      insertDelivery('old-pending', 'pending', null),
      insertDelivery('unfinished', 'succeeded', null),
      env.DB.prepare(
        `INSERT INTO provider_attempts (
           delivery_id, delivery_attempt, provider_name, attempted_at, success
         ) VALUES ('expired-1', 1, 'discord', ?1, 1), ('old-failed', 1, 'discord', ?1, 0)`
      ).bind(expired),
    ]);

    await counted.pruneSucceededDeliveries(olderThan);
    expect(rowsRead()).toBeLessThan(20);

    const left = await env.DB.prepare(
      `SELECT delivery_id AS id FROM deliveries WHERE delivery_id NOT LIKE 'kept-%' ORDER BY id`
    ).all<{ id: string }>();
    expect(left.results.map((row) => row.id)).toEqual(['old-failed', 'old-pending', 'unfinished']);
    await expect(ledger.getStats()).resolves.toMatchObject({ total: 5003, succeeded: 5001 });
    const attempts = await env.DB.prepare('SELECT delivery_id AS id FROM provider_attempts').all<{
      id: string;
    }>();
    expect(attempts.results).toEqual([{ id: 'old-failed' }]);
  });

  it('reads who is waiting on real D1, reading rows by thread rather than by history size', async () => {
    const now = Date.now();
    const at = (hoursAgo: number): string => new Date(now - hoursAgo * 3_600_000).toISOString();
    // Ten thousand unrelated rows: recent stars, and issues of another repository last
    // active long before the lookback.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 4999)
       INSERT INTO events (delivery_id, event_type, repository, received_at, event_json)
       SELECT 'star-' || i, 'star.created', 'myorg/other', ?, '{}' FROM n
       UNION ALL
       SELECT 'old-' || i, 'issue.opened', 'myorg/other', '2025-01-01T00:00:00.000Z',
         json_object('repository', json_object('id', 9), 'issue', json_object('number', i))
       FROM n`
    )
      .bind(at(1))
      .run();
    const thread = {
      kind: 'issue' as const,
      number: 5,
      title: 'Crash on start',
      url: 'https://github.com/myorg/repo/issues/5',
      state: 'open' as const,
      draft: null,
      createdAt: at(30),
    };
    const comment = (id: number, login: string, hoursAgo: number): RepoEvent =>
      createRepoEvent(REPO_EVENT_TYPES.COMMENT_CREATED, {
        action: REPO_EVENT_ACTIONS.CREATED,
        repository: event.repository,
        sender: { ...event.sender, id, login },
        occurredAt: at(hoursAgo),
        thread,
        comment: { id, url: `${thread.url}#issuecomment-${String(id)}`, body: 'Any news?' },
      });
    // The owner's comment is recorded only, and activates the feature in the same batch.
    for (const [deliveryId, stored, outcome] of [
      ['reply', { ...comment(1, 'myorg', 20), alert: false as const }, 'recorded'],
      ['question', comment(2, 'alice', 10), 'accepted'],
    ] as const) {
      await expect(
        ledger.persistAcceptedDelivery({
          deliveryId,
          sourceEventType: 'issue_comment',
          repository: 'myorg/repo',
          event: stored,
          maxAttempts: 5,
        })
      ).resolves.toEqual({ outcome });
    }
    await expect(ledger.getStats()).resolves.toMatchObject({ total: 1 });

    const { material, rowsRead } = await readThreadsCountingRows(now);

    expect(material.activatedAt).toBe(at(20));
    expect(
      summarizeThreadActivity(material, { start: new Date(0), end: new Date(now) }, new Set())
        .waiting
    ).toMatchObject([{ number: 5, login: 'alice', since: new Date(at(10)) }]);
    expect(rowsRead).toBeLessThan(50);
  });

  it('bounds the rows read for a selected thread with a long history, and leaves it out', async () => {
    const now = Date.now();
    const recent = new Date(now - 3_600_000).toISOString();
    await env.DB.prepare(
      `INSERT INTO feature_activations (feature, activated_at, delivery_id)
       VALUES ('thread_replies', '2025-01-01T00:00:00.000Z', 'first')`
    ).run();
    // Ten thousand old comments on one thread, and one recent, which selects it.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
       INSERT INTO events (delivery_id, event_type, repository, received_at, event_json)
       SELECT 'comment-' || i, 'comment.created', 'myorg/repo',
         CASE WHEN i = 10000 THEN ? ELSE '2025-06-01T00:00:00.000Z' END,
         json_object(
           'repository', json_object('id', 1, 'fullName', 'myorg/repo', 'owner', 'myorg'),
           'sender', json_object('id', 2, 'login', 'alice'),
           'occurredAt', CASE WHEN i = 10000 THEN ? ELSE '2025-06-01T00:00:00.000Z' END,
           'thread', json_object('kind', 'issue', 'number', 6, 'title', 'Long', 'url', 'u',
             'state', 'open', 'draft', json('null')),
           'comment', json_object('id', i, 'url', 'u', 'body', 'Hi')
         )
       FROM n`
    )
      .bind(recent, recent)
      .run();

    const { material, rowsRead } = await readThreadsCountingRows(now);

    expect(material.rows.length).toBeLessThanOrEqual(101);
    const summary = summarizeThreadActivity(
      material,
      { start: new Date(0), end: new Date(now) },
      new Set()
    );
    expect(summary).toMatchObject({ waiting: [], incompleteThreads: 1 });
    expect(rowsRead).toBeLessThan(1000);
  });

  it('persists notification outcomes using real D1 batch and RETURNING semantics', async () => {
    const dispatcher = new NotificationDispatcher(new Redactor([]));
    dispatcher.add({
      name: 'test',
      isConfigured: () => true,
      notify: () => Promise.resolve({ success: true, provider: 'test' }),
      notifyDigest: () => Promise.reject(new Error('Not used in this test')),
      notifyAlert: () => Promise.reject(new Error('Not used in this test')),
    });
    const processor = new DurableEventProcessor(ledger, dispatcher);
    await processor.enqueue(event, {
      deliveryId: 'complete',
      sourceEventType: 'star',
      repository: event.repository.fullName,
    });
    await processor.drainDueDeliveries();
    await expect(ledger.getDelivery('complete')).resolves.toMatchObject({
      status: 'succeeded',
      processingAttempts: 1,
      providerAttemptCount: 1,
    });
  });

  it('decides star milestones in one real D1 batch: all of it or none, once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const starAt = (count: number): RepoEvent => ({
      ...event,
      repository: { ...event.repository, stars: count },
      star: { count },
    });
    const accept = (
      count: number,
      deliveryId: string,
      db: D1DatabaseLike = env.DB
    ): ReturnType<DurableEventProcessor['enqueue']> =>
      new DurableEventProcessor(
        new D1DeliveryLedger(db),
        new NotificationDispatcher(new Redactor([]))
      ).enqueue(starAt(count), {
        deliveryId,
        sourceEventType: 'star',
        repository: event.repository.fullName,
      });
    const milestones = async (): Promise<unknown[]> =>
      (
        await env.DB.prepare(
          `SELECT 'baseline' AS kind, seen_count AS count, delivery_id AS deliveryId
           FROM star_milestone_baselines
           UNION ALL
           SELECT 'milestone', milestone, delivery_id FROM star_milestones
           ORDER BY kind, count`
        ).all()
      ).results;
    const storedMilestone = async (deliveryId: string): Promise<unknown> => {
      const stored = await new D1EventHistory(env.DB).findEvent(deliveryId);
      return stored !== null && 'starMilestone' in stored ? stored.starMilestone : undefined;
    };
    /** D1 failing once, when it runs the first statement containing `sql`. */
    const failingOnce = (sql: string): D1DatabaseLike => {
      let failed = false;
      return {
        prepare: (query): D1PreparedStatementLike => {
          if (failed || !query.includes(sql)) {
            return env.DB.prepare(query);
          }
          failed = true;
          const parameters = query
            .split('?')
            .slice(1)
            .map(() => '?');
          return env.DB.prepare(`SELECT ${parameters.join(', ')} FROM missing_table`);
        },
        batch: (statements) => env.DB.batch(statements as D1PreparedStatement[]),
        exec: (query) => env.DB.exec(query),
      };
    };

    await accept(95, 'seen');
    // The snapshot fails after the claim ran: the claim and the snapshot are both undone.
    await expect(accept(100, 'failed', failingOnce("'$.starMilestone'"))).resolves.toEqual({
      outcome: 'accepted',
    });
    await expect(storedMilestone('failed')).resolves.toBeUndefined();
    await expect(milestones()).resolves.toEqual([
      { kind: 'baseline', count: 95, deliveryId: 'seen' },
    ]);

    // Two deliveries racing for 100: one takes it.
    await Promise.all([accept(100, 'left'), accept(101, 'right')]);
    const [left, right] = await Promise.all([storedMilestone('left'), storedMilestone('right')]);
    expect([left, right].filter((stored) => stored !== undefined)).toEqual([
      {
        milestone: 100,
        reachedAt: expect.any(String) as unknown,
        previous: null,
        recentStars: { since: expect.any(String) as unknown, net: 3 },
      },
    ]);

    // A batch that commits but whose answer is lost, then redelivered after pruning.
    const losing: D1DatabaseLike = {
      prepare: (query) => env.DB.prepare(query),
      batch: async (statements) => {
        await env.DB.batch(statements as D1PreparedStatement[]);
        throw new Error('Network connection lost');
      },
      exec: (query) => env.DB.exec(query),
    };
    await expect(accept(250, 'lost', losing)).rejects.toThrow('Network connection lost');
    const celebrated = await storedMilestone('lost');
    expect(celebrated).toMatchObject({ milestone: 250, previous: { milestone: 100 } });
    await env.DB.prepare("DELETE FROM deliveries WHERE delivery_id = 'lost'").run();
    await expect(accept(260, 'lost')).resolves.toEqual({ outcome: 'accepted' });
    await expect(ledger.getDelivery('lost')).resolves.toMatchObject({
      event: { star: { count: 250 }, starMilestone: celebrated },
    });
    await expect(milestones()).resolves.toEqual([
      { kind: 'baseline', count: 95, deliveryId: 'seen' },
      {
        kind: 'milestone',
        count: 100,
        deliveryId: expect.stringMatching(/^(left|right)$/) as unknown,
      },
      { kind: 'milestone', count: 250, deliveryId: 'lost' },
    ]);
  });

  it("follows Morocco's clock changes with the runtime's time zone data", () => {
    // 09:00 in Morocco was 08:00 UTC in June 2026 (UTC+1) and is 09:00 UTC since the
    // move to UTC+0 on 20 September 2026.
    expect(
      dueDigestWindow(new Date('2026-06-15T08:00:00.000Z'), 'Africa/Casablanca', 9)
    ).toMatchObject({
      date: '2026-06-15',
    });
    expect(
      dueDigestWindow(new Date('2026-10-15T08:00:00.000Z'), 'Africa/Casablanca', 9)
    ).toBeNull();
    expect(dueDigestWindow(new Date('2026-10-15T09:00:00.000Z'), 'Africa/Casablanca', 9)).toEqual({
      period: 'daily',
      date: '2026-10-15',
      start: new Date('2026-10-14T09:00:00.000Z'),
      end: new Date('2026-10-15T09:00:00.000Z'),
    });
  });

  it('posts the daily digest from the scheduled handler at the configured local hour', async () => {
    // A stubbed Discord: this suite makes no outbound requests.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    await env.DB.prepare(
      `INSERT INTO events (delivery_id, event_type, repository, received_at, event_json)
       VALUES ('digest-star', 'star.created', 'myorg/repo', '2026-10-14T12:00:00.000Z', ?)`
    )
      .bind(serializeRepoEvent(event))
      .run();

    // wrangler.jsonc sets the digest to 09:00 Africa/Casablanca, which is UTC+0 since
    // 20 September 2026.
    const context = createExecutionContext();
    worker.scheduled(
      createScheduledController({
        scheduledTime: new Date('2026-10-15T09:00:00.000Z'),
        cron: '* * * * *',
      }),
      { ...env, DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/0/test-only' } as typeof env,
      context
    );
    await waitOnExecutionContext(context);

    expect(fetchSpy).toHaveBeenCalledOnce();
    await expect(
      env.DB.prepare(
        'SELECT digest_id AS digestId, sent_at IS NOT NULL AS sent FROM digest_sends'
      ).all()
    ).resolves.toMatchObject({ results: [{ digestId: 'daily:2026-10-15', sent: 1 }] });
  });

  it('serves the public feed from cached D1 material and checks visibility on every response', async () => {
    // A stubbed GitHub: this suite makes no outbound requests.
    let repositoryIsPublic = true;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(
          repositoryIsPublic
            ? Response.json({ id: 1, private: false })
            : Response.json({ message: 'Not Found' }, { status: 404 })
        )
      );
    // Today, so the stars stay inside the feed's 90-day window whenever this runs.
    const today = new Date().toISOString().slice(0, 10);
    for (const [deliveryId, receivedAt, count] of [
      ['star-1', `${today}T00:00:00.000Z`, 1],
      ['star-2', `${today}T00:00:00.001Z`, 2],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO events (delivery_id, event_type, repository, received_at, event_json)
         VALUES (?, 'star.created', 'myorg/repo', ?, ?)`
      )
        .bind(deliveryId, receivedAt, serializeRepoEvent({ ...event, star: { count } }))
        .run();
    }
    const getFeed = async (): Promise<Response> => {
      const context = createExecutionContext();
      const response = await worker.fetch(
        new Request('https://example.com/public/feed?limit=7'),
        env,
        context
      );
      await waitOnExecutionContext(context);
      return response;
    };

    const first = await getFeed();
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      events: [{ star: { count: 2 } }, { star: { count: 1 } }],
      starHistory: [{ repo: 'myorg/repo', points: [{ date: today, stars: 2 }] }],
    });

    // The material is cached: the next response is built without D1.
    await env.DB.prepare('DELETE FROM events').run();
    const cached = await getFeed();
    await expect(cached.json()).resolves.toMatchObject({ events: [{}, {}] });
    expect(cached.headers.get('Cache-Control')).toBe('no-store');
    expect(fetchSpy).toHaveBeenCalledOnce();

    repositoryIsPublic = false;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    await expect((await getFeed()).json()).resolves.toMatchObject({
      events: [],
      starHistory: [],
    });
  });

  it('sums public activity per UTC day through the partial index on real D1', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(Response.json({ id: 1, private: false }))
    );
    const today = new Date().toISOString().slice(0, 10);
    const repository = { ...event.repository, fullName: 'myorg/activity' };
    const push = (compareUrl: string): RepoEvent =>
      createRepoEvent(REPO_EVENT_TYPES.PUSH_DEFAULT_BRANCH, {
        action: REPO_EVENT_ACTIONS.PUSHED,
        repository,
        sender: event.sender,
        push: {
          branch: 'main',
          compareUrl,
          forced: false,
          commits: [
            {
              id: 'a',
              message: 'm',
              url: 'https://github.com/myorg/activity/commit/a',
              author: 'x',
            },
          ],
        },
      });
    const stored: [string, string, RepoEvent][] = [
      ['activity-1', `${today}T00:00:00.000Z`, { ...event, repository }],
      ['activity-2', `${today}T00:00:00.001Z`, { ...event, repository }],
      [
        'activity-3',
        `${today}T00:00:00.002Z`,
        { ...event, repository: { ...repository, private: true } },
      ],
      // The publishability rules run in D1 too, the URL whitespace GLOB included.
      ['activity-4', `${today}T00:00:00.003Z`, push('https://github.com/myorg/activity/compare/a')],
      ['activity-5', `${today}T00:00:00.004Z`, push('https://github.com/myorg/a\u00a0b')],
    ];
    for (const [deliveryId, receivedAt, storedEvent] of stored) {
      await env.DB.prepare(
        `INSERT INTO events (delivery_id, event_type, repository, received_at, event_json)
         VALUES (?, ?, 'myorg/activity', ?, ?)`
      )
        .bind(deliveryId, storedEvent.type, receivedAt, serializeRepoEvent(storedEvent))
        .run();
    }

    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request('https://example.com/public/activity?days=1'),
      env,
      context
    );
    await waitOnExecutionContext(context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      since: today,
      days: [
        {
          date: today,
          stars: 2,
          pushes: 1,
          commits: 1,
          repos: [{ repo: 'myorg/activity', stars: 2, pushes: 1 }],
        },
      ],
    });
  });

  it('signs a GitHub App JWT with a PKCS#8 key inside workerd', async () => {
    // A key generated for this test only: no real App key is involved.
    const { keyPair, pem } = await generateAppKey();

    const jwt = await signAppJwt(77, pem, 1_800_000_000);

    const [header = '', payload = '', signature = ''] = jwt.split('.');
    const fromBase64Url = (part: string): Uint8Array<ArrayBuffer> =>
      Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (character) =>
        character.charCodeAt(0)
      );
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(payload)))).toEqual({
      iat: 1_800_000_000 - 60,
      exp: 1_800_000_000 + 540,
      iss: 77,
    });
    await expect(
      crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        keyPair.publicKey,
        fromBase64Url(signature),
        new TextEncoder().encode(`${header}.${payload}`)
      )
    ).resolves.toBe(true);
  });

  it('verifies a Discord interaction signature with Ed25519 inside workerd', async () => {
    // Keys and ids generated for this test only; nothing here is a real application.
    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const publicKey = toHex(await crypto.subtle.exportKey('raw', keys.publicKey));
    const applicationId = String(100000000000000001n);
    const actionsEnv = {
      ...env,
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/0/test-only',
      DISCORD_ACTIONS: 'on',
      DISCORD_APPLICATION_ID: applicationId,
      DISCORD_PUBLIC_KEY: publicKey,
      DISCORD_ALLOWED_USER_IDS: String(100000000000000002n),
      GITHUB_APP_ID: String(77),
      GITHUB_APP_INSTALLATION_ID: String(1),
      GITHUB_APP_PRIVATE_KEY: (await generateAppKey()).pem,
    } as unknown as typeof env;
    const body = JSON.stringify({ type: 1, id: '1', application_id: applicationId, token: 'ping' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = toHex(
      await crypto.subtle.sign(
        { name: 'Ed25519' },
        keys.privateKey,
        new TextEncoder().encode(timestamp + body)
      )
    );
    const post = async (text: string): Promise<Response> => {
      const context = createExecutionContext();
      const response = await worker.fetch(
        new Request('https://example.com/discord/interactions', {
          method: 'POST',
          headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp },
          body: text,
        }),
        actionsEnv,
        context
      );
      await waitOnExecutionContext(context);
      return response;
    };

    const pong = await post(body);
    expect(pong.status).toBe(200);
    await expect(pong.json()).resolves.toEqual({ type: 1 });
    expect((await post(body.replace('"type":1', '"type":2'))).status).toBe(401);
  });

  it('takes up a Discord interaction once in real D1', async () => {
    const actions = new D1DiscordActions(env.DB);
    const interactionId = String(100000000000000005n);
    await expect(actions.takeInteraction(interactionId, new Date())).resolves.toBe(true);
    await expect(actions.takeInteraction(interactionId, new Date())).resolves.toBe(false);
  });
});

/** An RSA key in PKCS#8 PEM, as the GitHub App's key is configured. */
async function generateAppKey(): Promise<{ keyPair: CryptoKeyPair; pem: string }> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const base64 = btoa(String.fromCharCode(...pkcs8));
  const pem = `-----BEGIN PRIVATE KEY-----\n${base64.replace(/.{64}/g, '$&\n')}\n-----END PRIVATE KEY-----\n`;

  return { keyPair, pem };
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
