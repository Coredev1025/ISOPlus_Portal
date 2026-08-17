// The delivery seam for Epic 5 part 4 — the first slice of it, deliberately.
//
// Nothing in this codebase sends email yet: SES delivery is parts 3-4 of the
// epic and the automation worker was pinned inert until it lands. This module
// is where that lands, one honest half at a time. Offline, deliverEmail()
// composes the message the automation *would* send and writes it to a file a
// person can open and verify — the manual-verification pipe local work needs.
// Online it refuses loudly: a transport that silently drops mail is the one
// failure mode worse than not having a transport at all. When SES arrives, it
// replaces the throw below and nothing upstream changes.
//
// Files land under the same offline store S3 stand-ins use
// (utils/localFileStore.js), so `GET /api/local-files/outbox/...` serves them
// and `Backend/.local-s3/outbox/` holds them on disk.

import { isOfflineMode } from '../offlineIsoplus.js';
import { saveLocalFile } from '../../utils/localFileStore.js';
import { info } from '../../utils/logger.js';

/**
 * Path-safe, collision-resistant form of a recipient name. Anything that is
 * not a letter, digit or dash becomes a dash, so a name can never introduce a
 * separator or a traversal segment into the key.
 */
function recipientSlug(recipientKey) {
  return String(recipientKey)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * One file per claimed slot, named like the queue jobId is keyed
 * (kind + board + periodKey). A redelivered at-least-once job overwrites its
 * own preview rather than accumulating duplicates, so the outbox mirrors the
 * pipeline's idempotency instead of muddying its evidence.
 *
 * A `client_participant` run composes one message per participant for the same
 * board and slot, so `recipientKey` adds a final component: without it every
 * one of those messages resolves to the same path and the preview shows one
 * email where the run produced five. Absent for a billing-contact run, which
 * keeps its historical key.
 */
export function outboxKeyFor({ kind, workspaceId, boardId, periodKey, recipientKey = null }) {
  const suffix = recipientKey ? `-${recipientSlug(recipientKey)}` : '';
  return `outbox/${workspaceId}/${kind}-${boardId}-${periodKey}${suffix}.json`;
}

/**
 * Deliver a composed automation email.
 *
 * `block` is the email half of an AutomationSettings block, already validated
 * on the write path (parseAutomationSettingsBody). The recipient is stored as
 * a *type* (billing_contact | client_participant) rather than an address —
 * resolving it to a real address is delivery work that belongs with the real
 * transport, so the preview records the type it would resolve.
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
