import type { IssueActionOutcome } from '../../core/models/issue-action.js';
import { REPO_EVENT_TYPES } from '../../core/models/repo-event.js';
import {
  boundedMessage,
  type Redactor,
  transportFailure,
  upstreamFailure,
} from '../../core/security/redact.js';
import type { D1DiscordActions } from '../../core/services/d1-discord-actions.js';
import type { D1EventHistory } from '../../core/services/d1-event-history.js';
import { logger } from '../../core/services/logger.js';
import type { GitHubIssueActions, IssueWriteResult } from '../github/issue-actions.js';
import { formatDiscordEmbedWithActions } from './embed-formatter.js';

const DISCORD_API_URL = 'https://discord.com/api/v10';
/** Short, so the receipt and the edit fit in the time Workers give `waitUntil`. */
const REQUEST_TIMEOUT_MS = 5_000;
/** Discord's ephemeral flag: only the clicker sees the receipt. */
const EPHEMERAL = 64;

export interface IssueActionRequest {
  interactionId: string;
  /** Valid for 15 minutes; it is a credential, so it is never logged. */
  interactionToken: string;
  applicationId: string;
  userId: string;
  /** The alert's message, edited afterwards when known. */
  messageId: string | undefined;
  deliveryId: string;
  action: { kind: 'close' } | { kind: 'label'; labels: readonly string[] };
}

interface IssueActionDependencies {
  actionLog: D1DiscordActions;
  eventHistory: Pick<D1EventHistory, 'findEvent'>;
  issues: GitHubIssueActions;
  /** The application-owned webhook that posted the alert, and edits it. */
  webhookUrl: string;
  redactor: Redactor;
}

/** The receipt for one attempt, sent to the clicker only. */
function receipt(outcome: IssueActionOutcome, issueNumber: number): string {
  const issue = `issue #${String(issueNumber)}`;
  if (!outcome.succeeded) {
    return `❌ Could not ${outcome.action} ${issue}: ${outcome.detail}`;
  }
  return outcome.action === 'close'
    ? `✅ Closed ${issue}`
    : `🏷️ Labeled ${issue}: ${outcome.detail}`;
}

/**
 * Send a request to Discord. Returns null on success, else a fixed or redacted
 * description: the URLs carry the interaction token or the webhook's.
 */
async function discordRequest(
  label: string,
  url: string,
  method: 'PATCH' | 'POST',
  body: unknown,
  redactor: Redactor
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return transportFailure(label, error);
  }
  if (response.ok) {
    return null;
  }
  const text = await response.text().catch(() => '');
  return upstreamFailure(label, response.status, text, redactor);
}

/**
 * The work after the immediate response: take up the interaction once, find the
 * issue in the stored event, write to GitHub, record the outcome, send the receipt,
 * then edit the alert. Never rejects. A replayed interaction does nothing; any other
 * failure ends in a receipt, except one that stops Discord from taking it.
 */
export async function runIssueAction(
  deps: IssueActionDependencies,
  request: IssueActionRequest
): Promise<void> {
  const logFields = {
    component: 'discord_actions',
    deliveryId: request.deliveryId,
    interactionId: request.interactionId,
    action: request.action.kind,
  };
  const sendReceipt = async (content: string): Promise<void> => {
    const error = await discordRequest(
      'Discord receipt',
      `${DISCORD_API_URL}/webhooks/${request.applicationId}/${request.interactionToken}`,
      'POST',
      { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } },
      deps.redactor
    );
    if (error !== null) {
      logger.warn('discord_action.receipt_failed', { ...logFields, error });
    }
  };

  let event: Awaited<ReturnType<IssueActionDependencies['eventHistory']['findEvent']>>;
  try {
    if (!(await deps.actionLog.takeInteraction(request.interactionId, new Date()))) {
      logger.info('discord_action.replayed', logFields);
      return;
    }
    event = await deps.eventHistory.findEvent(request.deliveryId);
  } catch (error) {
    logger.error('discord_action.failed', {
      ...logFields,
      error: boundedMessage(error instanceof Error ? error.message : String(error), deps.redactor),
    });
    await sendReceipt('❌ Something went wrong before GitHub was asked; nothing changed.');
    return;
  }
  if (event?.type !== REPO_EVENT_TYPES.ISSUE_OPENED) {
    await sendReceipt('Nothing done: this is not an issue alert.');
    return;
  }

  const { action } = request;
  const result: IssueWriteResult =
    action.kind === 'close'
      ? await deps.issues.close(event.repository, event.issue.number)
      : await deps.issues.addLabels(event.repository, event.issue.number, action.labels);
  const outcome: IssueActionOutcome = {
    action: action.kind,
    succeeded: result.ok,
    detail: result.ok ? (action.kind === 'label' ? action.labels.join(', ') : '') : result.error,
    discordUserId: request.userId,
  };
  if (!result.ok) {
    logger.warn('discord_action.github_failed', { ...logFields, error: result.error });
  }

  // D1 and the receipt are what count; the message edit after them is best effort.
  let outcomes: IssueActionOutcome[] | null = null;
  try {
    await deps.actionLog.recordOutcome(request.deliveryId, outcome, new Date());
    outcomes = await deps.actionLog.listOutcomes(request.deliveryId);
  } catch (error) {
    logger.error('discord_action.outcome_not_recorded', {
      ...logFields,
      error: boundedMessage(error instanceof Error ? error.message : String(error), deps.redactor),
    });
  }
  await sendReceipt(receipt(outcome, event.issue.number));

  if (outcomes === null || request.messageId === undefined) {
    return;
  }
  const { embeds, components } = formatDiscordEmbedWithActions(event, request.deliveryId, outcomes);
  const url = new URL(deps.webhookUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/messages/${request.messageId}`;
  url.searchParams.set('with_components', 'true');
  const error = await discordRequest(
    'Discord message edit',
    url.toString(),
    'PATCH',
    { embeds, components },
    deps.redactor
  );
  if (error !== null) {
    // Not retried: a later action rebuilds the message from every outcome.
    logger.warn('discord_action.edit_failed', { ...logFields, error });
  }
}
