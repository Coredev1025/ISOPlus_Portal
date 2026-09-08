// The one home for the four helpers every invoice/quote PDF path needs. Each
// of these existed twice — here and again in routes/webhook.js — with the
// webhook copy hardcoding 'Australia/Sydney' where this one reads
// DEFAULT_TIMEZONE. Import from here; do not re-declare.
//
// Readers: routes/webhook.js, routes/xero.js,
// services/automation/ndisInvoiceGeneratorPdf.js,
// services/automation/pushDraftInvoicesToXero.js, and (via injected deps built
// in routes/webhook.js and routes/xero.js) utils/webhookNdisPdfHandlers.js,
// utils/webhookParticipantTaxPdfHelpers.js,
// utils/webhookMonthlyStatementPdfHelpers.js, utils/xeroNdisRouteHandlers.js.
import InvoiceNumber from '../models/InvoiceNumber.js';
import { claimHolder, claimItemsForInvoice } from './invoicedMarker.js';
import { getS3File } from './uploadS3.js';
import { mongoEq } from './securityHelpers.js';
import { info, warn } from './logger.js';
import { DEFAULT_TIMEZONE } from '../constants/scheduler.js';
import { PROVISIONAL_CLAIM_PREFIX } from '../constants/invoiceSelection.js';

export function enableRepeatHeadOnTables(template) {
  if (!template?.schemas || !Array.isArray(template.schemas)) return;
  for (const pageSchemas of template.schemas) {
    if (!Array.isArray(pageSchemas)) continue;
    for (const schema of pageSchemas) {
      if (schema && schema.type === 'table') schema.repeatHead = true;
    }
  }
}

export function formatDateNumericAU(value, timeZone) {
  const zone = timeZone || DEFAULT_TIMEZONE;
  if (!value) {
    return new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric', timeZone: zone });
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric', timeZone: zone });
}

export async function getLogoData(business, req = null) {
  const logoKey = business.defaultLogo;
  if (!logoKey) return '';
  const buffer = await getS3File(logoKey, false);
  if (!buffer) throw new Error('Failed to retrieve logo from S3');
  info('Webhook-Service', 'Embedding default logo for PDF generation', {
    workspaceId: business?.workspaceId,
    hasDefaultLogo: !!business?.defaultLogo,
  }, req ?? null);
  const type = logoKey.split('.').pop();
  return `data:image/${type};base64,${buffer.toString('base64')}`;
}

/**
 * Report that a claim was refused, naming the invoice that holds the item.
 *
 * Split out so `saveInvoiceNumber` stays flat: the holder read only happens on
 * the refusal path, which is the rare one.
 *
 * A `pending:` holder is a provisional token from an automated run that is
 * still in flight or has crashed — a different problem, with its own detection
 * in utils/staleInvoiceClaims.js — so it is not reported as a competing
 * document here.
 */
async function warnAlreadyInvoiced({ workspaceId, boardId, itemId, invoiceNumber, type }) {
  const claimedBy = await claimHolder({ workspaceId, boardId, itemId });
  if (!claimedBy || claimedBy.startsWith(PROVISIONAL_CLAIM_PREFIX)) return;
  warn('Webhook-Service', 'Item is already invoiced; keeping the existing claim', {
    workspaceId, boardId, itemId, invoiceNumber, type, claimedBy,
  }, {});
}

/**
 * Write the ledger row that records which invoice covers this item.
 *
 * `mongoEq` on every filter value: `itemId` reaches here straight off a webhook
 * or Xero payload, so it is user-controlled and could be an object. The Xero
 * router used to keep a private copy of this function purely for that guard,
 * and folding the guard in here is what let that copy go.
 *
 * Split out to keep `saveInvoiceNumber` flat now that it has two ordered steps.
 */
async function writeInvoiceNumberRow({ workspaceId, boardId, itemId, invoiceNumber, type, pdfLink }) {
  await InvoiceNumber.findOneAndUpdate(
    {
      itemId: mongoEq(itemId),
      workspaceId: mongoEq(workspaceId),
      boardId: mongoEq(boardId),
      type: mongoEq(type),
    },
    {
      $set: {
        itemId: mongoEq(itemId),
        workspaceId: mongoEq(workspaceId),
        boardId: mongoEq(boardId),
        invoiceNumber: mongoEq(invoiceNumber),
        type: mongoEq(type),
        pdfLink,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, new: true },
  );
}

/**
 * Record an invoice number against an item, and mark the item as invoiced.
 *
 * The marking is section 3.3 of the invoice selection spec: manual invoice
 * generation must set the same marker as the automated run, or the next
 * scheduled run finds those items unmarked and bills them again. This function
 * is where it belongs because it is the single point every path that allocates
 * an invoice number already passes through — the manual NDIS and SaH webhook
 * generators, the Xero routes, and the scheduled generator.
 *
 * `claimItemsForInvoice` rather than an unconditional set, so a second document
 * covering the same item (typically the Xero push following the PDF run) does
 * not overwrite the claim naming the invoice the participant received. Either
 * marker excludes the item from selection, so the guard holds either way.
 *
 * A refusal is warned about rather than passed over. Keeping the first claim is
 * the right call, but a refusal means a second document now exists for work
 * that was already billed — and the only evidence of it used to be that nothing
 * changed. The common case is benign (the Xero push recording the same number
 * the PDF run allocated, which the claim treats as idempotent and does not
 * refuse), so this only fires when the holder is a genuinely different invoice.
 *
 * ## Why the claim is first and the ledger row second
 *
 * Section 3.4 wants both writes to succeed or fail together, and says that
 * where the design forces a choice, prefer leaving items unbilled — an unbilled
 * item is recoverable on the next run, a double-billed participant is not.
 *
 * This function used to write the ledger row first and mark second, which fails
 * in exactly the wrong direction: the "invoice written, marking fails" row of
 * the spec's table, whose consequence is that the next scheduled run selects the
 * item again and bills the participant twice. The order is now the one
 * utils/automationInvoiceClaim.js already uses — claim, then record.
 *
 * Neither write is retried and neither throws, because by the time this is
 * called the document already exists and has usually been sent; failing the
 * request would not un-send it. What the ordering buys is which half survives a
 * partial failure, and a marked item with no ledger row is the safe half: it is
 * excluded from every future run, so nobody is billed twice, and the missing row
 * is visible (an `invoicedBy` with no matching `invoicenumber` document) and
 * repairable. A ledger row with no marker is neither.
 *
 * So a failed claim skips the ledger write, and a failed ledger write does NOT
 * release the claim. Releasing it would hand the item straight back to the next
 * run — the double bill this ordering exists to prevent.
 * `generateUnderClaim` keeps its claim on a ledger failure for exactly this
 * reason; see the note on `record` there.
 */
export async function saveInvoiceNumber(workspaceId, boardId, itemId, invoiceNumber, type, pdfLink = null) {
  try {
    const { rejected } = await claimItemsForInvoice({
      workspaceId, boardId, itemIds: [itemId], invoiceNumber, periodKey: null,
    });
    if (rejected.length > 0) await warnAlreadyInvoiced({ workspaceId, boardId, itemId, invoiceNumber, type });
  } catch (err) {
    // The claim did not land, so the ledger row is not written either. Writing
    // it here would produce the one state section 3.4 rules out — a recorded
    // invoice for an unmarked item, which the next run bills again. A refusal
    // is different and does not come through here: the item is marked, by an
    // earlier invoice, and the second document is still worth recording.
    warn('Webhook-Service', 'Failed to mark item as invoiced; the invoice number was not recorded either', {
      workspaceId, boardId, itemId, invoiceNumber, type, error: err.message,
    }, {});
    return;
  }

  try {
    await writeInvoiceNumberRow({ workspaceId, boardId, itemId, invoiceNumber, type, pdfLink });
  } catch (err) {
    warn('Webhook-Service', 'Failed to save invoice number to database', {
      workspaceId, boardId, itemId, invoiceNumber, type, error: err.message,
    }, {});
  }
}
