import type { Digest, RepositoryActivity, UnreleasedWork } from '../../core/models/digest.js';
import type {
  ForkEvent,
  IssueEvent,
  PullRequestEvent,
  PushEvent,
  ReleaseEvent,
  RepoEvent,
  StarEvent,
} from '../../core/models/repo-event.js';
import { REPO_EVENT_TYPES } from '../../core/models/repo-event.js';

/**
 * Discord embed structure
 */
interface DiscordEmbed {
  title: string;
  description?: string;
  url?: string;
  color: number;
  timestamp?: string;
  footer?: {
    text: string;
    icon_url?: string;
  };
  author?: {
    name: string;
    url?: string;
    icon_url?: string;
  };
  fields?: {
    name: string;
    value: string;
    inline?: boolean;
  }[];
  thumbnail?: {
    url: string;
  };
}

export interface DiscordWebhookPayload {
  username?: string;
  avatar_url?: string;
  embeds: DiscordEmbed[];
}

// Discord embed limits: https://discord.com/developers/docs/resources/message#embed-object-embed-limits
const TITLE_LIMIT = 256;
const DESCRIPTION_LIMIT = 4096;
const FIELD_VALUE_LIMIT = 1024;
const EXCERPT_LIMIT = 300;
const COMMIT_SUBJECT_LIMIT = 72;
const LISTED_COMMITS = 5;
const LISTED_RELEASES = 3;
const LISTED_PULL_REQUESTS = 3;
const LISTED_UNRELEASED = 5;

// GitHub's state colors, so a message reads like the badge it links to.
const COLORS = {
  open: 0x2da44e,
  draft: 0x6e7781,
  merged: 0x8250df,
  closed: 0xcf222e,
  star: 0xe3b341,
  fork: 0x0969da,
  push: 0x0969da,
  forcePush: 0xbc4c00,
  release: 0x2da44e,
  prerelease: 0xbf8700,
} as const;

/** Star counts worth celebrating; past the last one, every further 10,000. */
const STAR_MILESTONES = new Set([10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000]);

function isStarMilestone(count: number): boolean {
  return STAR_MILESTONES.has(count) || (count > 10_000 && count % 10_000 === 0);
}

const GITHUB_ICON_URL = 'https://github.githubassets.com/favicons/favicon.png';

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength - 3)}...`;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * A short, readable excerpt of a Markdown body. Issue and pull-request
 * templates are mostly HTML comments, which Discord would show verbatim.
 */
function excerpt(body: string | null, maxLength = EXCERPT_LIMIT): string | null {
  if (body === null) return null;
  const text = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text === '' ? null : truncate(text, maxLength);
}

function repoLink(event: RepoEvent): string {
  return `[${event.repository.fullName}](${event.repository.url})`;
}

function senderLink(event: RepoEvent): string {
  return `[${event.sender.login}](${event.sender.url})`;
}

function createEmbed(
  event: RepoEvent,
  embed: Omit<DiscordEmbed, 'timestamp' | 'footer' | 'author'>
): DiscordWebhookPayload {
  return {
    embeds: [
      {
        ...embed,
        title: truncate(embed.title, TITLE_LIMIT),
        timestamp: event.timestamp.toISOString(),
        footer: { text: event.repository.fullName, icon_url: GITHUB_ICON_URL },
        author: {
          name: event.sender.login,
          url: event.sender.url,
          icon_url: event.sender.avatarUrl,
        },
      },
    ],
  };
}

function formatStarEvent(event: StarEvent): DiscordWebhookPayload {
  const removed = event.type === REPO_EVENT_TYPES.STAR_DELETED;
  const milestone = !removed && isStarMilestone(event.star.count);
  return createEmbed(event, {
    title: removed
      ? '💫 Star removed'
      : milestone
        ? `🎉 ${event.star.count.toLocaleString('en-US')} stars!`
        : '⭐ New star',
    url: event.repository.url,
    description: `${senderLink(event)} ${removed ? 'unstarred' : 'starred'} ${repoLink(event)}\n⭐ **${String(event.star.count)}** total`,
    color: COLORS.star,
  });
}

function formatIssueEvent(event: IssueEvent): DiscordWebhookPayload {
  const { issue } = event;
  const [verb, color] =
    event.type === REPO_EVENT_TYPES.ISSUE_CLOSED
      ? ['🔒 Closed', COLORS.merged]
      : event.type === REPO_EVENT_TYPES.ISSUE_REOPENED
        ? ['🔓 Reopened', COLORS.open]
        : ['🐛 Opened', COLORS.open];

  const fields: DiscordEmbed['fields'] = [];
  if (issue.labels.length > 0) {
    fields.push({
      name: 'Labels',
      value: truncate(issue.labels.map((label) => `\`${label}\``).join(' '), FIELD_VALUE_LIMIT),
      inline: true,
    });
  }

  const description = event.type === REPO_EVENT_TYPES.ISSUE_OPENED ? excerpt(issue.body) : null;
  return createEmbed(event, {
    title: `${verb} issue #${String(issue.number)}: ${issue.title}`,
    url: issue.url,
    ...(description !== null ? { description } : {}),
    color,
    ...(fields.length > 0 ? { fields } : {}),
  });
}

function formatPullRequestEvent(event: PullRequestEvent): DiscordWebhookPayload {
  const { pullRequest: pr } = event;
  const [verb, color] =
    event.type === REPO_EVENT_TYPES.PULL_REQUEST_MERGED
      ? ['🔀 Merged', COLORS.merged]
      : event.type === REPO_EVENT_TYPES.PULL_REQUEST_CLOSED
        ? ['❌ Closed', COLORS.closed]
        : event.type === REPO_EVENT_TYPES.PULL_REQUEST_REOPENED
          ? ['🔄 Reopened', COLORS.open]
          : pr.draft
            ? ['📝 Opened draft', COLORS.draft]
            : ['📥 Opened', COLORS.open];

  const fields: NonNullable<DiscordEmbed['fields']> = [
    {
      name: 'Branch',
      value: truncate(`\`${pr.headBranch}\` → \`${pr.baseBranch}\``, FIELD_VALUE_LIMIT),
      inline: true,
    },
  ];
  if (pr.additions !== undefined && pr.deletions !== undefined) {
    const files = pr.changedFiles === undefined ? '' : ` in ${plural(pr.changedFiles, 'file')}`;
    fields.push({
      name: 'Changes',
      value: `+${String(pr.additions)} −${String(pr.deletions)}${files}`,
      inline: true,
    });
  }

  const description = event.type === REPO_EVENT_TYPES.PULL_REQUEST_OPENED ? excerpt(pr.body) : null;
  return createEmbed(event, {
    title: `${verb} PR #${String(pr.number)}: ${pr.title}`,
    url: pr.url,
    ...(description !== null ? { description } : {}),
    color,
    fields,
  });
}

function formatForkEvent(event: ForkEvent): DiscordWebhookPayload {
  const { fork } = event;
  return createEmbed(event, {
    title: '🍴 New fork',
    url: fork.url,
    description: `${senderLink(event)} forked ${repoLink(event)} → [${fork.fullName}](${fork.url})\n🍴 **${String(event.repository.forks)}** total`,
    color: COLORS.fork,
  });
}

function formatPushEvent(event: PushEvent): DiscordWebhookPayload {
  const { push } = event;
  const count = push.commits.length;
  const listed = push.commits.slice(-LISTED_COMMITS);
  const lines = listed.map(
    (commit) =>
      `[\`${commit.id.slice(0, 7)}\`](${commit.url}) ${truncate(commit.message, COMMIT_SUBJECT_LIMIT)} — ${commit.author}`
  );
  if (count > listed.length) {
    lines.unshift(`_…and ${plural(count - listed.length, 'earlier commit')}_`);
  }

  return createEmbed(event, {
    title: push.forced
      ? `⚠️ Force-pushed ${plural(count, 'commit')} to ${push.branch}`
      : `📌 ${plural(count, 'new commit')} on ${push.branch}`,
    url: push.compareUrl,
    description: lines.join('\n'),
    color: push.forced ? COLORS.forcePush : COLORS.push,
  });
}

function formatReleaseEvent(event: ReleaseEvent): DiscordWebhookPayload {
  const { release } = event;
  const notes = excerpt(release.body, 600);
  const name = release.name ?? release.tagName;

  return createEmbed(event, {
    title: `${release.prerelease ? '🧪 Pre-release' : '🚀 Released'} ${name}`,
    url: release.url,
    ...(notes !== null ? { description: notes } : {}),
    color: release.prerelease ? COLORS.prerelease : COLORS.release,
    ...(name !== release.tagName
      ? { fields: [{ name: 'Tag', value: `\`${release.tagName}\``, inline: true }] }
      : {}),
  });
}

/**
 * Format a RepoEvent into a Discord webhook payload
 */
export function formatDiscordEmbed(event: RepoEvent): DiscordWebhookPayload {
  switch (event.type) {
    case REPO_EVENT_TYPES.STAR_CREATED:
    case REPO_EVENT_TYPES.STAR_DELETED:
      return formatStarEvent(event);

    case REPO_EVENT_TYPES.ISSUE_OPENED:
    case REPO_EVENT_TYPES.ISSUE_CLOSED:
    case REPO_EVENT_TYPES.ISSUE_REOPENED:
      return formatIssueEvent(event);

    case REPO_EVENT_TYPES.PULL_REQUEST_OPENED:
    case REPO_EVENT_TYPES.PULL_REQUEST_CLOSED:
    case REPO_EVENT_TYPES.PULL_REQUEST_MERGED:
    case REPO_EVENT_TYPES.PULL_REQUEST_REOPENED:
      return formatPullRequestEvent(event);

    case REPO_EVENT_TYPES.FORK_CREATED:
      return formatForkEvent(event);

    case REPO_EVENT_TYPES.PUSH_DEFAULT_BRANCH:
      return formatPushEvent(event);

    case REPO_EVENT_TYPES.RELEASE_PUBLISHED:
      return formatReleaseEvent(event);
  }
}

function releasedSummary(releases: RepositoryActivity['releases']): string {
  const listed = releases
    .slice(-LISTED_RELEASES)
    .map((release) => `[${release.tagName}](${release.url})`);
  const earlier = releases.length - listed.length;
  return `released ${listed.join(', ')}${earlier > 0 ? ` and ${String(earlier)} more` : ''}`;
}

function activitySummary(activity: RepositoryActivity): string {
  const items = [
    activity.starsGained !== 0
      ? `⭐ ${activity.starsGained > 0 ? '+' : ''}${String(activity.starsGained)}`
      : null,
    activity.commits > 0 ? plural(activity.commits, 'commit') : null,
    activity.pullRequestsMerged.length > 0
      ? `${plural(activity.pullRequestsMerged.length, 'PR')} merged`
      : null,
    activity.pullRequestsOpened > 0 ? `${plural(activity.pullRequestsOpened, 'PR')} opened` : null,
    activity.issuesOpened > 0 ? `${plural(activity.issuesOpened, 'issue')} opened` : null,
    activity.issuesClosed > 0 ? `${plural(activity.issuesClosed, 'issue')} closed` : null,
    activity.forks > 0 ? plural(activity.forks, 'fork') : null,
    activity.releases.length > 0 ? releasedSummary(activity.releases) : null,
  ].filter((item) => item !== null);

  return items.length > 0 ? items.join(' · ') : 'no net change';
}

/** The latest merged pull requests, one line each, for the weekly digest. */
function mergedPullRequestLines(merged: RepositoryActivity['pullRequestsMerged']): string[] {
  const listed = merged.slice(-LISTED_PULL_REQUESTS);
  const lines = listed.map(
    (pr) => `↳ [#${String(pr.number)}](${pr.url}) ${truncate(pr.title, COMMIT_SUBJECT_LIMIT)}`
  );
  if (merged.length > listed.length) {
    lines.unshift(`↳ _…and ${plural(merged.length - listed.length, 'earlier PR')}_`);
  }
  return lines;
}

/** Repositories with the most commits since their latest release, as one embed field. */
function unreleasedField(
  unreleased: readonly UnreleasedWork[],
  timeZone: string
): NonNullable<DiscordEmbed['fields']> {
  const releaseDate = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const lines: string[] = [];
  let length = 0;
  const mostAhead = [...unreleased]
    .sort((left, right) => right.commitsSinceRelease - left.commitsSinceRelease)
    .slice(0, LISTED_UNRELEASED);
  for (const work of mostAhead) {
    const line = `[${work.repository}](${work.compareUrl}) ${plural(work.commitsSinceRelease, 'commit')} since ${work.tagName} (${releaseDate.format(work.releasedAt)})`;
    if (length + line.length + 1 > FIELD_VALUE_LIMIT) {
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }

  return lines.length > 0 ? [{ name: '🚢 Not released yet', value: lines.join('\n') }] : [];
}

function repositories(count: number): string {
  return `${String(count)} ${count === 1 ? 'repository' : 'repositories'}`;
}

function formatDigestTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
}

/**
 * Format a digest as one embed with a line per repository, most active first. The
 * weekly digest also lists each repository's latest merged pull requests.
 */
export function formatDiscordDigest(digest: Digest): DiscordWebhookPayload {
  const lines: string[] = [];
  let length = 0;
  for (const [index, activity] of digest.repositories.entries()) {
    const block = [
      `**[${activity.repository}](${activity.url})** ${activitySummary(activity)}`,
      ...(digest.period === 'weekly' ? mergedPullRequestLines(activity.pullRequestsMerged) : []),
    ].join('\n');
    // Leave room for the "and N more" line.
    if (length + block.length + 1 > DESCRIPTION_LIMIT - 64) {
      lines.push(`_…and ${repositories(digest.repositories.length - index)} more_`);
      break;
    }
    lines.push(block);
    length += block.length + 1;
  }

  const fields = unreleasedField(digest.unreleased, digest.timeZone);
  const heading = digest.period === 'weekly' ? '📦 Weekly pulse' : '📊 Daily pulse';
  return {
    embeds: [
      {
        title: `${heading}: ${plural(digest.eventCount, 'event')} in ${repositories(digest.repositories.length)}`,
        description: lines.join('\n'),
        color: COLORS.push,
        timestamp: digest.windowEnd.toISOString(),
        ...(fields.length > 0 ? { fields } : {}),
        footer: {
          text: `${formatDigestTime(digest.windowStart, digest.timeZone)} to ${formatDigestTime(digest.windowEnd, digest.timeZone)} · ${digest.timeZone}`,
          icon_url: GITHUB_ICON_URL,
        },
      },
    ],
  };
}
