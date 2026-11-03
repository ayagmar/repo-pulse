import type {
  Digest,
  PersonActivity,
  RepositoryActivity,
  ResponseTimes,
  UnreleasedWork,
  WaitingThread,
} from '../../core/models/digest.js';
import { formatDuration } from '../../core/models/duration.js';
import type { IssueActionOutcome } from '../../core/models/issue-action.js';
import type { MomentumAlert } from '../../core/models/momentum-alert.js';
import type {
  CommentEvent,
  ForkEvent,
  IssueEvent,
  PullRequestEvent,
  PushEvent,
  ReleaseEvent,
  RepoEvent,
  RepoEventOf,
  ReviewEvent,
  SenderHistory,
  StarEvent,
  Thread,
} from '../../core/models/repo-event.js';
import { REPO_EVENT_TYPES, REVIEW_STATES } from '../../core/models/repo-event.js';

import type { StarMilestone } from '../../core/models/star-milestone.js';
import { RECENT_STARS_DAYS, readStarMilestone } from '../../core/models/star-milestone.js';
import { isBotLogin } from '../../core/services/people.js';
import { excerpt } from './excerpt.js';
import { issueActionCustomId } from './interactions.js';

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

interface DiscordButton {
  type: 2;
  /** 2 is grey, 4 red. */
  style: 2 | 4;
  label: string;
  custom_id: string;
  disabled?: boolean;
}

interface DiscordActionRow {
  type: 1;
  components: DiscordButton[];
}

export interface DiscordWebhookPayload {
  username?: string;
  avatar_url?: string;
  embeds: DiscordEmbed[];
  /** Only sent to an application-owned webhook, with `with_components=true`. */
  components?: DiscordActionRow[];
  /** `SUPPRESS_NOTIFICATIONS` on routine alerts: the message lands, without a push. */
  flags?: number;
}

// Discord embed limits: https://discord.com/developers/docs/resources/message#embed-object-embed-limits
const TITLE_LIMIT = 256;
const AUTHOR_LIMIT = 256;
const DESCRIPTION_LIMIT = 4096;
const FIELD_VALUE_LIMIT = 1024;
/** Title, description, field names and values, footer and author name together. */
const EMBED_TOTAL_LIMIT = 6000;
const SUPPRESS_NOTIFICATIONS = 4096;
const EXCERPT_LIMIT = 300;
const RELEASE_NOTES_LIMIT = 600;
const COMMIT_SUBJECT_LIMIT = 72;
const LISTED_COMMITS = 5;
const LISTED_RELEASES = 3;
const LISTED_PULL_REQUESTS = 3;
const LISTED_CLOSED_ISSUES = 3;
const LISTED_UNRELEASED = 5;
const LISTED_WAITING = 5;
const DIGEST_AUTHOR = 'Repo Pulse';

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
  comment: 0x6e7781,
} as const;

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength - 1)}…`;
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}

/** The facts of one message on a single line, in order, `·` apart. */
function factsLine(parts: readonly (string | null | undefined | false)[]): string | null {
  const facts = parts.filter((part) => typeof part === 'string' && part !== '');
  return facts.length > 0 ? facts.join(' · ') : null;
}

/**
 * The body excerpt of what a person wrote. Bots' text restates their title, so it is
 * left out.
 */
function bodyExcerpt(event: RepoEvent, body: string | null, limit = EXCERPT_LIMIT): string | null {
  return isBotLogin(event.sender.login) ? null : excerpt(body, { limit });
}

const ASSOCIATIONS: Readonly<Record<string, string>> = {
  first_timer: 'First-time GitHub user',
  first_time_contributor: 'First-time contributor',
  contributor: 'Contributor',
  collaborator: 'Collaborator',
  member: 'Member',
};

/** What GitHub knows of an outside author, for events that are not routine. */
function associationLabel(event: RepoEvent, association: string | undefined): string | null {
  return event.silent === true || association === undefined
    ? null
    : (ASSOCIATIONS[association] ?? null);
}

function senderLink(event: RepoEvent): string {
  return `[${event.sender.login}](${event.sender.url})`;
}

const firstSeenDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Whether the sender is new here or has been seen before, across all repositories. */
function senderHistoryLine(history: SenderHistory): string {
  if (history.priorEvents === 0 || history.firstSeenAt === null) {
    // History only starts when Repo Pulse does: "no event recorded" is all it can claim.
    return '👋 First event recorded from them';
  }
  return `↩️ Seen before: ${plural(history.priorEvents, 'event')} in ${plural(history.priorRepositories, 'repo')} since ${firstSeenDate.format(new Date(history.firstSeenAt))}`;
}

interface EmbedOptions {
  /** Footer text; the timestamp is always shown. */
  footer?: string;
  /** Sent with a push notification even when the event was frozen as routine. */
  loud?: boolean;
}

/**
 * One alert: the sender and repository above the title, the timestamp below. A routine
 * event, frozen as `silent` when it was accepted, posts without a push notification.
 */
function createEmbed(
  event: RepoEvent,
  embed: Omit<DiscordEmbed, 'timestamp' | 'footer' | 'author'>,
  options: EmbedOptions = {}
): DiscordWebhookPayload {
  const description =
    event.senderHistory === undefined
      ? embed.description
      : [embed.description, senderHistoryLine(event.senderHistory)]
          .filter((part) => part !== undefined)
          .join('\n\n');
  return {
    embeds: [
      {
        ...embed,
        ...(description !== undefined ? { description } : {}),
        title: truncate(embed.title, TITLE_LIMIT),
        timestamp: event.timestamp.toISOString(),
        ...(options.footer !== undefined
          ? { footer: { text: truncate(options.footer, TITLE_LIMIT) } }
          : {}),
        author: {
          name: truncate(`${event.sender.login} · ${event.repository.fullName}`, AUTHOR_LIMIT),
          url: event.sender.url,
          icon_url: event.sender.avatarUrl,
        },
      },
    ],
    ...(event.silent === true && options.loud !== true ? { flags: SUPPRESS_NOTIFICATIONS } : {}),
  };
}

/** How long from `from` to `to`, or null when either is not a time or `from` is later. */
function durationBetween(from: string | undefined, to: string | undefined): string | null {
  if (from === undefined || to === undefined) {
    return null;
  }
  const milliseconds = Date.parse(to) - Date.parse(from);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? formatDuration(milliseconds) : null;
}

/**
 * A celebration, rendered only from what acceptance stored. The star is the first seen
 * past the milestone, not proof its sender was the one who reached it. Always loud.
 */
function formatStarMilestone(
  event: RepoEventOf<'star.created'>,
  milestone: StarMilestone
): DiscordWebhookPayload {
  const { previous, recentStars } = milestone;
  const sincePrevious =
    previous === null ? null : durationBetween(previous.reachedAt, milestone.reachedAt);
  const sinceCreated =
    previous === null ? durationBetween(event.repository.createdAt, milestone.reachedAt) : null;
  const sign = recentStars.net > 0 ? '+' : '';
  const lines = [
    `Observed after ${senderLink(event)} starred this repository · **${event.star.count.toLocaleString('en-US')}** total`,
    ...(previous !== null && sincePrevious !== null
      ? [`⏱️ ${sincePrevious} since ${plural(previous.milestone, 'star')}`]
      : []),
    ...(sinceCreated !== null ? [`⏱️ ${sinceCreated} since the repository was created`] : []),
    `📈 ${sign}${recentStars.net.toLocaleString('en-US')} net recorded star${Math.abs(recentStars.net) === 1 ? '' : 's'} in the last ${String(RECENT_STARS_DAYS)} days`,
  ];
  return createEmbed(
    event,
    {
      title: `🎉 ${event.repository.fullName} reached ${plural(milestone.milestone, 'star')}`,
      url: event.repository.url,
      description: lines.join('\n'),
      color: COLORS.star,
    },
    { loud: true }
  );
}

function formatStarEvent(event: StarEvent): DiscordWebhookPayload {
  if (event.type === REPO_EVENT_TYPES.STAR_CREATED) {
    const milestone = readStarMilestone(event.starMilestone);
    if (milestone !== null) {
      return formatStarMilestone(event, milestone);
    }
  }
  const removed = event.type === REPO_EVENT_TYPES.STAR_DELETED;
  return createEmbed(event, {
    title: `${removed ? '💫 Star removed' : '⭐ New star'} · ${event.star.count.toLocaleString('en-US')} total`,
    url: event.repository.url,
    description: `${senderLink(event)} ${removed ? 'unstarred' : 'starred'} this repository`,
    color: COLORS.star,
  });
}

function formatIssueEvent(event: IssueEvent): DiscordWebhookPayload {
  const { issue } = event;
  const opened = event.type === REPO_EVENT_TYPES.ISSUE_OPENED;
  const [verb, color] =
    event.type === REPO_EVENT_TYPES.ISSUE_CLOSED
      ? issue.stateReason === 'not_planned'
        ? ['🚫 Closed as not planned:', COLORS.merged]
        : ['✅ Closed', COLORS.merged]
      : event.type === REPO_EVENT_TYPES.ISSUE_REOPENED
        ? ['🔄 Reopened', COLORS.open]
        : ['🟢 Opened', COLORS.open];

  const fields: DiscordEmbed['fields'] = [];
  if (issue.labels.length > 0) {
    fields.push({
      name: 'Labels',
      value: truncate(issue.labels.map((label) => `\`${label}\``).join(' '), FIELD_VALUE_LIMIT),
      inline: true,
    });
  }

  const description = opened
    ? [associationLabel(event, issue.authorAssociation), bodyExcerpt(event, issue.body)].filter(
        (part) => part !== null
      )
    : [];
  return createEmbed(event, {
    title: `${verb} issue #${String(issue.number)}: ${issue.title}`,
    url: issue.url,
    ...(description.length > 0 ? { description: description.join('\n\n') } : {}),
    color,
    ...(fields.length > 0 ? { fields } : {}),
  });
}

/** The issue numbers a pull request body says it closes, in the order it says them. */
function closedIssueNumbers(body: string | null): number[] {
  if (body === null) {
    return [];
  }
  const text = body.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '');
  const numbers = new Set<number>();
  for (const match of text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/gi)) {
    numbers.add(Number(match[1]));
  }
  return [...numbers].slice(0, LISTED_CLOSED_ISSUES);
}

function formatPullRequestEvent(event: PullRequestEvent): DiscordWebhookPayload {
  const { pullRequest: pr } = event;
  const merged = event.type === REPO_EVENT_TYPES.PULL_REQUEST_MERGED;
  const closed = event.type === REPO_EVENT_TYPES.PULL_REQUEST_CLOSED;
  const opened = event.type === REPO_EVENT_TYPES.PULL_REQUEST_OPENED;
  const [verb, color] = merged
    ? ['🔀 Merged', COLORS.merged]
    : closed
      ? ['❌ Closed', COLORS.closed]
      : event.type === REPO_EVENT_TYPES.PULL_REQUEST_REOPENED
        ? ['🔄 Reopened', COLORS.open]
        : event.type === REPO_EVENT_TYPES.PULL_REQUEST_READY_FOR_REVIEW
          ? ['👀 Ready for review', COLORS.open]
          : event.type === REPO_EVENT_TYPES.PULL_REQUEST_CONVERTED_TO_DRAFT
            ? ['📝 Converted to draft', COLORS.draft]
            : pr.draft
              ? ['📝 Opened draft', COLORS.draft]
              : ['📥 Opened', COLORS.open];

  // On a merge or a close, the sender is whoever acted: the author is a separate fact.
  const author =
    (merged || closed) &&
    pr.author !== undefined &&
    pr.author.toLowerCase() !== event.sender.login.toLowerCase()
      ? `by ${pr.author}`
      : null;
  const changes =
    pr.additions !== undefined && pr.deletions !== undefined
      ? `+${String(pr.additions)} −${String(pr.deletions)}${pr.changedFiles === undefined ? '' : ` in ${plural(pr.changedFiles, 'file')}`}`
      : null;
  const taken = merged || closed ? durationBetween(pr.createdAt, event.occurredAt) : null;
  const closes = merged ? closedIssueNumbers(pr.body) : [];
  const facts = factsLine([
    opened ? associationLabel(event, pr.authorAssociation) : null,
    author,
    changes,
    merged && pr.commits !== undefined ? plural(pr.commits, 'commit') : null,
    taken !== null ? `${merged ? 'merged' : 'closed'} ${taken} after opening` : null,
    closes.length > 0 ? `closes ${closes.map((number) => `#${String(number)}`).join(', ')}` : null,
  ]);

  const description = [facts, opened ? bodyExcerpt(event, pr.body) : null].filter(
    (part) => part !== null
  );
  return createEmbed(
    event,
    {
      title: `${verb} PR #${String(pr.number)}: ${pr.title}`,
      url: pr.url,
      ...(description.length > 0 ? { description: description.join('\n\n') } : {}),
      color,
    },
    // The branch decides little for routine traffic; an outsider's change is worth it.
    event.silent === true ? {} : { footer: `${pr.headBranch} → ${pr.baseBranch}` }
  );
}

function formatForkEvent(event: ForkEvent): DiscordWebhookPayload {
  const { fork } = event;
  return createEmbed(event, {
    title: '🍴 New fork',
    url: fork.url,
    description: `${senderLink(event)} forked this repository → [${fork.fullName}](${fork.url})\n🍴 **${String(event.repository.forks)}** total`,
    color: COLORS.fork,
  });
}

function formatPushEvent(event: PushEvent): DiscordWebhookPayload {
  const { push } = event;
  const count = push.commits.length;
  const listed = push.commits.slice(-LISTED_COMMITS);
  // The author is the sender on nearly every push, and the sender is already above the title.
  const lines = listed.map(
    (commit) =>
      `[\`${commit.id.slice(0, 7)}\`](${commit.url}) ${truncate(commit.message, COMMIT_SUBJECT_LIMIT)}${commit.author.toLowerCase() === event.sender.login.toLowerCase() ? '' : ` — ${commit.author}`}`
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

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1)} ${units[unit] ?? 'B'}`;
}

function formatReleaseEvent(event: ReleaseEvent): DiscordWebhookPayload {
  const { release } = event;
  const name = release.name ?? release.tagName;
  // Notes are the point of a release even when a bot published it. A heading that only
  // restates the name or the repository, like a download table's, says nothing.
  const notes = excerpt(release.body, {
    limit: RELEASE_NOTES_LIMIT,
    dropHeadingsContaining: [
      name,
      release.tagName,
      release.tagName.replace(/^v/i, ''),
      event.repository.name,
    ]
      .map((needle) => needle.toLowerCase())
      .filter((needle) => needle.length >= 3),
    // GitHub's own text about verifying a release, appended to its notes.
    dropSectionsContaining: ['attestation'],
  });
  const facts = factsLine([
    name !== release.tagName ? `tag \`${release.tagName}\`` : null,
    release.assetCount !== undefined && release.assetCount > 0
      ? `${plural(release.assetCount, 'asset')}${release.assetBytes === undefined || release.assetBytes === 0 ? '' : ` · ${formatBytes(release.assetBytes)}`}`
      : null,
  ]);
  const description = [facts, notes].filter((part) => part !== null);

  return createEmbed(event, {
    title: `${release.prerelease ? '🧪 Pre-release' : '🚀 Released'} ${name}`,
    url: release.url,
    ...(description.length > 0 ? { description: description.join('\n\n') } : {}),
    color: release.prerelease ? COLORS.prerelease : COLORS.release,
  });
}

function threadName(thread: Thread): string {
  return `${thread.kind === 'pull_request' ? 'PR' : 'issue'} #${String(thread.number)}: ${thread.title}`;
}

function formatCommentEvent(event: CommentEvent): DiscordWebhookPayload {
  const description = bodyExcerpt(event, event.comment.body);
  return createEmbed(event, {
    title: `💬 Comment on ${threadName(event.thread)}`,
    url: event.comment.url,
    ...(description !== null ? { description } : {}),
    color: COLORS.comment,
  });
}

function formatReviewEvent(event: ReviewEvent): DiscordWebhookPayload {
  const { review } = event;
  const [title, color] =
    review.state === REVIEW_STATES.APPROVED
      ? ['👍 Approved', COLORS.open]
      : review.state === REVIEW_STATES.CHANGES_REQUESTED
        ? ['🛑 Changes requested on', COLORS.closed]
        : ['🗒️ Reviewed', COLORS.comment];
  const description = bodyExcerpt(event, review.body);
  return createEmbed(event, {
    title: `${title} ${threadName(event.thread)}`,
    url: review.url,
    ...(description !== null ? { description } : {}),
    color,
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
    case REPO_EVENT_TYPES.PULL_REQUEST_READY_FOR_REVIEW:
    case REPO_EVENT_TYPES.PULL_REQUEST_CONVERTED_TO_DRAFT:
      return formatPullRequestEvent(event);

    case REPO_EVENT_TYPES.COMMENT_CREATED:
      return formatCommentEvent(event);

    case REPO_EVENT_TYPES.REVIEW_SUBMITTED:
      return formatReviewEvent(event);

    case REPO_EVENT_TYPES.FORK_CREATED:
      return formatForkEvent(event);

    case REPO_EVENT_TYPES.PUSH_DEFAULT_BRANCH:
      return formatPushEvent(event);

    case REPO_EVENT_TYPES.RELEASE_PUBLISHED:
      return formatReleaseEvent(event);
  }
}

/** One action taken from an alert, as a line in its message. Mentions in embeds do not ping. */
function issueActionLine(outcome: IssueActionOutcome): string {
  const user = `<@${outcome.discordUserId}>`;
  if (!outcome.succeeded) {
    return `⚠️ ${outcome.action === 'close' ? 'Closing' : 'Labeling'} failed for ${user}`;
  }
  return outcome.action === 'close'
    ? `✅ Closed by ${user}`
    : `🏷️ Labeled ${outcome.detail} by ${user}`;
}

/**
 * An issue-opened alert with Close and Label buttons, listing the actions taken so
 * far; Close is disabled once it worked. Any other event, or a delivery id that cannot
 * go in a custom id, is formatted as `formatDiscordEmbed` does.
 */
export function formatDiscordEmbedWithActions(
  event: RepoEvent,
  deliveryId: string,
  outcomes: readonly IssueActionOutcome[] = []
): DiscordWebhookPayload {
  const payload = formatDiscordEmbed(event);
  const closeId = issueActionCustomId('close', deliveryId);
  const labelId = issueActionCustomId('label', deliveryId);
  if (event.type !== REPO_EVENT_TYPES.ISSUE_OPENED || closeId === null || labelId === null) {
    return payload;
  }

  const [embed] = payload.embeds;
  if (embed !== undefined && outcomes.length > 0) {
    embed.fields = [
      ...(embed.fields ?? []),
      {
        name: 'Actions',
        value: truncate(outcomes.map(issueActionLine).join('\n'), FIELD_VALUE_LIMIT),
      },
    ];
  }
  const closed = outcomes.some((outcome) => outcome.action === 'close' && outcome.succeeded);
  payload.components = [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 4,
          label: 'Close',
          custom_id: closeId,
          ...(closed ? { disabled: true } : {}),
        },
        { type: 2, style: 2, label: 'Label…', custom_id: labelId },
      ],
    },
  ];
  return payload;
}

function releasedSummary(releases: RepositoryActivity['releases']): string {
  const listed = releases
    .slice(-LISTED_RELEASES)
    .map((release) => `[${release.tagName}](${release.url})`);
  const earlier = releases.length - listed.length;
  return `released ${listed.join(', ')}${earlier > 0 ? ` and ${String(earlier)} more` : ''}`;
}

function activitySummary(activity: RepositoryActivity): string {
  const merged = activity.pullRequestsMerged;
  const mergedByBots = merged.filter((pr) => pr.byBot).length;
  const items = [
    activity.starsGained !== 0
      ? `⭐ ${activity.starsGained > 0 ? '+' : ''}${String(activity.starsGained)}`
      : null,
    activity.commits > 0 ? plural(activity.commits, 'commit') : null,
    merged.length > 0
      ? `${plural(merged.length, 'PR')} merged${mergedByBots > 0 ? ` (${String(mergedByBots)} by bots)` : ''}`
      : null,
    activity.pullRequestsOpened > 0
      ? `${plural(activity.pullRequestsOpened, 'PR')} opened${activity.pullRequestsOpenedByBots > 0 ? ` (${String(activity.pullRequestsOpenedByBots)} by bots)` : ''}`
      : null,
    activity.issuesOpened > 0 ? `${plural(activity.issuesOpened, 'issue')} opened` : null,
    activity.issuesClosed > 0 ? `${plural(activity.issuesClosed, 'issue')} closed` : null,
    activity.forks > 0 ? plural(activity.forks, 'fork') : null,
    activity.releases.length > 0 ? releasedSummary(activity.releases) : null,
  ].filter((item) => item !== null);

  return items.length > 0 ? items.join(' · ') : 'no net change';
}

/**
 * The latest merged pull requests that people opened, one line each. Bots' are counted in
 * the summary line and not listed: a dependency update says nothing a count does not.
 */
function mergedPullRequestLines(merged: RepositoryActivity['pullRequestsMerged']): string[] {
  const byPeople = merged.filter((pr) => !pr.byBot);
  const listed = byPeople.slice(-LISTED_PULL_REQUESTS);
  const lines = listed.map(
    (pr) => `↳ [#${String(pr.number)}](${pr.url}) ${truncate(pr.title, COMMIT_SUBJECT_LIMIT)}`
  );
  if (byPeople.length > listed.length) {
    lines.push(`↳ _…and ${plural(byPeople.length - listed.length, 'earlier PR')}_`);
  }
  return lines;
}

/** Repositories with the most commits since their latest release, as one embed field. */
function unreleasedField(
  unreleased: readonly UnreleasedWork[],
  asOf: Date
): NonNullable<DiscordEmbed['fields']> {
  const lines: string[] = [];
  let length = 0;
  const mostAhead = [...unreleased]
    .sort((left, right) => right.commitsSinceRelease - left.commitsSinceRelease)
    .slice(0, LISTED_UNRELEASED);
  for (const work of mostAhead) {
    const line = `[${work.repository}](${work.compareUrl}) ${plural(work.commitsSinceRelease, 'commit')} since ${work.tagName}, ${formatDuration(asOf.getTime() - work.releasedAt.getTime())} ago`;
    if (length + line.length + 1 > FIELD_VALUE_LIMIT) {
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }

  return lines.length > 0 ? [{ name: '🚢 Not released yet', value: lines.join('\n') }] : [];
}

/** The week's most active outside people, as one embed field. */
function peopleField(people: readonly PersonActivity[]): NonNullable<DiscordEmbed['fields']> {
  const lines = people.map(
    (person) =>
      `${person.isNew ? '🆕 ' : ''}[${person.login}](${person.url}) ${plural(person.events, 'event')} in ${plural(person.repositories, 'repo')}`
  );
  return lines.length > 0
    ? [{ name: "👥 Who's showing up", value: truncate(lines.join('\n'), FIELD_VALUE_LIMIT) }]
    : [];
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
 * As many of `lines` as fit in `limit` characters, one per line, then `more(n)` for the
 * `n` of `total` left out. Each line is kept only if the "more" line for those after it
 * would still fit, so the result never exceeds `limit`.
 */
function fitLines(
  lines: readonly string[],
  total: number,
  limit: number,
  more: (omitted: number) => string
): string {
  const kept: string[] = [];
  let length = 0;
  for (const [index, line] of lines.entries()) {
    const after = total - index - 1;
    const separator = kept.length > 0 ? 1 : 0;
    const reserve = after > 0 ? more(after).length + 1 : 0;
    if (length + separator + line.length + reserve > limit) {
      break;
    }
    kept.push(line);
    length += separator + line.length;
  }
  if (kept.length < total) {
    kept.push(more(total - kept.length));
  }
  return kept.join('\n');
}

/** Open threads where an outside person waits, oldest wait first, as one embed field. */
function waitingField(
  waiting: readonly WaitingThread[],
  asOf: Date
): NonNullable<DiscordEmbed['fields']> {
  if (waiting.length === 0) {
    return [];
  }
  const lines = waiting
    .slice(0, LISTED_WAITING)
    .map(
      (thread) =>
        `[${thread.repository}#${String(thread.number)}](${thread.url}) ${truncate(thread.title, COMMIT_SUBJECT_LIMIT)} · @${thread.login} · ${formatDuration(asOf.getTime() - thread.since.getTime())}`
    );
  return [
    {
      name: '⏳ Waiting on you',
      value: fitLines(
        lines,
        waiting.length,
        FIELD_VALUE_LIMIT,
        (omitted) => `…and ${String(omitted)} more`
      ),
    },
  ];
}

/** The window's median merge and first-reply times, as one embed field. */
function responseTimesField(times: ResponseTimes | null): NonNullable<DiscordEmbed['fields']> {
  const parts = [
    times?.merge
      ? `Merge: ${formatDuration(times.merge.medianMs, true)} median (${plural(times.merge.count, 'PR')})`
      : null,
    times?.firstReply
      ? `First reply: ${formatDuration(times.firstReply.medianMs, true)} median (${plural(times.firstReply.count, 'thread')})`
      : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? [{ name: '⏱️ Response times', value: parts.join(' · ') }] : [];
}

/** A local date, `YYYY-MM-DD`, as `Tue 3 Nov`. */
function formatDigestDate(date: string): string {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function shiftDate(date: string, days: number): string {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The digest's date, or for a weekly digest the days it covers. */
function digestDateLabel(digest: Digest): string {
  return digest.period === 'weekly'
    ? `${formatDigestDate(shiftDate(digest.date, -7))} to ${formatDigestDate(shiftDate(digest.date, -1))}`
    : formatDigestDate(digest.date);
}

/** What a person would act on, from the data the digest already has. */
function digestHeadline(digest: Digest): string | null {
  const stars = digest.repositories.reduce((sum, activity) => sum + activity.starsGained, 0);
  const forks = digest.repositories.reduce((sum, activity) => sum + activity.forks, 0);
  const issues = digest.repositories.reduce((sum, activity) => sum + activity.issuesOpened, 0);
  const releases = digest.repositories.reduce((sum, activity) => sum + activity.releases.length, 0);
  return factsLine([
    stars > 0 ? plural(stars, 'new star') : stars < 0 ? `${plural(-stars, 'star')} removed` : null,
    forks > 0 ? plural(forks, 'fork') : null,
    issues > 0 ? `${plural(issues, 'issue')} opened` : null,
    releases > 0 ? plural(releases, 'release') : null,
    digest.unreleased.length > 0
      ? `${plural(digest.unreleased.length, 'repo')} with unreleased work`
      : null,
  ]);
}

/**
 * Format a digest as one embed with a line per repository, most active first, under a
 * line of what a person would act on. Pull requests that bots opened are counted and
 * not listed. The waiting list and response times are laid out first; the repository
 * lines get what is left of Discord's limit on an embed's total text.
 */
export function formatDiscordDigest(digest: Digest): DiscordWebhookPayload {
  const fields = [
    ...waitingField(digest.waiting, digest.windowEnd),
    ...responseTimesField(digest.responseTimes),
    ...unreleasedField(digest.unreleased, digest.windowEnd),
    ...peopleField(digest.people),
  ];
  const title = `${digest.period === 'weekly' ? '📦 Weekly pulse' : '📊 Daily pulse'} · ${digestDateLabel(digest)}`;
  const footer = `${formatDigestTime(digest.windowStart, digest.timeZone)} to ${formatDigestTime(digest.windowEnd, digest.timeZone)} · ${digest.timeZone}`;
  const used =
    title.length +
    footer.length +
    DIGEST_AUTHOR.length +
    fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  const blocks = digest.repositories.map((activity) =>
    [
      `**[${activity.repository}](${activity.url})** ${activitySummary(activity)}`,
      ...mergedPullRequestLines(activity.pullRequestsMerged),
    ].join('\n')
  );
  const headline = digest.eventCount > 0 ? digestHeadline(digest) : 'No new events';
  const room = Math.min(DESCRIPTION_LIMIT, EMBED_TOTAL_LIMIT - used);
  const repositoryLines =
    blocks.length > 0
      ? fitLines(
          blocks,
          blocks.length,
          room - (headline === null ? 0 : headline.length + 2),
          (omitted) => `_…and ${repositories(omitted)} more_`
        )
      : '';
  const description = [headline, repositoryLines]
    .filter((part) => part !== null && part !== '')
    .join('\n\n');

  return {
    embeds: [
      {
        title,
        ...(description !== '' ? { description } : {}),
        color: COLORS.push,
        timestamp: digest.windowEnd.toISOString(),
        ...(fields.length > 0 ? { fields } : {}),
        footer: { text: footer },
        author: { name: DIGEST_AUTHOR },
      },
    ],
  };
}

/** What a window of the same length usually gets, in words that carry their unit. */
function usualStars(expectedStars: number, windowHours: number): string {
  const per = `per ${plural(windowHours, 'hour')}`;
  if (expectedStars < 0.05) {
    return 'usually almost none';
  }
  return expectedStars < 1
    ? `usually under 1 ${per}`
    : `usually about ${expectedStars.toFixed(1)} ${per}`;
}

/**
 * Format a momentum alert: how fast stars are coming in, who starred, and where
 * visitors came from. The referrers are GitHub's 14-day totals, not the spike's.
 */
export function formatDiscordAlert(alert: MomentumAlert): DiscordWebhookPayload {
  const fields: NonNullable<DiscordEmbed['fields']> = [];
  if (alert.latestStargazers.length > 0) {
    const more = alert.recentStars - alert.latestStargazers.length;
    fields.push({
      name: 'Latest stars',
      value: truncate(
        `${alert.latestStargazers.map((stargazer) => `[${stargazer.login}](${stargazer.url})`).join(', ')}${more > 0 ? ` and ${String(more)} more` : ''}`,
        FIELD_VALUE_LIMIT
      ),
    });
  }
  if (alert.notableStargazers.length > 0) {
    fields.push({
      name: 'Notable stargazers',
      value: alert.notableStargazers
        .map(
          (stargazer) =>
            `[${stargazer.login}](${stargazer.url}) · ${plural(stargazer.followers, 'follower')}`
        )
        .join('\n'),
    });
  }
  if (alert.referrers.length > 0) {
    fields.push({
      name: 'Where visitors came from (14 days)',
      value: alert.referrers
        .map(
          (referrer) =>
            `${referrer.name} · ${plural(referrer.views, 'view')} from ${plural(referrer.uniqueVisitors, 'visitor')}`
        )
        .join('\n'),
    });
  }

  return {
    embeds: [
      {
        title: truncate(`📈 ${alert.repository} is taking off`, TITLE_LIMIT),
        url: alert.url,
        description: `**${plural(alert.recentStars, 'star')}** in ${plural(alert.windowHours, 'hour')} (${usualStars(alert.expectedStars, alert.windowHours)}). ${plural(alert.totalStars, 'star')} in total.`,
        color: COLORS.star,
        timestamp: alert.detectedAt.toISOString(),
        ...(fields.length > 0 ? { fields } : {}),
        author: { name: DIGEST_AUTHOR },
      },
    ],
  };
}
