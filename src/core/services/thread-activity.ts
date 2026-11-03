import type { ResponseTimes, WaitingThread } from '../models/digest.js';
import type { RepoEvent } from '../models/repo-event.js';
import { REPO_EVENT_TYPES, REVIEW_STATES } from '../models/repo-event.js';
import type { ThreadActivityMaterial, ThreadEventRow } from './d1-event-history.js';
import { conversationSide } from './people.js';

/**
 * Whether a review says something: an approval, a change request, or a comment review
 * with a body. A `commented` review without a body is the shell GitHub submits around
 * inline comments, and other states are not ones GitHub sends on submission.
 */
function isSubstantiveReview(state: string | null, hasBody: boolean): boolean {
  return (
    state === REVIEW_STATES.APPROVED ||
    state === REVIEW_STATES.CHANGES_REQUESTED ||
    (state === REVIEW_STATES.COMMENTED && hasBody)
  );
}

/**
 * Whether an accepted event gets an alert. Comments and reviews alert only from outside
 * people, and reviews only when substantive; draft changes never alert. Every other
 * event alerts, as before. Decided once, at acceptance, and stored with the event.
 */
export function shouldAlert(event: RepoEvent, ignoredLogins: ReadonlySet<string>): boolean {
  switch (event.type) {
    case REPO_EVENT_TYPES.COMMENT_CREATED:
      return conversationSide(event.sender, event.repository.owner, ignoredLogins) === 'outside';
    case REPO_EVENT_TYPES.REVIEW_SUBMITTED:
      return (
        conversationSide(event.sender, event.repository.owner, ignoredLogins) === 'outside' &&
        isSubstantiveReview(event.review.state, event.review.body !== null)
      );
    case REPO_EVENT_TYPES.PULL_REQUEST_READY_FOR_REVIEW:
    case REPO_EVENT_TYPES.PULL_REQUEST_CONVERTED_TO_DRAFT:
      return false;
    default:
      return true;
  }
}

/** One stored event of a thread, with its times in milliseconds. */
interface ThreadStep {
  row: ThreadEventRow;
  /** GitHub's time, or null when the event has none. */
  occurredAt: number | null;
  /** GitHub's time, or else receipt time, which is never earlier: the sort key. */
  at: number;
  receivedAt: number;
  side: 'owner' | 'outside' | null;
}

const OPENED_TYPES: ReadonlySet<string> = new Set([
  REPO_EVENT_TYPES.ISSUE_OPENED,
  REPO_EVENT_TYPES.PULL_REQUEST_OPENED,
]);
const REOPENED_TYPES: ReadonlySet<string> = new Set([
  REPO_EVENT_TYPES.ISSUE_REOPENED,
  REPO_EVENT_TYPES.PULL_REQUEST_REOPENED,
]);
const ENDING_TYPES: ReadonlySet<string> = new Set([
  REPO_EVENT_TYPES.ISSUE_CLOSED,
  REPO_EVENT_TYPES.PULL_REQUEST_CLOSED,
  REPO_EVENT_TYPES.PULL_REQUEST_MERGED,
]);

/** A comment, or a substantive review. */
function isMessage(step: ThreadStep): boolean {
  const { eventType, reviewState, hasBody } = step.row;
  return (
    eventType === REPO_EVENT_TYPES.COMMENT_CREATED ||
    (eventType === REPO_EVENT_TYPES.REVIEW_SUBMITTED &&
      isSubstantiveReview(reviewState, hasBody === 1))
  );
}

/** An answer from the owner's side: a comment or a substantive review. */
function isOwnerReply(step: ThreadStep): boolean {
  return step.side === 'owner' && isMessage(step);
}

/**
 * What makes the owner's side owe an answer: an outside person opening or reopening
 * the thread, commenting, or reviewing with a change request or a comment. An approval
 * asks for nothing.
 */
function isOutsideRequest(step: ThreadStep): boolean {
  if (step.side !== 'outside') {
    return false;
  }
  const { eventType, reviewState } = step.row;
  if (OPENED_TYPES.has(eventType) || REOPENED_TYPES.has(eventType)) {
    return true;
  }
  return isMessage(step) && reviewState !== REVIEW_STATES.APPROVED;
}

function parseTime(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * Oldest first by GitHub's time, then by receipt and delivery id. GitHub's times have
 * whole seconds, so two events in the same second keep their arrival order.
 */
function compareSteps(left: ThreadStep, right: ThreadStep): number {
  return (
    left.at - right.at ||
    left.receivedAt - right.receivedAt ||
    (left.row.deliveryId < right.row.deliveryId ? -1 : 1)
  );
}

interface ThreadSummary {
  waiting: WaitingThread | null;
  /** Milliseconds from the first outside request to the first answer, if in the window. */
  firstReplyMs: number | null;
  /** Milliseconds from creation to merge, if merged in the window. */
  mergeMs: number | null;
  /** Whether the waiting list and first reply had to leave the thread out. */
  untimed: boolean;
}

/**
 * One thread's wait and durations. Ordering needs GitHub's times. An event without one
 * received before activation happened before it too, as receipt never precedes
 * occurrence, so its receipt time orders it among what came before activation, which
 * no wait or first reply counts from. One received since could have happened at any
 * time before its receipt, so the thread's wait and first reply are left out rather
 * than guessed. Merge time needs GitHub's merge time; its start may fall back to a
 * stored opened event's receipt time, for pull requests recorded before creation times.
 */
function summarizeThread(
  rows: readonly ThreadEventRow[],
  activatedAt: number | null,
  window: { start: number; end: number },
  ignoredLogins: ReadonlySet<string>
): ThreadSummary {
  const steps = rows
    .flatMap((row): ThreadStep[] => {
      const receivedAt = parseTime(row.receivedAt);
      if (receivedAt === null) {
        return [];
      }
      const occurredAt = parseTime(row.occurredAt);
      return [
        {
          row,
          occurredAt,
          at: occurredAt ?? receivedAt,
          receivedAt,
          side: conversationSide(
            { id: row.senderId, login: row.senderLogin },
            row.repositoryOwner,
            ignoredLogins
          ),
        },
      ];
    })
    .sort(compareSteps);
  const inWindow = (time: number): boolean => time >= window.start && time < window.end;
  const untimed =
    activatedAt !== null &&
    steps.some((step) => step.occurredAt === null && step.receivedAt >= activatedAt);
  const tracksReplies = activatedAt !== null && !untimed;

  let state: string | null = null;
  let draft: boolean | null = null;
  let isPullRequest = false;
  let createdAt: number | null = null;
  let openedAt: number | null = null;
  let mergedAt: number | null = null;
  // The outside request the owner's side has not answered, nor closed, since.
  let pending: ThreadStep | null = null;
  // The thread's first outside request, and the first answer after it.
  let firstRequest: ThreadStep | null = null;
  let firstReplyAt: number | null = null;

  for (const step of steps) {
    const { row } = step;
    state = row.state ?? state;
    draft = row.draft === null ? draft : row.draft === 1;
    isPullRequest ||= row.kind === 'pull_request';
    createdAt ??= parseTime(row.createdAt);
    if (OPENED_TYPES.has(row.eventType)) {
      openedAt ??= step.at;
    }
    if (row.eventType === REPO_EVENT_TYPES.PULL_REQUEST_MERGED) {
      mergedAt ??= step.occurredAt;
    }
    if (!tracksReplies) {
      continue;
    }

    if (isOwnerReply(step)) {
      pending = null;
      if (firstRequest !== null && firstReplyAt === null) {
        firstReplyAt = step.at;
      }
    } else if (ENDING_TYPES.has(row.eventType)) {
      // Closing or merging ends the wait, but it is not an answer.
      pending = null;
    } else if (step.at >= activatedAt && isOutsideRequest(step)) {
      pending ??= step;
      firstRequest ??= step;
    }
  }

  const latest = steps.at(-1);
  const isWaiting =
    pending !== null &&
    latest !== undefined &&
    state === 'open' &&
    (!isPullRequest || draft === false) &&
    latest.row.title !== null &&
    latest.row.url !== null &&
    pending.row.senderLogin !== null;

  const startedAt = createdAt ?? openedAt;
  return {
    waiting: isWaiting
      ? {
          repository: latest.row.repository,
          number: latest.row.number,
          title: latest.row.title ?? '',
          url: latest.row.url ?? '',
          login: pending?.row.senderLogin ?? '',
          since: new Date(pending?.at ?? 0),
        }
      : null,
    firstReplyMs:
      firstRequest !== null &&
      firstReplyAt !== null &&
      createdAt !== null &&
      createdAt >= (activatedAt ?? Infinity) &&
      inWindow(firstReplyAt)
        ? firstReplyAt - firstRequest.at
        : null,
    mergeMs:
      mergedAt !== null && startedAt !== null && inWindow(mergedAt) && mergedAt >= startedAt
        ? mergedAt - startedAt
        : null,
    untimed,
  };
}

function median(values: readonly number[]): { medianMs: number; count: number } | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return { medianMs, count: sorted.length };
}

export interface ThreadActivitySummary {
  /** Oldest wait first. */
  waiting: WaitingThread[];
  responseTimes: ResponseTimes;
  /** Threads left out because the read did not return all their events. */
  incompleteThreads: number;
  /**
   * Threads left out of the waiting list and first replies because an event received
   * since activation has no GitHub time.
   */
  untimedThreads: number;
}

/**
 * Who is waiting on the owner's side, and the window's merge and first-reply times,
 * from the stored events of recently active threads.
 *
 * A thread waits when it is open, not a draft pull request, and an outside request
 * (see `isOutsideRequest`) came after the owner's side last answered and after it was
 * last closed. Labels are not answers. Only requests at or after the activation instant
 * count: comments were not recorded before it, so an earlier answer cannot be known.
 * A thread whose open state or draft state no stored event shows does not wait. Before
 * activation, nothing waits and there are no first replies.
 *
 * Merge time runs from the pull request's creation, or its stored opened event, to its
 * merge on GitHub, and does not depend on activation. First-reply time runs from a
 * thread's first outside request to the first answer after it, closed and reopened in
 * between or not, for threads created at or after activation. Both count in the window
 * when the merge or answer happened on GitHub. See `summarizeThread` for events without
 * GitHub's time.
 */
export function summarizeThreadActivity(
  material: ThreadActivityMaterial,
  window: { start: Date; end: Date },
  ignoredLogins: ReadonlySet<string>
): ThreadActivitySummary {
  const activatedAt = parseTime(material.activatedAt);
  const threads = new Map<string, ThreadEventRow[]>();
  for (const row of material.rows) {
    const key = `${String(row.repositoryId)}#${String(row.number)}`;
    const rows = threads.get(key) ?? [];
    threads.set(key, rows);
    rows.push(row);
  }

  const bounds = { start: window.start.getTime(), end: window.end.getTime() };
  const waiting: WaitingThread[] = [];
  const firstReplies: number[] = [];
  const merges: number[] = [];
  let incompleteThreads = 0;
  let untimedThreads = 0;
  for (const rows of threads.values()) {
    const threadEvents = rows[0]?.threadEvents ?? null;
    if (threadEvents === null || rows.length < threadEvents) {
      incompleteThreads += 1;
      continue;
    }
    const summary = summarizeThread(rows, activatedAt, bounds, ignoredLogins);
    if (summary.untimed) {
      untimedThreads += 1;
    }
    if (summary.waiting !== null) {
      waiting.push(summary.waiting);
    }
    if (summary.firstReplyMs !== null) {
      firstReplies.push(summary.firstReplyMs);
    }
    if (summary.mergeMs !== null) {
      merges.push(summary.mergeMs);
    }
  }

  waiting.sort(
    (left, right) =>
      left.since.getTime() - right.since.getTime() ||
      left.repository.localeCompare(right.repository) ||
      left.number - right.number
  );
  return {
    waiting,
    responseTimes: { merge: median(merges), firstReply: median(firstReplies) },
    incompleteThreads,
    untimedThreads,
  };
}
