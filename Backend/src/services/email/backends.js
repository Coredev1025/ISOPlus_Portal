/**
 * The two delivery backends that ship, both behind the same `deliver(message)`
 * contract so `deliverEmail` never branches on which one it has.
 *
 * `local-outbox` is the offline one: it writes the composed message to the
 * offline store and prints it, so a developer can read what would have been
 * sent without a mail server. `ses` is the real one.
 */

import { basename } from 'node:path';

import EmailSend from '../../models/EmailSend.js';
import { saveLocalFile } from '../../utils/localFileStore.js';
import { s3ObjectKeyFromUrl } from '../../utils/s3ObjectKey.js';
import { getS3File } from '../../utils/uploadS3.js';
import { error as logError, info, warn } from '../../utils/logger.js';
import { recordEmailSend } from './deliveryEvents.js';
import { resolveRecipient } from './recipients.js';
import {
  describeSendError, emailTransportConfig, isAccessDeniedError, isEmailTransportConfigured, sendEmail,
} from './sesTransport.js';
import { defaultEmailBody, defaultEmailSubject } from '../../utils/automationEmailDefaults.js';

const LOG_SCOPE = 'Email-Delivery';

/**
 * Path-safe form of a recipient name: anything not a letter, digit or dash
 * becomes a dash, so a name can never introduce a separator or a traversal
 * segment into the key.
 */
function recipientSlug(recipientKey) {
  return String(recipientKey)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * One file per claimed slot, keyed like the queue jobId, so a redelivered job
 * overwrites its own preview rather than accumulating duplicates.
 * `recipientKey` separates the per-participant messages a `client_participant`
 * run composes for one board and slot.
 */
export function outboxKeyFor({ kind, workspaceId, boardId, periodKey, recipientKey = null }) {
  const suffix = recipientKey ? `-${recipientSlug(recipientKey)}` : '';
  return `outbox/${workspaceId}/${kind}-${boardId}-${periodKey}${suffix}.json`;
}

/** The message as a backend-neutral record — what any backend would send. */
export function composeRecord(message) {
  const {
    kind, workspaceId, boardId, periodKey, block, attachments = [],
    businessName = null, boardName = null, recipientKey = null, documentNumbers = [],
  } = message;
  // The workspace's own wording wins. These only fill the gap, and they use
  // the business and board NAMES — a board id names an internal record the
  // recipient has never seen.
  const context = {
    businessName, boardName, participant: recipientKey, documentNumbers,
  };
  return {
    kind,
    workspaceId,
    boardId,
    periodKey,
    recipientType: block?.recipient ?? null,
    sendMethod: block?.sendMethod ?? null,
    replyTo: block?.replyTo || null,
    copyTo: block?.sendCopyTo || null,
    subject: block?.emailSubject || defaultEmailSubject(kind, context),
    body: block?.emailMessage || defaultEmailBody(kind, context),
    attachments,
  };
}

/**
 * The offline backend. Writes the composed message where a person can open it
 * (and `GET /api/local-files/outbox/...` can serve it), and prints the same
 * record so a local run does not have to go looking for the file.
 */
export const localOutboxBackend = {
  name: 'local-outbox',
  async deliver(message, { print = null } = {}) {
    const outboxKey = outboxKeyFor(message);
    const record = {
      ...composeRecord(message),
      composedAt: new Date().toISOString(),
      note: 'Offline outbox preview — nothing was sent.',
    };
    const json = JSON.stringify(record, null, 2);

    await saveLocalFile(outboxKey, Buffer.from(json));
    const emit = print ?? ((line) => info(LOG_SCOPE, 'Composed email (offline)', { outboxKey, preview: line }));
    emit(json);

    return { delivered: false, backend: this.name, outboxKey };
  },
};

/**
 * Attachment bytes for the generated PDFs.
 *
 * Read back through the same store that wrote them, so an offline URL and an
 * S3 one both work. One unreadable document must not cost the client the
 * whole email, so a failure is counted and skipped rather than thrown.
 */
async function loadAttachments(urls) {
  const attachments = [];
  let skipped = 0;

  for (const url of urls) {
    const key = s3ObjectKeyFromUrl(url);
    try {
      attachments.push({ filename: basename(key), content: await getS3File(key) });
    } catch (err) {
      skipped += 1;
      warn(LOG_SCOPE, 'Attachment could not be read; sending without it', { url, error: err.message });
    }
  }
  return { attachments, skipped };
}

/**
 * The messageId is the ONLY key that joins a Delivery/Bounce event from the
 * SQS queue back to the invoice run that sent the mail, so it is persisted at
 * send time. A failed write must not throw: the email is already sent, and a
 * thrown error here would make BullMQ retry the job and send it again.
 */
async function recordSend({ messageId, kind, workspaceId, boardId, periodKey, recipientKey, block }) {
  if (!messageId) return;
  try {
    await EmailSend.create({
      messageId, kind, workspaceId, boardId, periodKey, recipientKey,
      recipientType: block?.recipient ?? null,
    });
  } catch (err) {
    logError(LOG_SCOPE, 'Sent email could not be recorded; its delivery events will be unattributable', {
      messageId, kind, workspaceId, boardId, periodKey, error: err.message,
    });
  }
}

/**
 * The real backend. The stored `recipient` is a TYPE, so the address is
 * resolved here; an unresolvable one refuses the send rather than guessing at
 * an address, because the wrong recipient for an invoice is worse than a
 * missing one.
 */
export const sesBackend = {
  name: 'ses',
  async deliver(message) {
    const {
      workspaceId, boardId, kind, periodKey, block, recipientKey = null, bypassEmail = null,
    } = message;
    const record = composeRecord(message);

    // The tick's recipient override. When present it replaces the resolved
    // address entirely, so a deployment can be verified end to end without a
    // message reaching a participant. Logged at warn every time, and never
    // defaulted: it only applies when a tick explicitly asked for it.
    //
    // KAN-272: no `recipientType` any more — resolveRecipient derives the
    // mailbox itself from the participant's own profile (Case A/AA/B), so
    // there is nothing left for this backend to pass in.
    const recipient = bypassEmail?.length
      ? { address: bypassEmail.join(', '), source: 'bypass_email' }
      : await resolveRecipient({ workspaceId, boardId, participant: recipientKey });

    if (bypassEmail?.length) {
      warn(LOG_SCOPE, 'bypassEmail is set; sending to the override address instead of the participant', {
        kind, workspaceId, boardId, periodKey, to: recipient.address, participant: recipientKey,
      });
    }

    if (!recipient.address) {
      warn(LOG_SCOPE, 'No recipient address; nothing sent', {
        kind, workspaceId, boardId, periodKey, reason: recipient.reason,
      });
      return { delivered: false, backend: this.name, reason: recipient.reason };
    }

    const { attachments, skipped } = await loadAttachments(record.attachments);
    let sent;
    try {
      sent = await sendEmail({
        to: recipient.address,
        cc: record.copyTo,
        replyTo: record.replyTo,
        subject: record.subject,
        html: record.body,
        attachments,
      });
    } catch (err) {
      // An IAM policy denying ses:SendEmail. Retrying can never succeed, so it
      // is a recorded refusal, not a thrown one — anything else stays thrown
      // for BullMQ.
      if (!isAccessDeniedError(err)) throw err;
      // KAN-266: both addresses and the provider's own words.
      //
      // SES authorises ses:SendEmail against the *sending identity* ARN —
      // identity/<from-address> — and names the recipient only in an optional
      // ses:Recipients condition. So a From outside the policy's identities
      // raises exactly the same AccessDenied as a disallowed recipient, and
      // this branch cannot tell which happened. It previously logged neither
      // address nor the error, which left the logs unable to settle it either
      // — and on portal-dev a From-address failure was read as a recipient
      // one for two days. The provider's own message names the identity it
      // objected to; that is the line worth having.
      //
      // KAN-270: the From address is application-level (EMAIL_FROM) now, not
      // read off this message — emailTransportConfig() is the current value.
      warn(LOG_SCOPE, 'SES refused the send (access denied)', {
        kind,
        workspaceId,
        boardId,
        periodKey,
        recipientSource: recipient.source,
        to: recipient.address,
        from: emailTransportConfig().from,
        ...describeSendError(err),
      });
      return { delivered: false, backend: this.name, reason: 'access_denied' };
    }

    await recordSend({ messageId: sent.messageId, kind, workspaceId, boardId, periodKey, recipientKey, block });

    // The message id is the only handle a Delivery/Bounce event arriving
    // minutes from now has on the documents this email carried, so it is
    // stamped on their PDFLink rows before anything else can lose it.
    // recordEmailSend never throws: the mail has already gone, and a retried
    // job would send it a second time.
    const tracked = await recordEmailSend({
      messageId: sent.messageId,
      workspaceId,
      documentUrls: record.attachments,
    });

    info(LOG_SCOPE, 'Automation email sent', {
      kind, workspaceId, boardId, periodKey,
      messageId: sent.messageId,
      attachments: attachments.length,
      skippedAttachments: skipped,
      trackedDocuments: tracked,
      recipientSource: recipient.source,
    });

    return {
      delivered: true,
      backend: this.name,
      messageId: sent.messageId,
      skippedAttachments: skipped,
    };
  },
};

export { isEmailTransportConfigured };
