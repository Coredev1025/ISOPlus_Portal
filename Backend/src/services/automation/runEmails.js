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
import { describeSesEvent, rankOfState } from '../../services/email/deliveryEvents.js';
import { DELIVERY_STATE_SENT } from '../../constants/automation.js';

/**
 * The most final outcome among a message's events, and the sentence for it.
 *
 * Ranked rather than latest-wins for the same reason applyDeliveryEvent ranks:
 * SES does not order its notifications, so a Delivery published after a Bounce
 * would otherwise erase the one outcome the operator can act on.
 *
 * The state AND its sentence both come from `describeSesEvent`, the same
 * function the client panel's ingestion path uses. An earlier version mapped
 * the state here and wrote its own detail rule — "only a bounce gets a
 * sentence" — which silently dropped the reason for a Rendering Failure and
 * left the drill-down showing "failed" with nothing to act on. One reducer,
 * one vocabulary.
 *
 * `EmailEvent` stores the type-specific block under a generic `detail` field,
 * so it is handed back under `bounce`, the only key describeSesEvent reads it
 * from. Every other type's sentence is a constant. The `mail` block it uses to
 * collect message ids is not passed: the id is already known here, and the
 * returned `messageIds` is discarded.
 */
function foldEvents(events) {
  let best = { state: DELIVERY_STATE_SENT, detail: null };

  for (const event of events) {
    const described = describeSesEvent({
      eventType: event.eventType,
      bounce: event.detail ?? {},
    });
    if (!described || rankOfState(described.state) <= rankOfState(best.state)) continue;
    best = { state: described.state, detail: described.detail };
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
