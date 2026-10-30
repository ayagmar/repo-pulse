import { Hono } from 'hono';
import { D1DiscordActions } from '../../core/services/d1-discord-actions.js';
import { runIssueAction } from '../../providers/discord/interaction-actions.js';
import {
  deferredUpdate,
  ephemeralMessage,
  INTERACTION_MAX_BODY_BYTES,
  INTERACTION_TYPES,
  issueActionCustomId,
  labelModal,
  labelsFromModal,
  parseInteraction,
  parseIssueActionCustomId,
  pong,
  verifyInteractionSignature,
} from '../../providers/discord/interactions.js';
import { GitHubAppAuth } from '../../providers/github/app-auth.js';
import { GitHubIssueActions } from '../../providers/github/issue-actions.js';
import type { HttpEnv } from '../app-env.js';
import { readBodyWithLimit } from '../read-body.js';

/** Every request refused before it is known to come from Discord gets this same answer. */
const REJECTED = { error: 'invalid_request' } as const;
const UNKNOWN_BUTTON = 'This button is not one Repo Pulse knows.';

/**
 * Discord's interactions endpoint for the buttons on issue alerts. Unauthenticated, so
 * every gate runs before any D1 or GitHub work: the route is 404 unless
 * `DISCORD_ACTIONS` is on, then a rate limit, a body limit, Discord's Ed25519
 * signature with a five-minute timestamp window, the application id and the allow
 * list. Discord wants an answer within three seconds, so a click is acknowledged at
 * once and its GitHub write runs in `waitUntil`.
 */
export function createDiscordInteractionRoutes(): Hono<HttpEnv> {
  const router = new Hono<HttpEnv>();

  router.post('/interactions', async (c) => {
    const { config, redactor, eventHistory } = c.get('runtime');
    const actions = config.discord.actions;
    const app = config.github.app;
    const webhookUrl = config.discord.webhookUrl;
    // createConfig enables actions only with the App and the webhook configured.
    if (actions === undefined || app === undefined || webhookUrl === undefined) {
      return c.notFound();
    }

    // Per client and Cloudflare location, before any signature work.
    const { success } = await c.env.DISCORD_RATE_LIMIT.limit({
      key: c.req.header('CF-Connecting-IP') ?? 'unknown',
    });
    if (!success) {
      return c.json({ error: 'rate_limited' }, 429);
    }
    const body = await readBodyWithLimit(c.req.raw, INTERACTION_MAX_BODY_BYTES);
    if (body === null) {
      return c.json({ error: 'payload_too_large' }, 413);
    }
    const verified = await verifyInteractionSignature({
      publicKey: actions.publicKey,
      signature: c.req.header('X-Signature-Ed25519'),
      timestamp: c.req.header('X-Signature-Timestamp'),
      body,
      nowMs: Date.now(),
    });
    if (!verified) {
      return c.json(REJECTED, 401);
    }

    const interaction = parseInteraction(body);
    if (interaction === null) {
      return c.json(REJECTED, 400);
    }
    if (interaction.type === INTERACTION_TYPES.PING) {
      return c.json(pong());
    }
    if (interaction.applicationId !== actions.applicationId) {
      return c.json(REJECTED, 401);
    }
    redactor.add(interaction.token);
    const { userId } = interaction;
    if (userId === undefined || !actions.allowedUserIds.has(userId)) {
      return c.json(ephemeralMessage('You are not allowed to act on these alerts.'));
    }

    const target = parseIssueActionCustomId(interaction.customId);
    const expected =
      interaction.type === INTERACTION_TYPES.MESSAGE_COMPONENT
        ? ['close', 'label']
        : interaction.type === INTERACTION_TYPES.MODAL_SUBMIT
          ? ['labels']
          : [];
    if (target === null || !expected.includes(target.kind)) {
      return c.json(ephemeralMessage(UNKNOWN_BUTTON));
    }

    if (target.kind === 'label') {
      // The modal is built from the custom id alone; nothing is read before it.
      const modalId = issueActionCustomId('labels', target.deliveryId);
      return modalId === null
        ? c.json(ephemeralMessage(UNKNOWN_BUTTON))
        : c.json(labelModal(modalId));
    }

    let action: Parameters<typeof runIssueAction>[1]['action'];
    if (target.kind === 'close') {
      action = { kind: 'close' };
    } else {
      const labels = labelsFromModal(interaction);
      if (labels === null) {
        return c.json(
          ephemeralMessage(
            'Enter one to ten label names of up to 50 characters, separated by commas.'
          )
        );
      }
      action = { kind: 'label', labels };
    }

    const auth = new GitHubAppAuth(app, redactor);
    c.executionCtx.waitUntil(
      runIssueAction(
        {
          actionLog: new D1DiscordActions(c.env.DB),
          eventHistory,
          issues: new GitHubIssueActions((request) => auth.installationToken(request), redactor),
          webhookUrl,
          redactor,
        },
        {
          interactionId: interaction.id,
          interactionToken: interaction.token,
          applicationId: interaction.applicationId,
          userId,
          messageId: interaction.messageId,
          deliveryId: target.deliveryId,
          action,
        }
      )
    );
    return c.json(deferredUpdate());
  });

  return router;
}
