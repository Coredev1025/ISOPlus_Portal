/**
 * What happened to an automation email after it left, recorded against the
 * documents it carried.
 *
 * The seam is the message id. `sesBackend.deliver` stamps it on the PDFLink
 * rows whose PDFs were attached; SES publishes Delivery/Bounce/Complaint
 * events minutes later, and `applyDeliveryEvent` matches them back by that id.
 * Nothing here knows about SQS — `workers/emailEventsWorker.js` owns the
 * queue, this module owns the SES event inside each message.
 *
 * Everything above `recordEmailSend` is pure and unit-tested on its own; the
 * two functions below it are the only ones that touch the database.
 */

import PDFLink from '../../models/PDFLink.js';
import { info, warn } from '../../utils/logger.js';
import {
  DELIVERY_STATE_BOUNCED,
  DELIVERY_STATE_COMPLAINED,
  DELIVERY_STATE_DELAYED,
  DELIVERY_STATE_DELIVERED,
  DELIVERY_STATE_FAILED,
  DELIVERY_STATE_RANK,
  DELIVERY_STATE_SENT,
  DELIVERY_REFUSAL_MESSAGES,
  DEFAULT_DELIVERY_REFUSAL_MESSAGE,
} from '../../constants/automation.js';

const LOG_SCOPE = 'Email-Delivery-Events';

/**
 * SES's event vocabulary in terms of ours. `Open` and `Click` are absent
 * deliberately: they are engagement, not delivery, and surfacing "the client
 * opened this" on a billing page is a different feature with its own consent
 * question.
 */
const EVENT_STATES = {
  Send: DELIVERY_STATE_SENT,
  Delivery: DELIVERY_STATE_DELIVERED,
  DeliveryDelay: DELIVERY_STATE_DELAYED,
  Bounce: DELIVERY_STATE_BOUNCED,
  Complaint: DELIVERY_STATE_COMPLAINED,
  Reject: DELIVERY_STATE_FAILED,
};

/**
 * Client-facing copy. These sentences are shown to whoever owns the
 * workspace's billing settings, so they name the thing to fix rather than the
 * protocol that failed. Keyed `bounceType/bounceSubType`, the pair SES sends.
 *
 * Deliberately not in `constants/automation.js`: it is prose read by exactly
 * one function, and the constants file is for values other modules key on.
 */
const BOUNCE_REASONS = {
  'Permanent/General': "The recipient's mail server permanently rejected the email.",
  'Permanent/NoEmail': "Email address doesn't exist.",
  'Permanent/Suppressed': 'This address bounced before, so it is on the suppression list.',
  'Permanent/OnAccountSuppressionList':
    'This address is on your account suppression list after an earlier bounce.',
  'Transient/General': "The recipient's mail server temporarily refused the email.",
  'Transient/MailboxFull': "The recipient's mailbox is full.",
  'Transient/MessageTooLarge': 'The email was too large for the recipient to accept.',
  'Transient/ContentRejected': "The recipient's mail server rejected the content of the email.",
  'Transient/AttachmentRejected': 'The recipient could not accept the attached documents.',
  'Undetermined/Undetermined':
    "The email could not be delivered and the recipient's mail server did not say why.",
};

const COMPLAINT_REASON = 'The recipient marked this email as spam.';
const REJECT_REASON = 'Amazon SES rejected the email before sending it.';
const DELAY_REASON = 'Delivery is taking longer than usual; SES is still retrying.';

/**
 * The message id as a stable lookup key: no angle brackets, trimmed, folded to
 * lower case.
 *
 * Nodemailer hands back the `Message-ID` header (`<abc@host>`); SES publishes
 * BOTH that header (under `mail.commonHeaders.messageId`) and its own id
 * (under `mail.messageId`). Normalising both ends means either one matches.
 */
export function normalizeMessageId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^<|>$/g, '').trim().toLowerCase();
  return trimmed || null;
}

/**
 * The bounce as one sentence the client can act on.
 *
 * The SMTP diagnostic is never included: it is unbounded text from a third
 * party's mail server, and "550 5.1.1 <x@y> Recipient not found" tells a
 * finance administrator nothing that "Email address doesn't exist." does not.
 */
export function bounceReason(bounce = {}) {
  const type = safeLabel(bounce?.bounceType);
  const subType = safeLabel(bounce?.bounceSubType);
  return (
    BOUNCE_REASONS[`${type}/${subType}`]
    ?? `The email could not be delivered (${type}/${subType}).`
  );
}

/**
 * Letters and digits only, capped. The fallback sentence embeds these values,
 * and they arrive in an unauthenticated request body — so nothing that could
 * read as markup, a URL or a sentence of its own survives.
 */
function safeLabel(value) {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
  return cleaned || 'Unknown';
}

/** The detail line for a state, or null where the state speaks for itself. */
function detailFor(state, event) {
  if (state === DELIVERY_STATE_BOUNCED) return bounceReason(event.bounce);
  if (state === DELIVERY_STATE_COMPLAINED) return COMPLAINT_REASON;
  if (state === DELIVERY_STATE_FAILED) return REJECT_REASON;
  if (state === DELIVERY_STATE_DELAYED) return DELAY_REASON;
  return null;
}

/**
 * One SES event reduced to what the store needs: the state it implies, the
 * sentence to show, and every id it could be matched on.
 *
 * `notificationType` is the older SES-notification spelling of `eventType`;
 * both are accepted because a topic configured either way should work.
 *
 * @returns {{state: string, detail: string|null, messageIds: string[]}|null}
 *   null when the event is not one we record.
 */
export function describeSesEvent(event) {
  const type = event?.eventType ?? event?.notificationType;
  const state = EVENT_STATES[type];
  if (!state) return null;

  const messageIds = [event?.mail?.messageId, event?.mail?.commonHeaders?.messageId]
    .map(normalizeMessageId)
    .filter(Boolean);

  return { state, detail: detailFor(state, event), messageIds: [...new Set(messageIds)] };
}

/**
 * States an incoming event is allowed to overwrite: everything it outranks.
 * Equal rank is excluded, which is what makes a redelivered notification a
 * no-op rather than a second write.
 */
function statesBelow(state) {
  const rank = DELIVERY_STATE_RANK[state] ?? 0;
  return Object.keys(DELIVERY_STATE_RANK).filter((name) => DELIVERY_STATE_RANK[name] < rank);
}

/**
 * Record that `messageId` carried these documents.
 *
 * Called after the send has already happened, so a failure here must not
 * propagate: throwing would fail the job, and a retried job sends the email
 * again. The consequence of swallowing it is a document stuck at "Generated",
 * which is the safe direction to be wrong in.
 *
 * @returns {Promise<number>} how many documents were stamped.
 */
export async function recordEmailSend({ messageId, workspaceId, documentUrls = [] }) {
  const normalized = normalizeMessageId(messageId);
  const urls = [...new Set(documentUrls.filter((url) => typeof url === 'string' && url))];
  if (!normalized || urls.length === 0 || !workspaceId) return 0;

  try {
    const result = await PDFLink.updateMany(
      // Scoped by workspace as well as URL: the URL is the only natural key
      // here, and one tenant must not be able to claim another's row by
      // reusing it.
      { workspaceId: { $eq: String(workspaceId) }, pdfLink: { $in: urls } },
      {
        $set: {
          deliveryMessageId: normalized,
          deliveryState: DELIVERY_STATE_SENT,
          deliveryUpdatedAt: new Date(),
        },
        $unset: { deliveryDetail: '' },
      },
    );
    return result?.modifiedCount ?? 0;
  } catch (err) {
    warn(LOG_SCOPE, 'Could not record the send against its documents', {
      workspaceId, documentCount: urls.length, error: err.message,
    });
    return 0;
  }
}

/**
 * Record that these documents were NOT emailed, and why.
 *
 * The counterpart to `recordEmailSend`, for the path that never reaches SES:
 * the recipient could not be resolved, or the transport refused the address.
 * Both were only logged, so the documents kept the default `generated` — a
 * muted badge the panel renders "never as an error" — and a run that delivered
 * nothing to anybody still showed as On track. That is precisely the state
 * Epic 5's visibility panel exists to make impossible.
 *
 * `deliveryDetail` carries a sentence naming the field to fix rather than the
 * internal reason code, because the reader is the client, not an operator.
 *
 * No message id: there is no message. That also means a later successful
 * re-send — which the refusal path deliberately leaves possible, by keeping the
 * documents rather than discarding them — overwrites this through
 * `recordEmailSend`, which sets state unconditionally and clears the detail.
 *
 * Never throws, for the same reason `recordEmailSend` does not: it is called
 * after the send attempt is over, and failing the job would retry a send that
 * already went out to the participants it did reach.
 *
 * @returns {Promise<number>} how many documents were stamped.
 */
export async function recordEmailFailure({ workspaceId, documentUrls = [], reason = null }) {
  const urls = [...new Set(documentUrls.filter((url) => typeof url === 'string' && url))];
  if (!workspaceId || urls.length === 0) return 0;

  const detail = DELIVERY_REFUSAL_MESSAGES[reason] ?? DEFAULT_DELIVERY_REFUSAL_MESSAGE;

  try {
    const result = await PDFLink.updateMany(
      // Scoped by workspace as well as URL, exactly as the send path is: the
      // URL is the only natural key, and one tenant must not stamp another's row.
      { workspaceId: { $eq: String(workspaceId) }, pdfLink: { $in: urls } },
      {
        $set: {
          deliveryState: DELIVERY_STATE_FAILED,
          deliveryDetail: detail,
          deliveryUpdatedAt: new Date(),
        },
      },
    );
    return result?.modifiedCount ?? 0;
  } catch (err) {
    warn(LOG_SCOPE, 'Could not record the delivery failure against its documents', {
      workspaceId, documentCount: urls.length, reason, error: err.message,
    });
    return 0;
  }
}

/**
 * Apply one SES event to whatever documents its message carried.
 *
 * Idempotent and order-independent by construction: the update only matches
 * rows whose current state this event outranks, so a duplicate notification
 * matches nothing and a late `Delivery` cannot erase a `Bounce`.
 *
 * A message id nobody recorded matches nothing and is not an error — SES also
 * publishes events for mail this feature never sent.
 *
 * @returns {Promise<{state: string|null, matched: number}>}
 */
export async function applyDeliveryEvent(event) {
  const described = describeSesEvent(event);
  if (!described || described.messageIds.length === 0) return { state: null, matched: 0 };

  const { state, detail, messageIds } = described;
  // A state with no detail clears any detail left by an earlier state, so a
  // row never shows a bounce reason next to a state that is not a bounce.
  const update = {
    $set: { deliveryState: state, deliveryUpdatedAt: new Date(), ...(detail && { deliveryDetail: detail }) },
    ...(detail ? {} : { $unset: { deliveryDetail: '' } }),
  };

  const result = await PDFLink.updateMany(
    {
      deliveryMessageId: { $in: messageIds },
      deliveryState: { $in: statesBelow(state) },
    },
    update,
  );

  const matched = result?.modifiedCount ?? 0;
  info(LOG_SCOPE, 'SES delivery event applied', { state, matched });
  return { state, matched };
}
