/**
 * Generating one participant's invoice under a claim on its items.
 *
 * Section 3.4 of the invoice selection spec: the invoice write and the item
 * marking must succeed or fail together, and where the design forces a choice,
 * it must fail towards leaving items unbilled rather than billing them twice.
 *
 * ## The ordering problem
 *
 * The claim wants the invoice number, and the invoice number does not exist
 * until the generator has run — `generateNdisInvoiceGeneratorPdf` and
 * `generateParticipantTaxInvoicePdf` both allocate it internally, through
 * `claimDocumentNumber`. Claiming after generation would be too late: the PDF
 * would already exist for items another invoice had taken.
 *
 * So the claim is made with a provisional token first, and rewritten to the
 * real invoice number once the document exists:
 *
 *   1. claim the items with a provisional token
 *   2. generate, using only the items the claim actually took
 *   3. record the document on the ledger, still under the provisional token
 *   4. success → rewrite the marker to the real invoice number
 *      failure → release the claim, leaving the items for the next run
 *
 * The token is deterministic — same board, type, period and participant give
 * the same token — so a retried job re-claims its own items rather than
 * deadlocking against the claim its previous attempt left behind.
 *
 * ## Why the ledger write is step 3 and not step 5
 *
 * The marker rewrite is last so that a real invoice number on an item always
 * implies a `pdflinks` row exists for it. With the ledger written after the
 * rewrite instead, a crash in between left items carrying a finished-looking
 * marker with no document behind it: invisible to the stale-claim alarm, which
 * only knows the `pending:` prefix, and impossible to re-claim, because the
 * deterministic token no longer matched. That is permanent, silent
 * under-billing — the one outcome the protocol exists to avoid.
 */

import { PROVISIONAL_CLAIM_PREFIX } from '../constants/invoiceSelection.js';
import { ATTEMPT_TOKEN_SEPARATOR } from '../constants/invoiceLedger.js';
import { info, warn } from './logger.js';
import {
  claimItemsForInvoice,
  markItemsInvoiced,
  releaseItemClaim,
} from './invoicedMarker.js';

/**
 * The provisional marker held while a document is being produced.
 *
 * Prefixed `pending:` so a marker left behind by a crashed run is
 * distinguishable from a real claim when someone goes looking — those are the
 * items that were marked but never billed, and they are the ones safe to
 * clear.
 *
 * A scheduled run keeps the deterministic token above: a retried slot must
 * re-claim its own items. A manual invoice has no slot, so two concurrent
 * invoices for one participant would share a token and both claim the same
 * items (the claim accepts its own token), billing them twice. A manual
 * producer passes an `attemptId` unique to the request, which makes the tokens
 * differ, so the second claim is refused (KAN-302).
 */
export function provisionalClaimToken({
  type, periodKey, participant, attemptId = null,
}) {
  const token = `${PROVISIONAL_CLAIM_PREFIX}${type}:${periodKey}:${participant}`;
  return attemptId ? `${token}${ATTEMPT_TOKEN_SEPARATOR}${attemptId}` : token;
}

/**
 * Produce one participant's invoice, holding a claim on its items throughout.
 *
 * `produce` is called with the itemIds the claim actually took, and must
 * resolve to either `{ empty: true }` or an object carrying `invoiceNumber`.
 * Anything it throws is propagated after the claim is released, so a failing
 * run surfaces as a failed job rather than a silently short invoice.
 *
 * `record` — optional — writes the document to the ledger and runs while the
 * provisional token is still held. A throw from it is propagated WITHOUT
 * releasing the claim: some of the ledger rows may already exist, and handing
 * those items back to the next run would bill them a second time. The token
 * stays `pending:`, which is what the stale-claim alarm looks for.
 *
 * Returns `null` when there was nothing to bill — no items left after the
 * claim, or a generator that reported the period empty. Section 3.5: that is
 * not an error, and it must produce no invoice and no email.
 */
export async function generateUnderClaim({
  workspaceId, boardId, itemIds, type, periodKey, participant, produce, record = null, attemptId = null,
}) {
  const token = provisionalClaimToken({
    type, periodKey, participant, attemptId,
  });
  const { claimed, rejected } = await claimItemsForInvoice({
    workspaceId, boardId, itemIds, invoiceNumber: token, periodKey,
  });

  if (rejected.length > 0) {
    // Not fatal, and not silent: another invoice legitimately holds these, and
    // billing the rest is correct. It is logged because a large rejection
    // count is how a cadence change or an overlapping window shows up.
    warn('Automation', 'Some items were already claimed by another invoice; billing the rest', {
      workspaceId, boardId, periodKey, participant, rejected: rejected.length,
    });
  }

  if (claimed.length === 0) {
    info('Automation', 'Every item for this participant is already invoiced; nothing to bill', {
      workspaceId, boardId, periodKey, participant,
    });
    return null;
  }

  let generated;
  try {
    generated = await produce(claimed);
  } catch (err) {
    await releaseItemClaim({
      workspaceId, boardId, itemIds: claimed, invoiceNumber: token,
    });
    throw err;
  }

  if (!generated || generated.empty || !generated.invoiceNumber) {
    await releaseItemClaim({
      workspaceId, boardId, itemIds: claimed, invoiceNumber: token,
    });
    return null;
  }

  // The ledger row is written before the marker moves, so the marker can never
  // claim a document that does not exist. A failure here keeps the `pending:`
  // token rather than releasing it — see the note on `record` above.
  if (record) await record(generated, claimed);

  // The document exists and is on the ledger, so the provisional token becomes
  // the real number. Unconditional is safe here and only here: these are the
  // items this run holds, and it is replacing its own token.
  await markItemsInvoiced({
    workspaceId, boardId, itemIds: claimed, invoiceNumber: generated.invoiceNumber, periodKey,
  });

  return { ...generated, itemIds: claimed };
}
