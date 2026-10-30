import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const script = join(repositoryRoot, 'scripts/check-coverage.sh');
const fakeGh = join(repositoryRoot, 'src/__tests__/fixtures/fake-gh-hooks.sh');
const workerUrl = 'https://repo-pulse.example.workers.dev/webhook';
const allEvents = ['fork', 'issues', 'pull_request', 'push', 'release', 'star'];

interface Hook {
  id: number;
  active: boolean;
  events: string[];
  config: { url: string };
  last_response?: { code: number };
}

function hook(id: number, overrides: Partial<Hook> = {}): Hook {
  return { id, active: true, events: allEvents, config: { url: workerUrl }, ...overrides };
}

const otherHook = hook(99, {
  active: false,
  events: ['push'],
  config: { url: 'https://other.example/hook' },
});

describe('scripts/check-coverage.sh', () => {
  let home: string;
  let state: string;
  let calls: string;
  let env: Record<string, string>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'repo-pulse-coverage-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    copyFileSync(fakeGh, join(bin, 'gh'));
    state = join(home, 'github');
    calls = join(home, 'gh-calls');
    writeFileSync(calls, '');
    env = {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: home,
      FAKE_GH: state,
      GH_CALLS: calls,
      REPO_PULSE_PING_ATTEMPTS: '3',
      REPO_PULSE_PING_INTERVAL: '0',
    };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** Set up one repository's hooks, earlier deliveries and the answer to a new ping. */
  function repository(
    name: string,
    hooks: Hook[],
    options: { pingStatus?: number; earlierPings?: Record<number, number> } = {}
  ): void {
    const dir = join(state, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify(hooks));
    for (const { id } of hooks) {
      if (options.pingStatus !== undefined) {
        writeFileSync(join(dir, `ping-status-${String(id)}`), String(options.pingStatus));
      }
      const earlier = options.earlierPings?.[id];
      if (earlier !== undefined) {
        writeFileSync(
          join(dir, `deliveries-${String(id)}.json`),
          JSON.stringify([{ id: 1, event: 'ping', status_code: earlier }])
        );
      }
    }
  }

  function hooksOf(name: string): Hook[] {
    return JSON.parse(readFileSync(join(state, name, 'hooks.json'), 'utf8')) as Hook[];
  }

  function check(
    repositories: string[],
    ...flags: string[]
  ): { status: number | null; stdout: string } {
    const list = join(home, 'covered.txt');
    writeFileSync(list, `${repositories.join('\n')}\n`);
    // Only these variables: no GitHub credentials reach the script.
    const result = spawnSync(
      'bash',
      [script, ...flags, 'https://repo-pulse.example.workers.dev', list],
      {
        env: env as unknown as NodeJS.ProcessEnv,
        encoding: 'utf8',
      }
    );
    expect(result.stderr).toBe('');
    return { status: result.status, stdout: result.stdout };
  }

  it('passes a healthy hook whose last delivery was a 202, once a fresh ping answers 200', () => {
    repository('myorg/healthy', [hook(11, { last_response: { code: 202 } })]);

    expect(check(['myorg/healthy'])).toEqual({ status: 0, stdout: '' });
    expect(readFileSync(calls, 'utf8')).toContain(
      'api --method POST repos/myorg/healthy/hooks/11/pings'
    );
  });

  it('reports each uncovered repository with its reason, and leaves other hooks alone', () => {
    repository('myorg/none', [otherHook]);
    repository('myorg/inactive', [hook(21, { active: false, last_response: { code: 200 } })]);
    repository('myorg/push-only', [hook(31, { events: ['push'], last_response: { code: 200 } })]);
    // An earlier ping answered 200; only the fresh one counts.
    repository('myorg/refused', [hook(41)], { pingStatus: 401, earlierPings: { 41: 200 } });
    repository('myorg/healthy', [hook(11)]);

    const result = check([
      'myorg/none',
      'myorg/inactive',
      'myorg/push-only',
      'myorg/refused',
      'myorg/healthy',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout.trim().split('\n')).toEqual([
      'myorg/none: no hook',
      'myorg/inactive: inactive',
      'myorg/push-only: missing events: fork, issues, pull_request, release, star',
      'myorg/refused: ping 401',
    ]);
    const log = readFileSync(calls, 'utf8');
    expect(log).not.toContain('hooks/99');
    expect(log).not.toContain('PATCH');
    // An inactive or incomplete hook is not even pinged.
    expect(log).not.toContain('hooks/21/pings');
    expect(log).not.toContain('hooks/31/pings');
    expect(hooksOf('myorg/none')).toEqual([otherHook]);
  });

  it('accepts a hook subscribed to every event', () => {
    repository('myorg/wildcard', [hook(51, { events: ['*'] })]);

    expect(check(['myorg/wildcard'])).toEqual({ status: 0, stdout: '' });
  });

  it('with --repair, makes inactive and incomplete hooks active with the six events, then checks them', () => {
    repository('myorg/inactive', [hook(21, { active: false })]);
    repository('myorg/push-only', [hook(31, { events: ['push'] }), otherHook]);

    expect(check(['myorg/inactive', 'myorg/push-only'], '--repair')).toEqual({
      status: 0,
      stdout: '',
    });
    expect(hooksOf('myorg/inactive')).toEqual([hook(21)]);
    expect(hooksOf('myorg/push-only')).toEqual([hook(31), otherHook]);
    expect(readFileSync(calls, 'utf8')).not.toContain('hooks/99');

    // Repaired, they pass a plain check too.
    expect(check(['myorg/inactive', 'myorg/push-only'])).toEqual({ status: 0, stdout: '' });
  });

  it('still reports a repaired hook whose ping fails', () => {
    repository('myorg/refused', [hook(41, { active: false })], { pingStatus: 401 });

    expect(check(['myorg/refused'], '--repair')).toEqual({
      status: 1,
      stdout: 'myorg/refused: ping 401\n',
    });
  });
});
