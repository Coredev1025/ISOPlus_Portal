// The offline half of the delivery seam. Nothing here sends email yet — SES
// transport is Epic 5 part 4 — so deliverEmail() composes the message the
// automation would send and writes it to the same offline store the S3
// stand-ins use (utils/localFileStore.js, served by GET /api/local-files).
// Online it throws: a transport that silently drops mail is worse than no
// transport. SES replaces the throw below; nothing upstream changes.

import { isOfflineMode } from '../offlineIsoplus.js';
import { saveLocalFile } from '../../utils/localFileStore.js';
import { info } from '../../utils/logger.js';

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
 *
 * `recipientKey` separates the per-participant messages a `client_participant`
 * run composes for one board and slot; without it they all resolve to the same
 * path. Absent for a billing-contact run, which keeps its historical key.
 */
export function outboxKeyFor({ kind, workspaceId, boardId, periodKey, recipientKey = null }) {
  const suffix = recipientKey ? `-${recipientSlug(recipientKey)}` : '';
  return `outbox/${workspaceId}/${kind}-${boardId}-${periodKey}${suffix}.json`;
}

/**
 * Deliver a composed automation email. `block` is the email half of an
 * AutomationSettings block, already validated by parseAutomationSettingsBody.
 * The recipient is stored as a *type* (billing_contact | client_participant)
 * rather than an address — resolving it belongs with the real transport, so the
 * preview records the type it would resolve.
 */
export async function deliverEmail(message) {
  const { kind, workspaceId, boardId, periodKey, block, attachments = [] } = message;

  if (!isOfflineMode()) {
    throw new Error(
      'Email delivery is not implemented: SES transport is Epic 5 part 4. ' +
      'Only the offline outbox exists — refusing rather than silently dropping mail.',
    );
  }

  const outboxKey = outboxKeyFor(message);
  const composed = {
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
    composedAt: new Date().toISOString(),
    note: 'Offline outbox preview — nothing was sent. SES delivery is Epic 5 part 4.',
  };

  await saveLocalFile(outboxKey, Buffer.from(JSON.stringify(composed, null, 2)));
  info('Email-Outbox', 'Composed email written to offline outbox', {
    kind, workspaceId, boardId, periodKey, outboxKey,
  });

  return { delivered: false, outboxKey };
}
