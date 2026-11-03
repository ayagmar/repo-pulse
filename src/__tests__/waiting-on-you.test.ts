import { createHmac } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, sendDueDigests } from '../app.js';
import { D1EventHistory } from '../core/services/d1-event-history.js';
import type { D1PreparedStatementLike } from '../core/services/d1-types.js';
import { summarizeThreadActivity } from '../core/services/thread-activity.js';
import { createExecutionContext, createTempDatabasePath, createTestEnv } from './test-helpers.js';

type TestEnv = ReturnType<typeof createTestEnv>;
type Payload = Record<string, unknown>;

const OWNER = 'myorg';

function repository(id = 1, fullName = 'myorg/repo'): Payload {
  const [owner = OWNER, name = 'repo'] = fullName.split('/');
  return {
    id,
    name,
    full_name: fullName,
    owner: { login: owner },
    html_url: `https://github.com/${fullName}`,
    private: false,
    fork: false,
    description: null,
    stargazers_count: 1,
    forks_count: 0,
    language: 'TypeScript',
  };
}

function user(login: string, id: number): Payload {
  return {
    id,
    login,
    avatar_url: `https://avatars.githubusercontent.com/u/${String(id)}`,
    html_url: `https://github.com/${login}`,
    type: login.endsWith('[bot]') ? 'Bot' : 'User',
  };
}

const people = {
  owner: user(OWNER, 1),
  alice: user('alice', 10),
  bob: user('bob', 11),
  carol: user('carol', 12),
  collaborator: user('Test-Collab', 13),
  bot: user('coderabbitai[bot]', 14),
};

interface Thread {
  number: number;
  repo?: Payload;
  title?: string;
  state?: 'open' | 'closed';
  createdAt?: string;
}

function repoName(thread: Thread): string {
  return String((thread.repo ?? repository()).full_name);
}

function issue(thread: Thread, extra: Payload = {}): Payload {
  return {
    number: thread.number,
    title: thread.title ?? `Thread ${String(thread.number)}`,
    html_url: `https://github.com/${repoName(thread)}/issues/${String(thread.number)}`,
    state: thread.state ?? 'open',
    body: 'Body',
    labels: [],
    created_at: thread.createdAt ?? '2026-10-10T10:00:00Z',
    updated_at: thread.createdAt ?? '2026-10-10T10:00:00Z',
    ...extra,
  };
}

function pullRequest(thread: Thread, extra: Payload = {}): Payload {
  return {
    number: thread.number,
    title: thread.title ?? `Thread ${String(thread.number)}`,
    html_url: `https://github.com/${repoName(thread)}/pull/${String(thread.number)}`,
    state: thread.state ?? 'open',
    merged: false,
    body: null,
    draft: false,
    head: { ref: 'feature' },
    base: { ref: 'main' },
    created_at: thread.createdAt ?? '2026-10-10T10:00:00Z',
    updated_at: thread.createdAt ?? '2026-10-10T10:00:00Z',
    ...extra,
  };
}

/** A GitHub delivery: its event header and its payload, without the App's fields. */
interface Delivery {
  event: string;
  payload: Payload;
}

function commentOn(
  thread: Thread,
  sender: Payload,
  at: string,
  options: { pullRequest?: boolean; draft?: boolean; body?: string | null } = {}
): Delivery {
  const parent = issue(thread, {
    updated_at: at,
    ...(options.pullRequest === true
      ? {
          pull_request: {
            html_url: `https://github.com/${repoName(thread)}/pull/${String(thread.number)}`,
          },
          html_url: `https://github.com/${repoName(thread)}/pull/${String(thread.number)}`,
        }
      : {}),
    ...(options.draft !== undefined ? { draft: options.draft } : {}),
  });
  return {
    event: 'issue_comment',
    payload: {
      action: 'created',
      repository: thread.repo ?? repository(),
      sender,
      issue: parent,
      comment: {
        id: Date.parse(at) / 1000,
        html_url: `${String(parent.html_url)}#issuecomment-${String(Date.parse(at) / 1000)}`,
        body: options.body === undefined ? 'Any news on this?' : options.body,
        user: sender,
        created_at: at,
        updated_at: at,
      },
    },
  };
}

function review(
  thread: Thread,
  sender: Payload,
  at: string | null,
  state: string,
  body: string | null
): Delivery {
  return {
    event: 'pull_request_review',
    payload: {
      action: 'submitted',
      repository: thread.repo ?? repository(),
      sender,
      pull_request: pullRequest(thread, { updated_at: at }),
      review: {
        id: 500 + thread.number,
        html_url: `https://github.com/${repoName(thread)}/pull/${String(thread.number)}#pullrequestreview-1`,
        body,
        state,
        submitted_at: at,
        user: sender,
      },
    },
  };
}

function issueAction(
  action: 'opened' | 'closed' | 'reopened',
  thread: Thread,
  sender: Payload,
  at: string
): Delivery {
  return {
    event: 'issues',
    payload: {
      action,
      repository: thread.repo ?? repository(),
      sender,
      issue: issue(
        { ...thread, state: action === 'closed' ? 'closed' : 'open' },
        {
          ...(action === 'opened' ? { created_at: at } : {}),
          updated_at: at,
          closed_at: action === 'closed' ? at : null,
        }
      ),
    },
  };
}

function pullRequestAction(
  action: 'opened' | 'closed' | 'ready_for_review' | 'converted_to_draft',
  thread: Thread,
  sender: Payload,
  at: string,
  options: { draft?: boolean; merged?: boolean; createdAt?: string | null } = {}
): Delivery {
  const createdAt = options.createdAt === undefined ? at : options.createdAt;
  return {
    event: 'pull_request',
    payload: {
      action,
      repository: thread.repo ?? repository(),
      sender,
      pull_request: pullRequest(
        { ...thread, state: action === 'closed' ? 'closed' : 'open' },
        {
          draft: options.draft ?? false,
          merged: options.merged ?? false,
          ...(createdAt === null ? { created_at: undefined } : { created_at: createdAt }),
          updated_at: at,
          closed_at: action === 'closed' ? at : null,
          merged_at: options.merged === true ? at : null,
        }
      ),
    },
  };
}

describe('waiting on you', () => {
  const cleanups: (() => void)[] = [];
  let fetchMock: ReturnType<typeof vi.fn>;
  let env: TestEnv;
  let databasePath: string;
  let deliveries = 0;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const database = createTempDatabasePath();
    cleanups.push(database.cleanup);
    databasePath = database.databasePath;
    env = createTestEnv(database.databasePath, {
      DIGEST_TIME_ZONE: 'UTC',
      DIGEST_HOUR: '9',
      PEOPLE_IGNORED_LOGINS: 'test-collab',
    });
    cleanups.push(() => {
      env.DB.close();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  /** Deliver through `POST /webhook` at `receivedAt`, and let the alert go out. */
  async function deliver(
    delivery: Delivery,
    receivedAt: string,
    options: { deliveryId?: string; env?: TestEnv } = {}
  ): Promise<{ status: number; body: { message: string; duplicate?: boolean } }> {
    vi.setSystemTime(new Date(receivedAt));
    deliveries += 1;
    const body = JSON.stringify({ ...delivery.payload, installation: { id: 1 } });
    const execution = createExecutionContext();
    const response = await createApp().fetch(
      new Request('https://example.com/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': delivery.event,
          'X-GitHub-Delivery': options.deliveryId ?? `delivery-${String(deliveries)}`,
          'X-Hub-Signature-256': `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`,
        },
        body,
      }),
      options.env ?? env,
      execution.executionCtx
    );
    await execution.waitForBackground();
    return {
      status: response.status,
      body: await response.json<{ message: string; duplicate?: boolean }>(),
    };
  }

  function alerts(): {
    title: string;
    url: string;
    description?: string;
    fields?: { name: string; value: string }[];
  }[] {
    return fetchMock.mock.calls
      .filter((call) => String(call[0]).startsWith('https://discord.com/'))
      .map(
        (call) =>
          (JSON.parse((call[1] as RequestInit).body as string) as { embeds: [never] }).embeds[0]
      );
  }

  async function waiting(
    asOf: string,
    window = { start: new Date(0), end: new Date(asOf) }
  ): Promise<ReturnType<typeof summarizeThreadActivity>> {
    const material = await new D1EventHistory(env.DB).readThreadActivity(
      new Date(Date.parse(asOf) - 90 * 24 * 60 * 60_000),
      { threads: 200, eventsPerThread: 100, rows: 2000 }
    );
    return summarizeThreadActivity(material, window, new Set(['test-collab']));
  }

  function activationOf(): unknown {
    const raw = new Database(databasePath, { readonly: true });
    try {
      return raw.prepare('SELECT activated_at AS at FROM feature_activations').all();
    } finally {
      raw.close();
    }
  }

  it('alerts outside comments and reviews once, and records the rest without an alert', async () => {
    const pr = { number: 2, title: 'Add a flag' };
    const outside = commentOn(pr, people.alice, '2026-10-12T10:00:00Z', {
      pullRequest: true,
      body: '<!-- template -->\nCould you look at this?',
    });

    await expect(
      deliver(outside, '2026-10-12T10:00:05Z', { deliveryId: 'c-1' })
    ).resolves.toMatchObject({
      status: 202,
    });
    // GitHub redelivers it: counted and alerted once.
    await expect(
      deliver(outside, '2026-10-12T10:05:00Z', { deliveryId: 'c-1' })
    ).resolves.toMatchObject({
      status: 200,
      body: { duplicate: true },
    });
    const recorded = [
      commentOn({ number: 3 }, people.owner, '2026-10-12T11:00:00Z'),
      commentOn({ number: 3 }, people.collaborator, '2026-10-12T11:01:00Z'),
      commentOn(pr, people.bot, '2026-10-12T11:02:00Z', { pullRequest: true }),
      // The shell GitHub submits around inline comments, with an empty or blank body.
      review(pr, people.alice, '2026-10-12T11:03:00Z', 'commented', ''),
      review(pr, people.alice, '2026-10-12T11:04:00Z', 'commented', '  \n'),
      review(pr, people.alice, '2026-10-12T11:05:00Z', 'dismissed', 'Old'),
      review(pr, people.owner, '2026-10-12T11:06:00Z', 'approved', null),
      pullRequestAction('converted_to_draft', pr, people.alice, '2026-10-12T11:07:00Z', {
        draft: true,
      }),
    ];
    for (const delivery of recorded) {
      await expect(deliver(delivery, '2026-10-12T12:00:00Z')).resolves.toEqual({
        status: 202,
        body: expect.objectContaining({
          message: 'Webhook recorded without an alert',
        }) as unknown,
      });
    }
    await deliver(
      review(pr, people.bob, '2026-10-12T13:00:00Z', 'approved', null),
      '2026-10-12T13:00:01Z'
    );
    await deliver(
      review(pr, people.carol, '2026-10-12T13:01:00Z', 'CHANGES_REQUESTED', 'Please split it.'),
      '2026-10-12T13:01:01Z'
    );

    // Recorded events have no delivery, so no provider attempt either.
    const raw = new Database(databasePath, { readonly: true });
    expect(
      raw
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM events) AS events,
             (SELECT COUNT(*) FROM deliveries) AS deliveries,
             (SELECT COUNT(*) FROM provider_attempts) AS attempts`
        )
        .get()
    ).toEqual({ events: 11, deliveries: 3, attempts: 3 });
    raw.close();
    expect(alerts()).toEqual([
      expect.objectContaining({
        title: '💬 Comment on PR #2: Add a flag',
        url: 'https://github.com/myorg/repo/pull/2#issuecomment-1791799200',
        description: 'Could you look at this?\n\n👋 First time here',
      }),
      expect.objectContaining({
        title: '✅ Approved PR #2: Add a flag',
        url: 'https://github.com/myorg/repo/pull/2#pullrequestreview-1',
      }),
      expect.objectContaining({
        title: '🛑 Changes requested on PR #2: Add a flag',
        description: expect.stringMatching(/^Please split it\./) as unknown,
      }),
    ]);
  });

  it('keeps the decision made at acceptance when the ignored logins change or the delivery row is pruned', async () => {
    const reply = commentOn({ number: 3 }, people.collaborator, '2026-10-12T11:00:00Z');
    await deliver(reply, '2026-10-12T11:00:01Z', { deliveryId: 'collab-1' });

    const changed = createTestEnv(databasePath, { PEOPLE_IGNORED_LOGINS: '' });
    cleanups.push(() => {
      changed.DB.close();
    });
    await expect(
      deliver(reply, '2026-10-12T12:00:00Z', { deliveryId: 'collab-1', env: changed })
    ).resolves.toMatchObject({ status: 200, body: { duplicate: true } });

    const outside = commentOn({ number: 3 }, people.alice, '2026-10-12T13:00:00Z');
    await deliver(outside, '2026-10-12T13:00:01Z', { deliveryId: 'alice-1' });
    await changed.DB.prepare('DELETE FROM deliveries').run();
    // After pruning, a redelivery is queued again only if it alerted the first time.
    await deliver(reply, '2026-10-20T12:00:00Z', { deliveryId: 'collab-1', env: changed });
    await deliver(outside, '2026-10-20T12:00:01Z', { deliveryId: 'alice-1', env: changed });

    expect(alerts().map((alert) => alert.title)).toEqual([
      '💬 Comment on issue #3: Thread 3',
      '💬 Comment on issue #3: Thread 3',
    ]);
  });

  it('starts counting at the first recorded comment or review, and never moves that instant', async () => {
    expect(activationOf()).toEqual([]);
    await deliver(
      issueAction('opened', { number: 10 }, people.alice, '2026-10-01T10:00:00Z'),
      '2026-10-01T10:00:01Z'
    );
    // A review without a submission time cannot set it.
    await deliver(
      review({ number: 11 }, people.owner, null, 'approved', null),
      '2026-10-04T10:00:00Z'
    );
    expect(activationOf()).toEqual([]);
    await expect(waiting('2026-10-20T09:00:00Z')).resolves.toMatchObject({ waiting: [] });

    await deliver(
      commentOn({ number: 12 }, people.owner, '2026-10-05T10:00:00Z'),
      '2026-10-05T10:00:03Z'
    );
    // Delivered late, with an older GitHub time.
    await deliver(
      commentOn({ number: 13 }, people.bob, '2026-10-04T10:00:00Z'),
      '2026-10-06T10:00:00Z'
    );

    expect(activationOf()).toEqual([{ at: '2026-10-05T10:00:00.000Z' }]);
    // Issue 10 was opened, and 13 last spoken in, before activation.
    await expect(waiting('2026-10-20T09:00:00Z')).resolves.toMatchObject({ waiting: [] });
  });

  it('lists who waits on the owner’s side, by GitHub time, from the latest unanswered request', async () => {
    await deliver(
      commentOn({ number: 99 }, people.owner, '2026-10-05T00:00:00Z'),
      '2026-10-05T00:00:01Z'
    );
    const renamed = repository(2, 'myorg/old-name');
    const steps: [Delivery, string][] = [
      // 1: an outside issue nobody answered.
      [
        issueAction('opened', { number: 1 }, people.alice, '2026-10-06T10:00:00Z'),
        '2026-10-06T10:00:01Z',
      ],
      // 2: answered, then asked again: waits from the second request.
      [
        pullRequestAction('opened', { number: 2 }, people.bob, '2026-10-07T10:00:00Z'),
        '2026-10-07T10:00:01Z',
      ],
      [
        commentOn({ number: 2 }, people.owner, '2026-10-07T12:00:00Z', { pullRequest: true }),
        '2026-10-07T12:00:01Z',
      ],
      [
        commentOn({ number: 2 }, people.bob, '2026-10-08T10:00:00Z', { pullRequest: true }),
        '2026-10-08T10:00:01Z',
      ],
      // 3: a bot's comment answers nobody.
      [commentOn({ number: 3 }, people.carol, '2026-10-09T10:00:00Z'), '2026-10-09T10:00:01Z'],
      [commentOn({ number: 3 }, people.bot, '2026-10-09T10:05:00Z'), '2026-10-09T10:05:01Z'],
      // 4: a bot alone makes nobody wait.
      [commentOn({ number: 4 }, people.bot, '2026-10-09T11:00:00Z'), '2026-10-09T11:00:01Z'],
      // 5: a collaborator in PEOPLE_IGNORED_LOGINS answers.
      [commentOn({ number: 5 }, people.alice, '2026-10-09T12:00:00Z'), '2026-10-09T12:00:01Z'],
      [
        commentOn({ number: 5 }, people.collaborator, '2026-10-09T13:00:00Z'),
        '2026-10-09T13:00:01Z',
      ],
      // 6: closed by the owner without a word, reopened by its author: waits from the reopen.
      [
        issueAction('opened', { number: 6 }, people.carol, '2026-10-06T08:00:00Z'),
        '2026-10-06T08:00:01Z',
      ],
      [
        issueAction('closed', { number: 6 }, people.owner, '2026-10-06T09:00:00Z'),
        '2026-10-06T09:00:01Z',
      ],
      [
        issueAction('reopened', { number: 6 }, people.carol, '2026-10-10T08:00:00Z'),
        '2026-10-10T08:00:01Z',
      ],
      // 7: a draft waits once ready, from its opening; 8: converted to draft, it does not.
      [
        pullRequestAction('opened', { number: 7 }, people.bob, '2026-10-06T07:00:00Z', {
          draft: true,
        }),
        '2026-10-06T07:00:01Z',
      ],
      [
        pullRequestAction('ready_for_review', { number: 7 }, people.bob, '2026-10-11T07:00:00Z'),
        '2026-10-11T07:00:01Z',
      ],
      [
        pullRequestAction('opened', { number: 8 }, people.bob, '2026-10-06T07:30:00Z'),
        '2026-10-06T07:30:01Z',
      ],
      [
        pullRequestAction('converted_to_draft', { number: 8 }, people.bob, '2026-10-06T07:40:00Z', {
          draft: true,
        }),
        '2026-10-06T07:40:01Z',
      ],
      // 9: the owner's reply arrives before the older outside comment it answers.
      [commentOn({ number: 9 }, people.owner, '2026-10-12T10:05:00Z'), '2026-10-12T10:05:01Z'],
      [commentOn({ number: 9 }, people.alice, '2026-10-12T10:00:00Z'), '2026-10-12T10:30:00Z'],
      // 14: and an outside comment arrives before an older owner reply.
      [commentOn({ number: 14 }, people.alice, '2026-10-12T11:00:00Z'), '2026-10-12T11:00:01Z'],
      [commentOn({ number: 14 }, people.owner, '2026-10-12T10:59:00Z'), '2026-10-12T11:30:00Z'],
      // 15: a pull request seen only through a comment: its draft state is unknown.
      [
        commentOn({ number: 15 }, people.alice, '2026-10-12T12:00:00Z', { pullRequest: true }),
        '2026-10-12T12:00:01Z',
      ],
      // 16: same, but the payload says it is not a draft.
      [
        commentOn({ number: 16 }, people.alice, '2026-10-12T12:30:00Z', {
          pullRequest: true,
          draft: false,
        }),
        '2026-10-12T12:30:01Z',
      ],
      // 17: in a repository renamed since: one thread, shown under its new name.
      [
        commentOn(
          { number: 17, repo: renamed, title: 'Old title' },
          people.carol,
          '2026-10-12T13:00:00Z'
        ),
        '2026-10-12T13:00:01Z',
      ],
      [
        commentOn(
          { number: 17, repo: repository(2, 'myorg/new-name'), title: 'New title' },
          people.carol,
          '2026-10-12T14:00:00Z'
        ),
        '2026-10-12T14:00:01Z',
      ],
      // 18: closed after an outside comment, then commented on while closed.
      [commentOn({ number: 18 }, people.alice, '2026-10-12T15:00:00Z'), '2026-10-12T15:00:01Z'],
      [
        issueAction('closed', { number: 18 }, people.alice, '2026-10-12T15:10:00Z'),
        '2026-10-12T15:10:01Z',
      ],
      [
        commentOn({ number: 18, state: 'closed' }, people.carol, '2026-10-12T15:20:00Z'),
        '2026-10-12T15:20:01Z',
      ],
      // 19: closed by the App from Discord, a bot: it ends the wait all the same.
      [commentOn({ number: 19 }, people.alice, '2026-10-12T16:00:00Z'), '2026-10-12T16:00:01Z'],
      [
        issueAction('closed', { number: 19 }, user('repo-pulse[bot]', 99), '2026-10-12T16:10:00Z'),
        '2026-10-12T16:10:01Z',
      ],
    ];
    for (const [delivery, receivedAt] of steps) {
      await deliver(delivery, receivedAt);
    }

    const summary = await waiting('2026-10-20T09:00:00Z');

    expect(summary.incompleteThreads).toBe(0);
    expect(
      summary.waiting.map((thread) => [
        `${thread.repository}#${String(thread.number)}`,
        thread.title,
        thread.login,
        thread.since.toISOString(),
      ])
    ).toEqual([
      ['myorg/repo#7', 'Thread 7', 'bob', '2026-10-06T07:00:00.000Z'],
      ['myorg/repo#1', 'Thread 1', 'alice', '2026-10-06T10:00:00.000Z'],
      ['myorg/repo#2', 'Thread 2', 'bob', '2026-10-08T10:00:00.000Z'],
      ['myorg/repo#3', 'Thread 3', 'carol', '2026-10-09T10:00:00.000Z'],
      ['myorg/repo#6', 'Thread 6', 'carol', '2026-10-10T08:00:00.000Z'],
      ['myorg/repo#14', 'Thread 14', 'alice', '2026-10-12T11:00:00.000Z'],
      ['myorg/repo#16', 'Thread 16', 'alice', '2026-10-12T12:30:00.000Z'],
      ['myorg/new-name#17', 'New title', 'carol', '2026-10-12T13:00:00.000Z'],
    ]);
  });

  it('measures merge and first-reply times by GitHub time, in the week they happened', async () => {
    await deliver(
      commentOn({ number: 99 }, people.owner, '2026-10-12T00:00:00Z'),
      '2026-10-12T00:00:01Z'
    );
    // A pull request opened before creation times were recorded: its stored opened
    // event's receipt time is the start, the one receipt-time fallback allowed.
    const legacy = new Database(databasePath);
    legacy
      .prepare(
        `INSERT INTO events (delivery_id, event_type, repository, received_at, event_json)
         VALUES ('legacy-open', 'pull_request.opened', 'myorg/repo', ?, ?)`
      )
      .run(
        '2026-10-10T00:00:00.000Z',
        JSON.stringify({
          type: 'pull_request.opened',
          action: 'opened',
          repository: { id: 1, fullName: 'myorg/repo', owner: 'myorg', url: '', private: false },
          sender: { id: 11, login: 'bob', avatarUrl: '', url: '' },
          timestamp: '2026-10-10T00:00:00.000Z',
          pullRequest: {
            number: 30,
            title: 'Legacy',
            url: 'https://github.com/myorg/repo/pull/30',
            state: 'open',
            merged: false,
            body: null,
            draft: false,
            headBranch: 'a',
            baseBranch: 'main',
          },
        })
      );
    legacy.close();
    // A merge without a valid merge time: when it happened is unknown.
    const untimedMerge = pullRequestAction(
      'closed',
      { number: 35 },
      people.owner,
      '2026-10-15T00:00:00Z',
      { merged: true, createdAt: '2026-10-12T00:00:00Z' }
    );
    (untimedMerge.payload.pull_request as Payload).merged_at = null;

    const steps: [Delivery, string][] = [
      // Merged after 3 days, from its legacy opened event.
      [
        pullRequestAction('closed', { number: 30 }, people.owner, '2026-10-13T00:00:00Z', {
          merged: true,
          createdAt: null,
        }),
        '2026-10-13T00:00:01Z',
      ],
      [untimedMerge, '2026-10-15T00:00:01Z'],
      // Merged after 2 days, its merge delivered after the week ended: counted by merge time.
      [
        pullRequestAction('closed', { number: 31 }, people.owner, '2026-10-14T00:00:00Z', {
          merged: true,
          createdAt: '2026-10-12T00:00:00Z',
        }),
        '2026-10-19T09:30:00Z',
      ],
      // Merged after 4 days.
      [
        pullRequestAction('closed', { number: 32 }, people.owner, '2026-10-16T00:00:00Z', {
          merged: true,
          createdAt: '2026-10-12T00:00:00Z',
        }),
        '2026-10-16T00:00:01Z',
      ],
      // Without a creation time or an opened event: left out.
      [
        pullRequestAction('closed', { number: 33 }, people.owner, '2026-10-16T00:00:00Z', {
          merged: true,
          createdAt: null,
        }),
        '2026-10-16T00:00:01Z',
      ],
      // Merged the week before.
      [
        pullRequestAction('closed', { number: 34 }, people.owner, '2026-10-11T00:00:00Z', {
          merged: true,
          createdAt: '2026-10-01T00:00:00Z',
        }),
        '2026-10-12T09:30:00Z',
      ],
      // Answered in 5 hours.
      [
        issueAction('opened', { number: 40 }, people.alice, '2026-10-13T00:00:00Z'),
        '2026-10-13T00:00:01Z',
      ],
      [
        commentOn(
          { number: 40, createdAt: '2026-10-13T00:00:00Z' },
          people.owner,
          '2026-10-13T05:00:00Z'
        ),
        '2026-10-13T05:00:01Z',
      ],
      // Answered by a collaborator in 1 hour; later exchanges do not count.
      [
        commentOn(
          { number: 41, createdAt: '2026-10-13T00:00:00Z' },
          people.bob,
          '2026-10-14T00:00:00Z'
        ),
        '2026-10-14T00:00:01Z',
      ],
      [
        commentOn(
          { number: 41, createdAt: '2026-10-13T00:00:00Z' },
          people.collaborator,
          '2026-10-14T01:00:00Z'
        ),
        '2026-10-14T01:00:01Z',
      ],
      [
        commentOn(
          { number: 41, createdAt: '2026-10-13T00:00:00Z' },
          people.bob,
          '2026-10-15T00:00:00Z'
        ),
        '2026-10-15T00:00:01Z',
      ],
      [
        commentOn(
          { number: 41, createdAt: '2026-10-13T00:00:00Z' },
          people.owner,
          '2026-10-17T00:00:00Z'
        ),
        '2026-10-17T00:00:01Z',
      ],
      // Created before activation: not a thread that started after it.
      [
        commentOn(
          { number: 42, createdAt: '2026-10-01T00:00:00Z' },
          people.bob,
          '2026-10-14T00:00:00Z'
        ),
        '2026-10-14T00:00:01Z',
      ],
      [
        commentOn(
          { number: 42, createdAt: '2026-10-01T00:00:00Z' },
          people.owner,
          '2026-10-14T02:00:00Z'
        ),
        '2026-10-14T02:00:01Z',
      ],
      // Closed without a word, reopened, then answered: the first reply took 3 days.
      [
        issueAction('opened', { number: 43 }, people.carol, '2026-10-13T00:00:00Z'),
        '2026-10-13T00:00:01Z',
      ],
      [
        issueAction('closed', { number: 43 }, people.owner, '2026-10-13T01:00:00Z'),
        '2026-10-13T01:00:01Z',
      ],
      [
        issueAction(
          'reopened',
          { number: 43, createdAt: '2026-10-13T00:00:00Z' },
          people.carol,
          '2026-10-14T00:00:00Z'
        ),
        '2026-10-14T00:00:01Z',
      ],
      [
        commentOn(
          { number: 43, createdAt: '2026-10-13T00:00:00Z' },
          people.owner,
          '2026-10-16T00:00:00Z'
        ),
        '2026-10-16T00:00:01Z',
      ],
      // Answered by a review without a submission time: when is unknown, so no sample.
      [
        pullRequestAction('opened', { number: 45 }, people.bob, '2026-10-13T00:00:00Z'),
        '2026-10-13T00:00:01Z',
      ],
      [
        review(
          { number: 45, createdAt: '2026-10-13T00:00:00Z' },
          people.owner,
          null,
          'approved',
          null
        ),
        '2026-10-15T00:00:00Z',
      ],
      // Answered by a bot only.
      [
        issueAction('opened', { number: 44 }, people.carol, '2026-10-13T00:00:00Z'),
        '2026-10-13T00:00:01Z',
      ],
      [
        commentOn(
          { number: 44, createdAt: '2026-10-13T00:00:00Z' },
          people.bot,
          '2026-10-13T00:01:00Z'
        ),
        '2026-10-13T00:01:01Z',
      ],
    ];
    for (const [delivery, receivedAt] of steps) {
      await deliver(delivery, receivedAt);
    }

    const week = { start: new Date('2026-10-12T09:00:00Z'), end: new Date('2026-10-19T09:00:00Z') };
    const summary = await waiting('2026-10-19T09:30:00Z', week);

    // Merges: 3d, 2d and 4d. First replies: 5h, 1h and 3d.
    expect(summary.responseTimes).toEqual({
      merge: { medianMs: 3 * 24 * 60 * 60_000, count: 3 },
      firstReply: { medianMs: 5 * 60 * 60_000, count: 3 },
    });
    // The untimed merge and the untimed review leave their threads out of replies.
    expect(summary.untimedThreads).toBe(2);
  });

  function posted(): {
    title: string;
    description?: string;
    fields?: { name: string; value: string }[];
  }[] {
    return alerts();
  }

  it('posts a digest when someone waits, even without other activity, oldest wait first', async () => {
    await deliver(
      commentOn({ number: 99 }, people.owner, '2026-10-12T00:00:00Z'),
      '2026-10-12T00:00:01Z'
    );
    for (let number = 1; number <= 7; number += 1) {
      const at = new Date(Date.parse('2026-10-13T00:00:00Z') + number * 60 * 60_000).toISOString();
      await deliver(issueAction('opened', { number }, people.alice, at), at);
    }
    await deliver(
      pullRequestAction('closed', { number: 20 }, people.owner, '2026-10-14T14:00:00Z', {
        merged: true,
        createdAt: '2026-10-12T10:00:00Z',
      }),
      '2026-10-14T14:00:01Z'
    );
    fetchMock.mockClear();

    // Monday: nothing was received the last day, but seven issues wait.
    await sendDueDigests(env, new Date('2026-10-19T09:00:00Z'));

    const [daily, weekly] = posted();
    expect(daily).toEqual({
      title: '📊 Daily pulse: no new events',
      color: expect.any(Number) as number,
      timestamp: '2026-10-19T09:00:00.000Z',
      fields: [
        {
          name: '⏳ Waiting on you',
          value: [
            '[myorg/repo#1](https://github.com/myorg/repo/issues/1) Thread 1 · @alice · 6d',
            '[myorg/repo#2](https://github.com/myorg/repo/issues/2) Thread 2 · @alice · 6d',
            '[myorg/repo#3](https://github.com/myorg/repo/issues/3) Thread 3 · @alice · 6d',
            '[myorg/repo#4](https://github.com/myorg/repo/issues/4) Thread 4 · @alice · 6d',
            '[myorg/repo#5](https://github.com/myorg/repo/issues/5) Thread 5 · @alice · 6d',
            '…and 2 more',
          ].join('\n'),
        },
      ],
      footer: expect.any(Object) as object,
    });
    expect(weekly?.title).toBe('📦 Weekly pulse: 8 events in 1 repository');
    expect(weekly?.fields?.map((field) => field.name)).toEqual([
      '⏳ Waiting on you',
      '⏱️ Response times',
      "👥 Who's showing up",
    ]);
    expect(weekly?.fields?.[1]?.value).toBe('Merge: 2d 4h median (1 PR)');
  });

  it('reports merge times before any comment or review was recorded', async () => {
    await deliver(
      pullRequestAction('closed', { number: 20 }, people.owner, '2026-10-14T14:00:00Z', {
        merged: true,
        createdAt: '2026-10-13T10:00:00Z',
      }),
      '2026-10-14T14:00:01Z'
    );
    fetchMock.mockClear();

    await sendDueDigests(env, new Date('2026-10-19T09:00:00Z'));

    expect(activationOf()).toEqual([]);
    const weekly = posted().find((embed) => embed.title.startsWith('📦'));
    expect(weekly?.fields).toEqual([
      { name: '⏱️ Response times', value: 'Merge: 1d 4h median (1 PR)' },
    ]);
  });

  it('posts without the section when the threads cannot be read, and skips a digest left empty', async () => {
    await deliver(
      commentOn({ number: 99 }, people.owner, '2026-10-12T00:00:00Z'),
      '2026-10-12T00:00:01Z'
    );
    await deliver(
      issueAction('opened', { number: 1 }, people.alice, '2026-10-13T00:00:00Z'),
      '2026-10-13T00:00:01Z'
    );
    fetchMock.mockClear();
    const read = vi
      .spyOn(D1EventHistory.prototype, 'readThreadActivity')
      .mockRejectedValue(new Error('D1 unavailable: SELECT ... alice'));
    const logging = { ...env, LOG_LEVEL: 'warn' };

    // Nothing else happened that day: no digest, and its claim is released.
    await sendDueDigests(logging, new Date('2026-10-15T09:00:00Z'));
    expect(posted()).toEqual([]);
    const warnings = vi.mocked(console.warn).mock.calls.map(([line]) => String(line));
    expect(warnings).toContainEqual(expect.stringContaining('thread_activity.digest_read_failed'));
    expect(warnings.join('\n')).not.toContain('D1 unavailable');

    read.mockRestore();
    await sendDueDigests(logging, new Date('2026-10-15T09:01:00Z'));
    expect(posted().map((embed) => embed.fields?.[0]?.name)).toEqual(['⏳ Waiting on you']);

    // With activity, it posts without the section.
    fetchMock.mockClear();
    vi.spyOn(D1EventHistory.prototype, 'readThreadActivity').mockRejectedValue(
      new Error('D1 unavailable')
    );
    await sendDueDigests(env, new Date('2026-10-13T09:00:00Z'));
    expect(posted()).toEqual([
      expect.objectContaining({ title: '📊 Daily pulse: 1 event in 1 repository' }),
    ]);
    expect(posted()[0]?.fields).toBeUndefined();
  });

  it('reads thread histories through their indexes, whatever the size of the rest', async () => {
    const raw = new Database(databasePath);
    cleanups.push(() => {
      raw.close();
    });
    const insert = raw.prepare(
      `INSERT INTO events (delivery_id, event_type, repository, received_at, event_json)
       VALUES (?, ?, 'myorg/cli', ?, ?)`
    );
    raw.transaction(() => {
      for (let index = 0; index < 20_000; index += 1) {
        const at = new Date(Date.parse('2025-01-01T00:00:00Z') + index * 60_000).toISOString();
        insert.run(`star-${String(index)}`, 'star.created', at, '{}');
        insert.run(
          `old-${String(index)}`,
          'issue.opened',
          at,
          JSON.stringify({ repository: { id: 7 }, issue: { number: index } })
        );
      }
    })();
    const queries: string[] = [];
    const history = new D1EventHistory({
      ...env.DB,
      prepare: (query: string): D1PreparedStatementLike => {
        queries.push(query);
        return env.DB.prepare(query);
      },
    });
    await history.readThreadActivity(new Date('2026-07-01T00:00:00Z'), {
      threads: 200,
      eventsPerThread: 100,
      rows: 2000,
    });

    const plan = (
      raw
        .prepare(`EXPLAIN QUERY PLAN ${queries[0] ?? ''}`)
        .all('thread_replies', '2026-07-01T00:00:00.000Z', 200, 101, 100, 2000) as {
        detail: string;
      }[]
    ).map((step) => step.detail);
    expect(plan).toContainEqual(
      expect.stringContaining(
        'USING INDEX idx_events_type_received_at (event_type=? AND received_at>?)'
      )
    );
    expect(plan).toContainEqual(expect.stringContaining('USING INDEX idx_events_thread'));
    expect(plan).not.toContainEqual(expect.stringMatching(/^SCAN events/));
  });
});
