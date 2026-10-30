import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const script = join(repositoryRoot, 'scripts/unsubscribe.sh');
const workerUrl = 'https://repo-pulse.example.workers.dev/webhook';

/**
 * A fake `gh` that lists two hooks for any repository, one of them Repo Pulse's,
 * and logs every call. No real GitHub API is reached.
 */
const fakeGh = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_CALLS"
case "$*" in
  "api --paginate repos/"*"/hooks")
    printf '%s' '[{"id":11,"config":{"url":"${workerUrl}"},"events":["star","push"]},{"id":12,"config":{"url":"https://other.example/hook"},"events":["push"]}]'
    ;;
  "api --method DELETE repos/"*) ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`;

describe('scripts/unsubscribe.sh', () => {
  let home: string;
  let calls: string;
  let env: Record<string, string>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'repo-pulse-unsubscribe-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), fakeGh);
    chmodSync(join(bin, 'gh'), 0o755);
    calls = join(home, 'gh-calls');
    writeFileSync(calls, '');
    env = {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: home,
      GH_CALLS: calls,
    };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function run(...args: string[]): string {
    // Only these variables: no GitHub credentials reach the script.
    return execFileSync('bash', [script, ...args], {
      env: env as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });
  }

  it('deletes nothing in a dry run', () => {
    const output = run('--dry-run', 'https://repo-pulse.example.workers.dev', 'myorg/repo');

    expect(output).toContain('myorg/repo: would delete hook 11');
    expect(readFileSync(calls, 'utf8')).not.toContain('DELETE');
    expect(() => readFileSync(join(home, '.config/repo-pulse/removed-hooks.jsonl'))).toThrow();
  });

  it('records, then deletes, only the hook that sends to the Worker', () => {
    run('https://repo-pulse.example.workers.dev/', 'myorg/repo');

    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
      'api --paginate repos/myorg/repo/hooks',
      'api --method DELETE repos/myorg/repo/hooks/11',
    ]);
    const inventory = readFileSync(join(home, '.config/repo-pulse/removed-hooks.jsonl'), 'utf8');
    expect(
      inventory
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown)
    ).toEqual([{ repo: 'myorg/repo', id: 11, url: workerUrl, events: ['star', 'push'] }]);
  });

  // CI installs no `just`; the recipe is checked wherever it is installed.
  const hasJust = spawnSync('just', ['--version']).status === 0;

  it.skipIf(!hasJust)('forwards every argument from the just recipe', () => {
    const result = spawnSync(
      'just',
      ['--dry-run', 'unsubscribe', '--dry-run', workerUrl, 'myorg/repo'],
      // `just` may be a version-manager shim that reads the real HOME; with
      // --dry-run it only prints the command, so nothing runs either way.
      { cwd: repositoryRoot, encoding: 'utf8' }
    );

    // `just --dry-run` prints the command instead of running it.
    expect(result.stderr.trim()).toBe(`scripts/unsubscribe.sh --dry-run ${workerUrl} myorg/repo`);
  });
});
