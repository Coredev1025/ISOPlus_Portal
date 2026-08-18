// SES sending events, from queue message to stored row.
//
// Parsing and recording are separate on purpose: parse turns one SQS message
// body into one normalised record and THROWS on anything it cannot key — a
// thrown message returns to the queue and lands in the dead-letter queue after
// five attempts, where a swallowed error would delete the event unrecorded.
// Recording is an upsert against EmailEvent's unique index, so an SQS
// redelivery is absorbed rather than duplicated or crashed on.

import EmailEvent from '../../models/EmailEvent.js';

// Where each event type keeps its detail block in the SES event JSON. SES's
// names are not mechanically derivable from the type ("Rendering Failure"
// stores under `failure`), so the mapping is explicit.
const DETAIL_KEY_FOR_TYPE = {
  Send: 'send',
  Delivery: 'delivery',
  Bounce: 'bounce',
  Complaint: 'complaint',
  DeliveryDelay: 'deliveryDelay',
  Reject: 'reject',
  'Rendering Failure': 'failure',
};

/**
 * The SNS envelope, unwrapped. A subscription without raw message delivery
 * wraps the SES event as {Type: "Notification", Message: "<json>"}; with it,
 * the body IS the event. Accept both so a console-side toggle cannot silently
 * stop ingestion.
 */
function unwrapEnvelope(parsed) {
  if (parsed?.Type === 'Notification' && typeof parsed.Message === 'string') {
    return JSON.parse(parsed.Message);
  }
  return parsed;
}

/**
 * One queue message body → one normalised event record.
 *
 * @param {string} body The raw SQS message body.
 * @returns {{eventType: string, sesMessageId: string, eventAt: Date, recipients: string[], subject: string|null, detail: object|null}}
 */
export function parseSesEventMessage(body) {
  const event = unwrapEnvelope(JSON.parse(body));

  const eventType = event?.eventType;
  if (!eventType) {
    throw new Error('SES event has no eventType — cannot key it, refusing to store it.');
  }
  const sesMessageId = event?.mail?.messageId;
  if (!sesMessageId) {
    throw new Error('SES event has no mail.messageId — cannot key it, refusing to store it.');
  }

  const detail = event[DETAIL_KEY_FOR_TYPE[eventType]] ?? null;
  const timestamp = detail?.timestamp ?? event.mail?.timestamp;

  return {
    eventType,
    sesMessageId,
    eventAt: new Date(timestamp),
    recipients: event.mail?.destination ?? [],
    subject: event.mail?.commonHeaders?.subject ?? null,
    detail,
  };
}

/**
 * Store one parsed event, exactly once. $setOnInsert against the unique
 * index means a redelivered event matches the existing row and writes
 * nothing, rather than throwing E11000 or inserting a duplicate.
 *
 * @returns {Promise<{recorded: boolean}>} recorded=false means it was already stored.
 */
export async function recordEmailEvent({ eventType, sesMessageId, eventAt, recipients, subject, detail }) {
  const result = await EmailEvent.updateOne(
    { sesMessageId, eventType, eventAt },
    { $setOnInsert: { recipients, subject, detail } },
    { upsert: true },
  );
  return { recorded: result.upsertedCount === 1 };
}
