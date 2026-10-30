import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/check-secrets.sh', import.meta.url));

/**
 * The leaks are assembled at run time from parts, so this file holds none of them
 * and passes the check itself.
 */
const leak = {
  githubToken: ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_'),
  pemKey: [
    ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' '),
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7',
    ['-----END', 'PRIVATE', 'KEY-----'].join(' '),
    '',
  ].join('\n'),
  discordUrl: ['https://discord.com/api/webhooks', '1234567890123456789', 'aBcD-eFgH_iJkL'].join(
    '/'
  ),
  assignment: (name: string, value: string, separator = '='): string =>
    [name, value].join(separator),
};

const randomHex = 'b'.repeat(16) + '4f1c9a7e3d2b8c6a'.repeat(3);

describe('scripts/check-secrets.sh', () => {
  let repository: string;

  beforeEach(() => {
    repository = mkdtempSync(join(tmpdir(), 'repo-pulse-secrets-'));
  });

  afterEach(() => {
    rmSync(repository, { recursive: true, force: true });
  });

  /** Run the check over a new repository that tracks exactly `files`. */
  function check(files: Record<string, string>): { status: number | null; stderr: string } {
    rmSync(repository, { recursive: true, force: true });
    mkdirSync(repository);
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: repository,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    } as unknown as NodeJS.ProcessEnv;
    spawnSync('git', ['init', '--quiet'], { cwd: repository, env });
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(repository, dirname(path)), { recursive: true });
      writeFileSync(join(repository, path), content);
    }
    spawnSync('git', ['add', '--all'], { cwd: repository, env });
    const result = spawnSync('bash', [script], { cwd: repository, env, encoding: 'utf8' });
    return { status: result.status, stderr: result.stderr };
  }

  it.each([
    [
      'a GitHub token in a test',
      'src/__tests__/client.test.ts',
      `const token = '${leak.githubToken}';\n`,
    ],
    ['a PEM private key', 'keys/app.pem', leak.pemKey],
    ['a Discord webhook URL in a doc', 'docs/setup.md', `Post to ${leak.discordUrl}\n`],
    [
      'a random webhook secret in .dev.vars.example',
      '.dev.vars.example',
      `${leak.assignment('GITHUB_WEBHOOK_SECRET', randomHex)}\n`,
    ],
    [
      'an admin token in a test helper',
      'src/__tests__/helpers.ts',
      `export const env = { ${leak.assignment('ADMIN_API_TOKEN', `'${randomHex}'`, ': ')} };\n`,
    ],
    [
      'a Discord user id in a doc',
      'README.md',
      `${leak.assignment('DISCORD_ALLOWED_USER_IDS', '123456789012345678')}\n`,
    ],
    [
      'the App id in wrangler.jsonc',
      'wrangler.jsonc',
      `{ "vars": { ${leak.assignment('"GITHUB_APP_ID"', '"5"', ': ')} } }\n`,
    ],
    [
      'an admin token on the line after its name',
      'src/__tests__/helpers.ts',
      `export const env = {\n  ${leak.assignment('ADMIN_API_TOKEN', `\n    "${randomHex}"`, ':')},\n};\n`,
    ],
    [
      'a webhook secret on the line after its name in YAML',
      'config/example.yml',
      `${leak.assignment('GITHUB_WEBHOOK_SECRET', `\n  "${randomHex}"`, ':')}\n`,
    ],
    [
      'an App id as a number literal in code',
      'src/__tests__/helpers.ts',
      `export const env = { ${leak.assignment('GITHUB_APP_ID', '1234567', ': ')} };\n`,
    ],
    [
      'an installation id as a number literal on the next line',
      'src/__tests__/helpers.ts',
      `export const env = {\n  ${leak.assignment('GITHUB_APP_INSTALLATION_ID', '\n    87654321', ':')},\n};\n`,
    ],
  ])('fails on %s, naming the file and not the value', (_, path, content) => {
    const { status, stderr } = check({ [path]: content });

    expect(status).not.toBe(0);
    expect(stderr).toContain(`${path}:`);
    expect(stderr).not.toContain(randomHex);
    expect(stderr).not.toContain(leak.githubToken);
  });

  it('passes the allowlisted placeholders', () => {
    const { status, stderr } = check({
      '.dev.vars.example': [
        leak.assignment('GITHUB_WEBHOOK_SECRET', 'replace-with-github-webhook-secret'),
        leak.assignment('ADMIN_API_TOKEN', 'replace-with-admin-bearer-token'),
        // An empty value, then the next variable: not read as the first one's value.
        leak.assignment('GITHUB_TOKEN', ''),
        'LOG_LEVEL="debug"',
        leak.assignment('DISCORD_WEBHOOK_URL', 'https://discord.com/api/webhooks/<id>/<token>'),
        '',
      ].join('\n'),
      'README.md': [
        leak.assignment('DISCORD_ALLOWED_USER_IDS', '<your-discord-user-id>'),
        'npx wrangler secret put GITHUB_APP_PRIVATE_KEY < key.pkcs8.pem',
        '',
      ].join('\n'),
      'src/__tests__/helpers.ts': [
        `export const env = { ${leak.assignment('ADMIN_API_TOKEN', "'admin-token'", ': ')},`,
        `  ${leak.assignment('GITHUB_WEBHOOK_SECRET', "'test-secret'", ': ')},`,
        `  ${leak.assignment('GITHUB_APP_PRIVATE_KEY', 'privateKey', ': ')},`,
        `  ${leak.assignment('GITHUB_APP_ID', '\n    String(appId)', ':')},`,
        `  ${leak.assignment('GITHUB_APP_INSTALLATION_ID', 'installation.id', ': ')},`,
        `  ${leak.assignment('ADMIN_API_TOKEN', "\n    'admin-token'", ':')},`,
        `  ${leak.assignment('DISCORD_WEBHOOK_URL', "'https://discord.com/api/webhooks/0/test-only'", ': ')} };`,
        '',
      ].join('\n'),
      'src/config.ts': "throw new Error('Invalid GITHUB_APP_ID: expected a number');\n",
      'wrangler.jsonc': '{ "vars": { "GITHUB_WEBHOOK_SOURCES": "repository" } }\n',
    });

    expect(stderr).toBe('');
    expect(status).toBe(0);
  });
});
