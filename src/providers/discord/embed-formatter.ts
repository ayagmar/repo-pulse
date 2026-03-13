import type {
  ForkEvent,
  IssueEvent,
  PullRequestEvent,
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
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  thumbnail?: {
    url: string;
  };
}

interface DiscordWebhookPayload {
  username?: string;
  avatar_url?: string;
  embeds: DiscordEmbed[];
}

// Color palette for different event types
const COLORS: Record<'star' | 'issue' | 'pullRequest' | 'fork' | 'merged' | 'closed', number> = {
  star: 0xffd700, // Gold
  issue: 0x28a745, // Green
  pullRequest: 0x6f42c1, // Purple
  fork: 0x0366d6, // Blue
  merged: 0x6f42c1, // Purple
  closed: 0xcb2431, // Red
} as const;

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength - 3)}...`;
}

function formatRepoName(event: RepoEvent): string {
  return `[${event.repository.fullName}](${event.repository.url})`;
}

function createBaseEmbed(event: RepoEvent): Pick<DiscordEmbed, 'timestamp' | 'footer' | 'author'> {
  return {
    timestamp: event.timestamp.toISOString(),
    footer: {
      text: event.repository.fullName,
    },
    author: {
      name: event.sender.login,
      url: event.sender.url,
      icon_url: event.sender.avatarUrl,
    },
  };
}

function formatStarEvent(event: StarEvent): DiscordWebhookPayload {
  const isStarRemoved = event.type === REPO_EVENT_TYPES.STAR_DELETED;
  const embed: DiscordEmbed = {
    ...createBaseEmbed(event),
    title: isStarRemoved ? '💫 Star Removed' : '⭐ New Star',
    description: `${formatRepoName(event)} now has **${event.star.count}** stars!`,
    color: COLORS.star,
    thumbnail: {
      url: 'https://github.githubassets.com/images/icons/emoji/unicode/2b50.png',
    },
  };

  return { embeds: [embed] };
}

function formatIssueEvent(event: IssueEvent): DiscordWebhookPayload {
  const { issue } = event;

  let title = '🐛 New Issue';
  let color = COLORS.issue;

  if (event.type === REPO_EVENT_TYPES.ISSUE_CLOSED) {
    title = '🔒 Issue Closed';
    color = COLORS.closed;
  } else if (event.type === REPO_EVENT_TYPES.ISSUE_REOPENED) {
    title = '🔓 Issue Reopened';
  }

  const embed: DiscordEmbed = {
    ...createBaseEmbed(event),
    title: `${title} #${issue.number}`,
    description: `**${issue.title}**\n\n${truncate(issue.body ?? 'No description provided.', 200)}`,
    url: issue.url,
    color,
    fields: [
      {
        name: 'Labels',
        value: issue.labels.length > 0 ? issue.labels.join(', ') : 'None',
        inline: true,
      },
      {
        name: 'State',
        value: issue.state,
        inline: true,
      },
    ],
  };

  return { embeds: [embed] };
}

function formatPullRequestEvent(event: PullRequestEvent): DiscordWebhookPayload {
  const { pullRequest: pr } = event;

  let title = '📥 New Pull Request';
  let color = COLORS.pullRequest;

  if (event.type === REPO_EVENT_TYPES.PULL_REQUEST_MERGED) {
    title = '🔀 Pull Request Merged';
    color = COLORS.merged;
  } else if (event.type === REPO_EVENT_TYPES.PULL_REQUEST_CLOSED) {
    title = '❌ Pull Request Closed';
    color = COLORS.closed;
  } else if (event.type === REPO_EVENT_TYPES.PULL_REQUEST_REOPENED) {
    title = '🔄 Pull Request Reopened';
  }

  const fields: DiscordEmbed['fields'] = [
    {
      name: 'Branch',
      value: `${pr.headBranch} → ${pr.baseBranch}`,
      inline: true,
    },
  ];

  if (pr.draft) {
    fields.push({
      name: 'Status',
      value: 'Draft',
      inline: true,
    });
  }

  if (pr.additions !== undefined && pr.deletions !== undefined) {
    fields.push({
      name: 'Changes',
      value: `+${pr.additions} -${pr.deletions}`,
      inline: true,
    });
  }

  const embed: DiscordEmbed = {
    ...createBaseEmbed(event),
    title: `${title} #${pr.number}`,
    description: `**${pr.title}**${pr.draft ? ' (Draft)' : ''}\n\n${truncate(pr.body ?? 'No description provided.', 200)}`,
    url: pr.url,
    color,
    fields,
  };

  return { embeds: [embed] };
}

function formatForkEvent(event: ForkEvent): DiscordWebhookPayload {
  const { fork } = event;

  const embed: DiscordEmbed = {
    ...createBaseEmbed(event),
    title: '🍴 New Fork',
    description: `**${event.sender.login}** forked ${formatRepoName(event)} to **[${fork.fullName}](${fork.url})**`,
    color: COLORS.fork,
    url: fork.url,
    fields: [
      {
        name: 'Default Branch',
        value: fork.defaultBranch,
        inline: true,
      },
    ],
  };

  return { embeds: [embed] };
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
  }
}
