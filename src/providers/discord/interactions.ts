/**
 * Discord's interaction protocol for the buttons on issue alerts: request
 * verification, parsing, custom ids and the immediate responses.
 * https://discord.com/developers/docs/interactions/receiving-and-responding
 */

/** Discord's interactions are small; anything larger is not one. */
export const INTERACTION_MAX_BODY_BYTES = 64 * 1024;
/** A request signed further from now than this is refused, so a captured one expires. */
const TIMESTAMP_WINDOW_SECONDS = 5 * 60;

export const INTERACTION_TYPES = {
  PING: 1,
  MESSAGE_COMPONENT: 3,
  MODAL_SUBMIT: 5,
} as const;

const RESPONSE_TYPES = {
  PONG: 1,
  CHANNEL_MESSAGE: 4,
  DEFERRED_UPDATE_MESSAGE: 6,
  MODAL: 9,
} as const;

/** Only the user who clicked sees the message. */
const EPHEMERAL = 64;

const SNOWFLAKE = /^\d{1,20}$/;
/** Interaction tokens go into a URL path, so nothing but URL-safe characters. */
const INTERACTION_TOKEN = /^[A-Za-z0-9._-]{1,500}$/;
/** GitHub delivery ids are GUIDs. */
const DELIVERY_ID = /^[0-9a-f-]{36}$/;
const CUSTOM_ID = /^v1:(close|label|labels):([0-9a-f-]{36})$/;
/** Discord's limit on a custom id. */
const CUSTOM_ID_LIMIT = 100;

/** The text input in the label modal. */
const LABELS_INPUT = 'labels';
const LABELS_INPUT_LIMIT = 200;
/** GitHub's limit on a label name. */
const LABEL_NAME_LIMIT = 50;
const LABELS_PER_ACTION = 10;

/** What a custom id asks for: a button click, or the label modal's submission. */
type CustomIdKind = 'close' | 'label' | 'labels';

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Whether Discord signed this request: an Ed25519 signature over the timestamp
 * header followed by the raw body, with the timestamp in whole seconds within five
 * minutes of now.
 */
export async function verifyInteractionSignature(request: {
  publicKey: string;
  signature: string | undefined;
  timestamp: string | undefined;
  body: Uint8Array;
  nowMs: number;
}): Promise<boolean> {
  const { signature, timestamp } = request;
  if (
    signature === undefined ||
    !/^[0-9a-fA-F]{128}$/.test(signature) ||
    timestamp === undefined ||
    !/^\d{1,12}$/.test(timestamp)
  ) {
    return false;
  }
  if (Math.abs(request.nowMs / 1000 - Number(timestamp)) > TIMESTAMP_WINDOW_SECONDS) {
    return false;
  }

  const prefix = new TextEncoder().encode(timestamp);
  const message = new Uint8Array(prefix.length + request.body.length);
  message.set(prefix);
  message.set(request.body, prefix.length);
  const key = await crypto.subtle.importKey(
    'raw',
    hexBytes(request.publicKey),
    { name: 'Ed25519' },
    false,
    ['verify']
  );
  return crypto.subtle.verify({ name: 'Ed25519' }, key, hexBytes(signature), message);
}

/** The parts of an interaction this Worker reads. */
export interface Interaction {
  type: number;
  id: string;
  applicationId: string;
  token: string;
  /** The member in a server, or the user in a DM. PING has none. */
  userId: string | undefined;
  customId: string | undefined;
  /** The message the clicked component, or the modal's button, is on. */
  messageId: string | undefined;
  /** Modal text inputs by custom id. */
  textInputs: ReadonlyMap<string, string>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function matching(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function textInputs(data: Record<string, unknown> | undefined): Map<string, string> {
  const inputs = new Map<string, string>();
  const rows = Array.isArray(data?.components) ? (data.components as unknown[]) : [];
  for (const row of rows) {
    const components = record(row)?.components;
    for (const component of Array.isArray(components) ? (components as unknown[]) : []) {
      const input = record(component);
      if (typeof input?.custom_id === 'string' && typeof input.value === 'string') {
        inputs.set(input.custom_id, input.value);
      }
    }
  }
  return inputs;
}

/** A verified body as an interaction, or null when it is not one. */
export function parseInteraction(body: Uint8Array): Interaction | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  const interaction = record(parsed);
  const id = matching(interaction?.id, SNOWFLAKE);
  const applicationId = matching(interaction?.application_id, SNOWFLAKE);
  const token = matching(interaction?.token, INTERACTION_TOKEN);
  if (
    interaction === undefined ||
    typeof interaction.type !== 'number' ||
    id === undefined ||
    applicationId === undefined ||
    token === undefined
  ) {
    return null;
  }

  const user = record(record(interaction.member)?.user) ?? record(interaction.user);
  const data = record(interaction.data);
  return {
    type: interaction.type,
    id,
    applicationId,
    token,
    userId: matching(user?.id, SNOWFLAKE),
    customId: typeof data?.custom_id === 'string' ? data.custom_id : undefined,
    messageId: matching(record(interaction.message)?.id, SNOWFLAKE),
    textInputs: textInputs(data),
  };
}

/**
 * The custom id of a button or modal for an alert's delivery, or null when the
 * delivery id cannot be one: buttons are only shown when it can.
 */
export function issueActionCustomId(kind: CustomIdKind, deliveryId: string): string | null {
  const customId = `v1:${kind}:${deliveryId}`;
  return DELIVERY_ID.test(deliveryId) && customId.length <= CUSTOM_ID_LIMIT ? customId : null;
}

export function parseIssueActionCustomId(
  customId: string | undefined
): { kind: CustomIdKind; deliveryId: string } | null {
  const match = customId === undefined ? null : CUSTOM_ID.exec(customId);
  if (match === null) {
    return null;
  }
  const [, kind = '', deliveryId = ''] = match;
  return { kind: kind as CustomIdKind, deliveryId };
}

/** The label names typed in the modal, or null when there are none or too many. */
function parseLabels(value: string | undefined): string[] | null {
  const labels = [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((label) => label.trim())
        .filter((label) => label !== '')
    ),
  ];
  return labels.length === 0 ||
    labels.length > LABELS_PER_ACTION ||
    labels.some((label) => label.length > LABEL_NAME_LIMIT)
    ? null
    : labels;
}

export function labelsFromModal(interaction: Interaction): string[] | null {
  return parseLabels(interaction.textInputs.get(LABELS_INPUT));
}

export function pong(): { type: number } {
  return { type: RESPONSE_TYPES.PONG };
}

/** A message only the clicker sees, sent as the immediate response. */
export function ephemeralMessage(content: string): unknown {
  return {
    type: RESPONSE_TYPES.CHANNEL_MESSAGE,
    data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } },
  };
}

/** Acknowledges a click or submission; the message is edited later, if at all. */
export function deferredUpdate(): unknown {
  return { type: RESPONSE_TYPES.DEFERRED_UPDATE_MESSAGE };
}

/** The modal that asks which labels to add. Its custom id carries the delivery id. */
export function labelModal(customId: string): unknown {
  return {
    type: RESPONSE_TYPES.MODAL,
    data: {
      custom_id: customId,
      title: 'Add labels',
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: LABELS_INPUT,
              label: 'Labels, separated by commas',
              style: 1,
              min_length: 1,
              max_length: LABELS_INPUT_LIMIT,
              required: true,
              placeholder: 'bug, help wanted',
            },
          ],
        },
      ],
    },
  };
}
