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
 *   3. success → rewrite the marker to the real invoice number
 *      failure → release the claim, leaving the items for the next run
 *
 * The token is deterministic — same board, type, period and participant give
 * the same token — so a retried job re-claims its own items rather than
 * deadlocking against the claim its previous attempt left behind.
 */

import { PROVISIONAL_CLAIM_PREFIX } from '../constants/invoiceSelection.js';
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
 */
export function provisionalClaimToken({ type, periodKey, participant }) {
  return `${PROVISIONAL_CLAIM_PREFIX}${type}:${periodKey}:${participant}`;
}

/**
 * Produce one participant's invoice, holding a claim on its items throughout.
 *
 * `produce` is called with the itemIds the claim actually took, and must
 * resolve to either `{ empty: true }` or an object carrying `invoiceNumber`.
 * Anything it throws is propagated after the claim is released, so a failing
 * run surfaces as a failed job rather than a silently short invoice.
 *
 * Returns `null` when there was nothing to bill — no items left after the
 * claim, or a generator that reported the period empty. Section 3.5: that is
 * not an error, and it must produce no invoice and no email.
 */
export async function generateUnderClaim({
  workspaceId, boardId, itemIds, type, periodKey, participant, produce,
}) {
  const token = provisionalClaimToken({ type, periodKey, participant });
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

  // The document exists, so the provisional token becomes the real number.
  // Unconditional is safe here and only here: these are the items this run
  // holds, and it is replacing its own token.
  await markItemsInvoiced({
    workspaceId, boardId, itemIds: claimed, invoiceNumber: generated.invoiceNumber, periodKey,
  });

  return { ...generated, itemIds: claimed };
}
