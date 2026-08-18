/**
 * The two delivery backends that ship, both behind the same `deliver(message)`
 * contract so `deliverEmail` never branches on which one it has.
 *
 * `local-outbox` is the offline one: it writes the composed message to the
 * offline store and prints it, so a developer can read what would have been
 * sent without a mail server. `ses` is the real one.
 */

import { basename } from 'node:path';

import { saveLocalFile } from '../../utils/localFileStore.js';
import { getS3File } from '../../utils/uploadS3.js';
import { info, warn } from '../../utils/logger.js';
import { resolveRecipient } from './recipients.js';
import { isEmailTransportConfigured, sendEmail } from './sesTransport.js';

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
  const { kind, workspaceId, boardId, periodKey, block, attachments = [] } = message;
  return {
    kind,
    workspaceId,
    boardId,
    periodKey,
    recipientType: block?.recipient ?? null,
    sendMethod: block?.sendMethod ?? null,
    from: block?.emailFrom || null,
    replyTo: block?.replyTo || null,
    copyTo: block?.sendCopyTo || null,
    subject: block?.emailSubject || `${kind} for board ${boardId}`,
    body: block?.emailMessage || '',
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
    const key = decodeURIComponent(String(url)).split('/api/local-files/')[1]
      ?? decodeURIComponent(String(url)).split('.amazonaws.com/')[1]
      ?? String(url);
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
 * The real backend. The stored `recipient` is a TYPE, so the address is
 * resolved here; an unresolvable one refuses the send rather than guessing at
 * an address, because the wrong recipient for an invoice is worse than a
 * missing one.
 */
export const sesBackend = {
  name: 'ses',
  async deliver(message) {
    const { workspaceId, boardId, kind, periodKey, block, recipientKey = null } = message;
    const record = composeRecord(message);

    const recipient = await resolveRecipient({
      workspaceId,
      boardId,
      participant: recipientKey,
      recipientType: block?.recipient,
    });

    if (!recipient.address) {
      warn(LOG_SCOPE, 'No recipient address; nothing sent', {
        kind, workspaceId, boardId, periodKey, reason: recipient.reason,
      });
      return { delivered: false, backend: this.name, reason: recipient.reason };
    }

    const { attachments, skipped } = await loadAttachments(record.attachments);
    const sent = await sendEmail({
      from: record.from,
      to: recipient.address,
      cc: record.copyTo,
      replyTo: record.replyTo,
      subject: record.subject,
      html: record.body,
      attachments,
    });

    info(LOG_SCOPE, 'Automation email sent', {
      kind, workspaceId, boardId, periodKey,
      messageId: sent.messageId,
      attachments: attachments.length,
      skippedAttachments: skipped,
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
