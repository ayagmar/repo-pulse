import { describe, expect, it } from 'vitest';
import type { Digest, RepositoryActivity } from '../core/models/digest.js';
import type { RepoEvent, RepoEventOf } from '../core/models/repo-event.js';
import { REPO_EVENT_ACTIONS, REPO_EVENT_TYPES } from '../core/models/repo-event.js';
import { isSilentAlert } from '../core/services/thread-activity.js';
import {
  type DiscordWebhookPayload,
  formatDiscordDigest,
  formatDiscordEmbed,
} from '../providers/discord/embed-formatter.js';

const repository = {
  id: 1,
  name: 'runnerd',
  fullName: 'owner/runnerd',
  owner: 'owner',
  url: 'https://github.com/owner/runnerd',
  private: false,
  description: null,
  stars: 3,
  forks: 1,
  language: null,
};

function user(login: string, id = 7): RepoEvent['sender'] {
  return {
    id,
    login,
    avatarUrl: `https://avatars.githubusercontent.com/u/${String(id)}`,
    url: `https://github.com/${login}`,
  };
}

function embedOf(payload: DiscordWebhookPayload): DiscordWebhookPayload['embeds'][number] {
  const [embed] = payload.embeds;
  if (embed === undefined) {
    throw new Error('Expected one embed');
  }
  return embed;
}

function fences(text: string | undefined): number {
  return (text ?? '').split('\n').filter((line) => line.trimStart().startsWith('```')).length;
}

const sender = user('razakiau');
const timestamp = new Date('2026-11-03T15:04:00.000Z');

function issueOpened(
  body: string | null,
  overrides: Partial<RepoEventOf<'issue.opened'>['issue']> = {},
  who = sender
): RepoEventOf<'issue.opened'> {
  return {
    type: REPO_EVENT_TYPES.ISSUE_OPENED,
    action: REPO_EVENT_ACTIONS.OPENED,
    repository,
    sender: who,
    timestamp,
    issue: {
      number: 181,
      title: 'Cache is not kept between jobs',
      url: `${repository.url}/issues/181`,
      state: 'open',
      body,
      labels: [],
      ...overrides,
    },
  };
}

function pullRequest(
  type: 'pull_request.opened' | 'pull_request.merged' | 'pull_request.closed',
  pr: Partial<RepoEventOf<'pull_request.opened'>['pullRequest']>,
  extra: { who?: RepoEvent['sender']; occurredAt?: string; silent?: true } = {}
): RepoEventOf<typeof type> {
  return {
    type,
    action: type === 'pull_request.opened' ? 'opened' : 'closed',
    repository,
    sender: extra.who ?? sender,
    timestamp,
    ...(extra.occurredAt !== undefined ? { occurredAt: extra.occurredAt } : {}),
    ...(extra.silent === true ? { silent: true as const } : {}),
    pullRequest: {
      number: 199,
      title: 'chore: release 0.0.28',
      url: `${repository.url}/pull/199`,
      state: type === 'pull_request.opened' ? 'open' : 'closed',
      merged: type === 'pull_request.merged',
      body: null,
      draft: false,
      headBranch: 'chore/release-0.0.28',
      baseBranch: 'main',
      additions: 41,
      deletions: 41,
      changedFiles: 22,
      ...pr,
    },
  } as RepoEventOf<typeof type>;
}

describe('excerpts in alerts', () => {
  it('never leaves a code fence open, so what follows the excerpt stays outside it', () => {
    const bodies = [
      `Intro paragraph.\n\n\`\`\`dockerfile\nRUN --mount=type=cache,target=/pnpm/store ${'x'.repeat(400)}\n\`\`\``,
      `Intro.\n\n\`\`\`sh\nnever closed`,
      `\`\`\`\n${'y'.repeat(600)}\n\`\`\``,
      `Steps:\n\`\`\`\nfirst\n\`\`\`\n\nthen\n\n\`\`\`\n${'z'.repeat(300)}\n\`\`\``,
    ];
    for (const body of bodies) {
      const event = {
        ...issueOpened(body),
        senderHistory: {
          firstSeenAt: null,
          priorEvents: 0,
          priorRepositories: 0,
          priorInRepository: 0,
        },
      };
      const { description } = embedOf(formatDiscordEmbed(event));
      expect(fences(description) % 2).toBe(0);
      expect(description?.endsWith('👋 First event recorded from them')).toBe(true);
    }
  });

  it('shows prose, not tables, HTML, images, checkboxes or link targets', () => {
    const body = [
      '<!-- template hint -->',
      'Fixes the [checksum](https://example.com/very/long/url) check ![shot](https://x/y.png).',
      '',
      '| Package | Change |',
      '| --- | --- |',
      '| knip | 6.44 |',
      '',
      '<details><summary>Release notes</summary>\n\nlots of notes\n\n</details>',
      '',
      '- [ ] tests added',
      '<p align="center">centered</p>',
    ].join('\n');

    expect(embedOf(formatDiscordEmbed(issueOpened(body))).description).toBe(
      'Fixes the checksum check .\n\ncentered'
    );
  });

  it('cuts at a sentence, never inside a link or an inline code span', () => {
    const sentence = 'The runner keeps `docker buildx` state in a cache mount. ';
    const body = `${sentence.repeat(7)}See [the docs](https://example.com/${'p'.repeat(200)}) and \`${'c'.repeat(100)}\``;
    const description = embedOf(formatDiscordEmbed(issueOpened(body))).description ?? '';

    expect(description.length).toBeLessThanOrEqual(300);
    expect(description.endsWith('cache mount.…')).toBe(true);
    expect(description).not.toContain('https://');
    expect((description.match(/`/g) ?? []).length % 2).toBe(0);
  });

  it('leaves out what a bot wrote, since its title says the same', () => {
    const bot = issueOpened('This PR contains the following updates', {}, user('renovate[bot]'));
    expect(embedOf(formatDiscordEmbed(bot))).not.toHaveProperty('description');
  });

  it('shows what a release changed, not its download table or attestation text', () => {
    const release = (body: string): RepoEventOf<'release.published'> => ({
      type: REPO_EVENT_TYPES.RELEASE_PUBLISHED,
      action: REPO_EVENT_ACTIONS.PUBLISHED,
      repository,
      sender: user('github-actions[bot]', 9),
      timestamp,
      release: {
        tagName: 'v0.0.27',
        name: 'v0.0.27',
        url: `${repository.url}/releases/tag/v0.0.27`,
        body,
        prerelease: false,
      },
    });
    const table =
      '# runnerd 0.0.27\n\n## Download runnerd 0.0.27\n\n| File | Platform | Checksum |\n| --- | --- | --- |\n| [a.tgz](https://x/a.tgz) | linux | abc |';
    const attestation =
      '## Verifying GitHub Artifact Attestations\n\nThe artifacts have attestations.\n\n```sh\ngh attestation verify x\n```';

    expect(embedOf(formatDiscordEmbed(release(`${table}\n\n${attestation}`)))).not.toHaveProperty(
      'description'
    );
    expect(
      embedOf(
        formatDiscordEmbed(
          release(`${table}\n\n## Fixed\n\n- admission for elastic VMs\n\n${attestation}`)
        )
      ).description
    ).toBe('Fixed\n\n- admission for elastic VMs');
  });
});

describe('who an alert is from, and whether it makes a sound', () => {
  it('posts routine events silently and puts the repository above the title', () => {
    const routine = pullRequest('pull_request.merged', {}, { silent: true });
    const loud = pullRequest('pull_request.opened', {});

    expect(formatDiscordEmbed(routine).flags).toBe(4096);
    expect(formatDiscordEmbed(loud)).not.toHaveProperty('flags');
    expect(embedOf(formatDiscordEmbed(loud)).author?.name).toBe('razakiau · owner/runnerd');
    expect(embedOf(formatDiscordEmbed(loud)).footer?.text).toBe('chore/release-0.0.28 → main');
    expect(embedOf(formatDiscordEmbed(routine))).not.toHaveProperty('footer');
  });

  it('stays loud for a star milestone even when its star is routine', () => {
    const star: RepoEventOf<'star.created'> = {
      type: REPO_EVENT_TYPES.STAR_CREATED,
      action: REPO_EVENT_ACTIONS.CREATED,
      repository,
      sender: user('owner', 1),
      timestamp,
      silent: true,
      star: { count: 101 },
    };
    const milestone = {
      milestone: 100,
      reachedAt: '2026-11-03T15:04:00.000Z',
      previous: null,
      recentStars: { since: '2026-10-27T15:04:00.000Z', net: 3 },
    };

    expect(formatDiscordEmbed(star).flags).toBe(4096);
    expect(formatDiscordEmbed({ ...star, starMilestone: milestone })).not.toHaveProperty('flags');
  });

  it('decides silence from who acted: bots, the owner and ignored logins, but never a force-push', () => {
    const star = (who: RepoEvent['sender']): RepoEvent => ({
      type: REPO_EVENT_TYPES.STAR_CREATED,
      action: REPO_EVENT_ACTIONS.CREATED,
      repository,
      sender: who,
      timestamp,
      star: { count: 2 },
    });
    const ignored = new Set(['teammate']);
    const push = (who: RepoEvent['sender'], forced: boolean): RepoEvent => ({
      type: REPO_EVENT_TYPES.PUSH_DEFAULT_BRANCH,
      action: REPO_EVENT_ACTIONS.PUSHED,
      repository,
      sender: who,
      timestamp,
      push: { branch: 'main', compareUrl: 'https://x/compare', forced, commits: [] },
    });

    expect(isSilentAlert(star(user('Owner', 1)), ignored)).toBe(true);
    expect(isSilentAlert(star(user('renovate[bot]', 2)), ignored)).toBe(true);
    expect(isSilentAlert(star(user('Teammate', 3)), ignored)).toBe(true);
    expect(isSilentAlert(star(user('razakiau', 4)), ignored)).toBe(false);
    expect(isSilentAlert(push(user('owner', 1), false), ignored)).toBe(true);
    expect(isSilentAlert(push(user('owner', 1), true), ignored)).toBe(false);
  });
});

describe('pull request alerts', () => {
  it('says whose work was merged, how long it took, what it closes and how big it was', () => {
    const merged = pullRequest(
      'pull_request.merged',
      {
        author: 'razakiau',
        createdAt: '2026-11-03T10:00:00.000Z',
        commits: 3,
        body: '<!-- Closes #1 -->\nCloses #190, fixes #191.\n\n```\nCloses #5\n```',
      },
      { who: user('owner', 1), occurredAt: '2026-11-03T12:30:00.000Z', silent: true }
    );

    const embed = embedOf(formatDiscordEmbed(merged));
    expect(embed.title).toBe('🔀 Merged PR #199: chore: release 0.0.28');
    expect(embed.description).toBe(
      'by razakiau · +41 −41 in 22 files · 3 commits · merged 2h after opening · closes #190, #191'
    );
  });

  it('names an outsider’s association on their opened pull request, and keeps the branch', () => {
    const opened = pullRequest('pull_request.opened', {
      author: 'razakiau',
      authorAssociation: 'first_time_contributor',
      additions: 12,
      deletions: 3,
      changedFiles: 2,
    });

    const embed = embedOf(formatDiscordEmbed(opened));
    expect(embed.description).toBe('First-time contributor · +12 −3 in 2 files');
    expect(embed.footer?.text).toBe('chore/release-0.0.28 → main');
  });

  it('renders a pull request stored before the new fields existed', () => {
    const old = pullRequest('pull_request.merged', {});
    for (const field of ['additions', 'deletions', 'changedFiles']) {
      Reflect.deleteProperty(old.pullRequest, field);
    }

    expect(embedOf(formatDiscordEmbed(old))).not.toHaveProperty('description');
  });
});

describe('issue, release and push alerts', () => {
  it('tells a completed close from a not-planned one, and an open from a reopen', () => {
    const closed = (stateReason?: 'completed' | 'not_planned'): string =>
      embedOf(
        formatDiscordEmbed({
          ...issueOpened(null, { state: 'closed', ...(stateReason ? { stateReason } : {}) }),
          type: REPO_EVENT_TYPES.ISSUE_CLOSED,
          action: REPO_EVENT_ACTIONS.CLOSED,
        })
      ).title;

    expect(closed('completed')).toMatch(/^✅ Closed issue #181/);
    expect(closed()).toMatch(/^✅ Closed issue #181/);
    expect(closed('not_planned')).toMatch(/^🚫 Closed as not planned: issue #181/);
    expect(embedOf(formatDiscordEmbed(issueOpened(null))).title).toMatch(/^🟢 Opened issue/);
  });

  it('lists assets only when the release has some, and shows who authored a commit only when it is not the sender', () => {
    const release = (assets: object): RepoEvent => ({
      type: REPO_EVENT_TYPES.RELEASE_PUBLISHED,
      action: REPO_EVENT_ACTIONS.PUBLISHED,
      repository,
      sender: user('owner', 1),
      timestamp,
      release: {
        tagName: 'v1',
        name: null,
        url: `${repository.url}/releases/tag/v1`,
        body: null,
        prerelease: false,
        ...assets,
      },
    });
    const push = (author: string): RepoEvent => ({
      type: REPO_EVENT_TYPES.PUSH_DEFAULT_BRANCH,
      action: REPO_EVENT_ACTIONS.PUSHED,
      repository,
      sender: user('owner', 1),
      timestamp,
      push: {
        branch: 'main',
        compareUrl: 'https://x/compare',
        forced: false,
        commits: [{ id: 'a'.repeat(40), message: 'fix: it', url: 'https://x/c', author }],
      },
    });

    expect(
      embedOf(formatDiscordEmbed(release({ assetCount: 6, assetBytes: 43_000_000 }))).description
    ).toBe('6 assets · 41 MB');
    expect(embedOf(formatDiscordEmbed(release({})))).not.toHaveProperty('description');
    expect(embedOf(formatDiscordEmbed(push('Owner'))).description).not.toContain('—');
    expect(embedOf(formatDiscordEmbed(push('someone-else'))).description).toMatch(
      / — someone-else$/
    );
  });

  it('keeps the whole embed within 6,000 characters for the longest titles and excerpts', () => {
    const embed = embedOf(
      formatDiscordEmbed({
        ...issueOpened('word '.repeat(2000), {
          title: 'T'.repeat(400),
          labels: Array.from({ length: 100 }, () => 'label'.repeat(10)),
        }),
        senderHistory: {
          firstSeenAt: '2026-10-30T00:00:00.000Z',
          priorEvents: 5,
          priorRepositories: 2,
          priorInRepository: 1,
        },
      })
    );
    const total =
      embed.title.length +
      (embed.description?.length ?? 0) +
      (embed.author?.name.length ?? 0) +
      (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);

    expect(total).toBeLessThanOrEqual(6000);
  });
});

describe('digest messages', () => {
  const activity = (overrides: Partial<RepositoryActivity>): RepositoryActivity => ({
    repository: 'owner/runnerd',
    url: 'https://github.com/owner/runnerd',
    starsGained: 0,
    forks: 0,
    commits: 0,
    pullRequestsOpened: 0,
    pullRequestsOpenedByBots: 0,
    pullRequestsMerged: [],
    issuesOpened: 0,
    issuesClosed: 0,
    releases: [],
    ...overrides,
  });
  const digest = (repositories: RepositoryActivity[], unreleased = 0): Digest => ({
    period: 'daily',
    date: '2026-11-03',
    timeZone: 'Europe/Paris',
    windowStart: new Date('2026-11-02T08:00:00.000Z'),
    windowEnd: new Date('2026-11-03T08:00:00.000Z'),
    eventCount: 12,
    repositories,
    unreleased: Array.from({ length: unreleased }, (_, index) => ({
      repository: `owner/repo-${String(index)}`,
      compareUrl: 'https://github.com/compare',
      tagName: 'v1',
      releasedAt: new Date('2026-09-02T08:00:00.000Z'),
      commitsSinceRelease: 41,
    })),
    people: [],
    waiting: [],
    responseTimes: null,
  });
  const merged = (number: number, byBot: boolean): RepositoryActivity['pullRequestsMerged'][0] => ({
    number,
    title: byBot ? `chore(deps): bump ${String(number)}` : `feat: change ${String(number)}`,
    url: `https://github.com/owner/runnerd/pull/${String(number)}`,
    byBot,
  });

  it('counts bot pull requests but lists only people’s, under what needs a person', () => {
    const embed = embedOf(
      formatDiscordDigest(
        digest(
          [
            activity({
              starsGained: 1,
              pullRequestsOpened: 4,
              pullRequestsOpenedByBots: 3,
              pullRequestsMerged: [merged(1, true), merged(2, true), merged(3, false)],
            }),
            activity({
              repository: 'owner/dependabot-only',
              url: 'https://github.com/owner/dependabot-only',
              pullRequestsMerged: [merged(9, true)],
            }),
          ],
          2
        )
      )
    );

    expect(embed.title).toBe('📊 Daily pulse · Tue 3 Nov');
    expect(embed.author?.name).toBe('Repo Pulse');
    expect(embed.description).toBe(
      [
        '1 new star · 2 repos with unreleased work',
        '',
        '**[owner/runnerd](https://github.com/owner/runnerd)** ⭐ +1 · 3 PRs merged (2 by bots) · 4 PRs opened (3 by bots)',
        '↳ [#3](https://github.com/owner/runnerd/pull/3) feat: change 3',
        '**[owner/dependabot-only](https://github.com/owner/dependabot-only)** 1 PR merged (1 by bots)',
      ].join('\n')
    );
  });

  it('words how long ago a release was, not its date', () => {
    const embed = embedOf(formatDiscordDigest(digest([activity({ commits: 1 })], 1)));
    expect(embed.fields?.[0]?.value).toMatch(/41 commits since v1, 62d ago$/);
  });
});
