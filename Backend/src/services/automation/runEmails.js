// Every email one automation run produced, with what became of each.
//
// The join the drill-down needed and nobody had wired: `EmailSend` is the only
// record of which board, period and recipient an SES messageId belonged to, and
// `EmailEvent` carries the outcomes keyed on that same id. The run row itself
// knows only aggregates — its `recipient` field is a participant key, not an
// address, and null for the billing-contact route — so "every email sent" could
// not be answered from it.

import EmailSend from '../../models/EmailSend.js';
import EmailEvent from '../../models/EmailEvent.js';
import {
  bounceReason,
  rankOfState,
  stateForEventType,
} from '../../services/email/deliveryEvents.js';
import { DELIVERY_STATE_SENT } from '../../constants/automation.js';

/**
 * The most final outcome among a message's events.
 *
 * Ranked rather than latest-wins for the same reason applyDeliveryEvent ranks:
 * SES does not order its notifications, so a Delivery published after a Bounce
 * would otherwise erase the one outcome the operator can act on.
 */
function foldEvents(events) {
  let best = { state: DELIVERY_STATE_SENT, detail: null };

  for (const event of events) {
    const state = stateForEventType(event.eventType);
    if (!state || rankOfState(state) <= rankOfState(best.state)) continue;
    best = {
      state,
      // Only a bounce carries a sentence worth showing; the others are
      // self-explanatory from the state alone.
      detail: state === 'bounced' ? bounceReason(event.detail ?? {}) : null,
    };
  }

  return best;
}

/**
 * @returns {Promise<Array<{messageId: string, recipient: string|null,
 *   recipientType: string|null, sentAt: Date, state: string, detail: string|null}>>}
 *   Newest first. An empty array means the run produced no email — a skipped
 *   run, or one whose documents went to an accounting platform instead.
 */
export async function emailsForRun(run) {
  const sends = await EmailSend.find({
    workspaceId: { $eq: run.workspaceId },
    boardId: { $eq: run.boardId },
    periodKey: { $eq: run.periodKey },
    kind: { $eq: run.kind },
  })
    .sort({ createdAt: -1 })
    .lean();

  if (sends.length === 0) return [];

  const events = await EmailEvent.find({
    sesMessageId: { $in: sends.map((send) => send.messageId) },
  }).lean();

  const byMessage = new Map();
  for (const event of events) {
    if (!byMessage.has(event.sesMessageId)) byMessage.set(event.sesMessageId, []);
    byMessage.get(event.sesMessageId).push(event);
  }

  return sends.map((send) => ({
    messageId: send.messageId,
    recipient: send.recipientKey ?? null,
    recipientType: send.recipientType ?? null,
    sentAt: send.createdAt,
    // No events yet is not a failure: the message was handed to SES and
    // nothing has come back. That is exactly what `sent` means.
    ...foldEvents(byMessage.get(send.messageId) ?? []),
  }));
}
