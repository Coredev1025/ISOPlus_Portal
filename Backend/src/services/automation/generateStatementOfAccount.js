/**
 * The statement of account, for one participant and one period.
 *
 * Section 4 of the invoice selection spec. It runs alongside the NDIS monthly
 * statement rather than replacing it: that document reports plan budget
 * against services delivered, this one reports money — invoiced, paid, owing,
 * and how overdue. A statement run produces both.
 *
 * Everything printed here is carried through from a document already raised.
 * Charges come from the `invoiceTotal` the invoice generators recorded on the
 * PDFLink row, never from re-adding source items, because the Age Care total
 * is the participant contribution on most boards and the full service amount
 * on Low Cat — recomputing it here would mean keeping that branch correct in a
 * second place.
 */

import { uniqBy } from 'lodash-es';

import Business from '../../models/Business.js';
import Item from '../../models/Item.js';
import PDFLink from '../../models/PDFLink.js';
import {
  PDFLINK_TYPE_AGE_CARE_INVOICE,
  PDFLINK_TYPE_NDIS_INVOICE,
  PDFLINK_TYPE_STATEMENT_OF_ACCOUNT,
} from '../../constants/automation.js';
import { ATTRIBUTE_NAMES } from '../../constants/monthlyStatementAttributes.js';
import {
  GENERATED_DOCUMENT_PUBLIC_READ,
  GENERATED_PDF_URL_EXPIRY_SECONDS,
  OUTPUT_TYPE,
} from '../../constants/storage.js';
import { buildOutputKey } from '../../utils/s3OutputKey.js';
import { buildStatementDocument } from '../../utils/statementOfAccountDocument.js';
import {
  buildStatementLedger,
  hasStatementActivity,
} from '../../utils/statementLedger.js';
import { invoicesFromDocuments } from '../../utils/statementAccountHistory.js';
import { getLogoData } from '../../utils/invoicePdfSupport.js';
import { renderStatementOfAccountPdf } from '../../utils/statementOfAccountPdf.js';
import { findParticipantProfile } from '../email/recipients.js';
import { getS3FileUrl, uploadFileToS3 } from '../../utils/uploadS3.js';
import { mongoEq } from '../../utils/securityHelpers.js';
import { info, warn } from '../../utils/logger.js';
import { READ_MODE, UNEXPECTED_SHADOW_CLASSES } from '../../constants/invoiceLedger.js';
import { invoiceLedgerReadMode } from '../../utils/invoiceLedger/flags.js';
import { activeForItems, forParticipant } from '../../utils/invoiceLedger/read.js';
import { invoicesFromLedger, itemsOnActiveInvoices, unusableInvoices } from '../../utils/invoiceLedger/statementSource.js';
import { withoutDeletedDocuments } from '../../utils/invoiceLedger/deletedDocuments.js';
import { compareStatementInputs } from '../../utils/invoiceLedger/shadow.js';

/** The itemId a statement of account is filed under, distinct from the budget statement's. */
export function statementOfAccountItemId(boardId, participant) {
  return `statement-of-account:${boardId}:${participant}`;
}

/**
 * Every invoice ever raised on this board for this participant, not only this
 * period's.
 *
 * Ageing needs the old unpaid ones — that is what the 90+ bucket is for — and
 * the opening balance needs everything before the period opened. Board-scoped
 * to match the payments below: with the invoices read across the workspace, a
 * participant on two eligible boards had both boards' charges on each
 * statement and only one board's payments applied against them.
 *
 * One row per document, not per row. `recordPdfLinks` writes a PDFLink row per
 * itemId and stamps the whole invoice's `invoiceTotal` on every one of them, so
 * an invoice covering N shifts arrives here as N rows of the full amount. Left
 * undeduped it charges the participant N times — and with no payment recorded
 * the ageing buckets scale by the same N, so section 4.3's and 4.4's checks
 * both pass and the overstated statement renders. `pdfLink` is the document
 * identity the rest of the codebase already uses (`uniquePdfResults`, and the
 * `$group: { _id: '$pdfLink' }` behind recent documents); `invoiceNumber` is a
 * weaker key because a hand-raised row may carry none. A row with no `pdfLink`
 * at all falls back to its own `_id` so that legacy rows stand alone rather
 * than collapsing into one another on a shared null.
 */
async function participantInvoices(workspaceId, boardId, participant) {
  const rows = await PDFLink.find({
    workspaceId: mongoEq(String(workspaceId)),
    boardId: mongoEq(String(boardId)),
    participant: mongoEq(String(participant)),
    type: { $in: [PDFLINK_TYPE_NDIS_INVOICE, PDFLINK_TYPE_AGE_CARE_INVOICE] },
    isDeleted: { $ne: true },
  }).select('type invoiceNumber invoiceTotal invoiceDate createdAt pdfLink').lean();
  return invoicesFromDocuments(uniqBy(rows, (row) => row.pdfLink ?? row._id));
}

/**
 * Service records whose own reference chain resolves to `participant`, found
 * via `Participant Profile` rather than the shift's free-text name copy.
 *
 * KAN-275: `data[nameField]` is a free-text field an operator can hand-edit on
 * the shift itself, independent of who the shift is actually for — live data
 * showed it drifted to a stale fragment ("Maso") of the real name while the
 * shift's own `Participant Profile` reference still correctly pointed at the
 * real participant. That reference is the same one already used, successfully,
 * to resolve a shift's true participant elsewhere — NDIS invoice generation
 * (`ndisInvoiceGeneratorRouteHelpers.js`), the Age Care invoice generator
 * (`invoiceGeneratorRouteHelpers.js`) and the monthly statement
 * (`monthlyStatementRouteHelpers.js`) all read it, and it is populated the same
 * way regardless of board type. `Service Plan` was the other candidate chain
 * (Master Plan item -> Service Plan -> its own `Participant Intake Form`
 * reference), but it is NDIS-specific — Age Care items carry no `Service Plan`
 * at all — and adds a second, independently-optional hop: a Service Plan
 * record with no `Participant Intake Form` reference resolves to null rather
 * than throwing, so the chain can go missing even when the Master Plan item's
 * own `Participant Profile` is intact.
 *
 * `findParticipantProfile` resolves `participant` to their profile item the
 * same way the statement's own recipient lookup already does, so a shift and
 * the statement it appears on can never disagree about which profile record
 * is authoritative. No profile found means no items can be found via the
 * reference chain — the caller still has whatever the free-text match above
 * returned.
 */
async function participantPaymentItemsByProfile(workspaceId, boardId, participant) {
  const profile = await findParticipantProfile(String(workspaceId), String(boardId), String(participant));
  if (!profile) return [];
  const profileId = mongoEq(profile.itemId);
  const profileField = `data.${ATTRIBUTE_NAMES.PARTICIPANT_PROFILE}`;
  return Item.find({
    workspaceId: mongoEq(String(workspaceId)),
    boardId: mongoEq(String(boardId)),
    // The reference is stored as either an array of plain ids or an array of
    // `{ id }` objects (see `extractRefId` in ndisServiceRecords.js) —
    // matched here rather than resolved in application code so the lookup
    // stays a single indexed-scope query instead of a full board scan.
    $or: [{ [profileField]: profileId }, { [`${profileField}.id`]: profileId }],
  }).select('itemId data invoicedBy').lean();
}

/**
 * The service records that may carry a payment.
 *
 * Board-scoped rather than workspace-scoped, matching the run: a statement is
 * generated per board, and money entered on another board belongs to that
 * board's statement.
 *
 * Two independent ways in, unioned: the shift's own free-text copy of the
 * name (cheap, and still correct for the common case where it was never
 * hand-edited after sync) and the reference chain (KAN-275, above), which
 * catches a shift whose free text has drifted. `uniqBy` guards a shift that
 * matches both — its payment must be counted once, not twice.
 */
async function participantPaymentItems(workspaceId, boardId, participant, nameField) {
  const [byText, byProfile] = await Promise.all([
    Item.find({
      workspaceId: mongoEq(String(workspaceId)),
      boardId: mongoEq(String(boardId)),
      [`data.${nameField}`]: mongoEq(String(participant)),
    }).select('itemId data invoicedBy').lean(),
    participantPaymentItemsByProfile(workspaceId, boardId, participant),
  ]);
  return uniqBy([...byText, ...byProfile], (item) => String(item._id));
}

/**
 * The statement's inputs from the invoice record (KAN-309): its invoices, and the payment
 * records with the number of the invoice each is currently on. `items` are the records
 * already read for this participant.
 */
async function inputsFromLedger({ workspaceId, boardId, participant, items }) {
  const [listed, active] = await Promise.all([
    forParticipant({ workspaceId, boardId, participant }),
    activeForItems(workspaceId, items.map((item) => item.itemId)),
  ]);
  // The same documents the old statement uses: one whose documents were all deleted is out.
  const { kept, excluded } = await withoutDeletedDocuments(workspaceId, boardId, listed);
  const unusable = unusableInvoices(kept);
  if (unusable.length > 0 || excluded.length > 0) {
    warn('InvoiceLedger', 'Invoices left out of the statement', {
      workspaceId, boardId, participant,
      withoutTotalOrDate: unusable.map((inv) => inv.number),
      deletedDocuments: excluded.map((inv) => inv.number),
    });
  }
  return { invoices: invoicesFromLedger(kept), items: itemsOnActiveInvoices(items, active) };
}

/** Shadow mode: build the statement both ways and log every difference with its class. */
async function logShadowDifferences({
  legacy, scope, period, timezone, asAt, periodKey,
}) {
  try {
    const ledger = await inputsFromLedger({ ...scope, items: legacy.items });
    const result = compareStatementInputs({
      legacy, ledger, period, asAt, timezone,
    });
    const context = {
      workspaceId: scope.workspaceId, boardId: scope.boardId, participant: scope.participant, periodKey,
    };
    // Expected classes are informational; an unexpected one warns, which is what the gate watches.
    for (const difference of result.differences) {
      const log = UNEXPECTED_SHADOW_CLASSES.includes(difference.class) ? warn : info;
      log('InvoiceLedger', 'Shadow difference', { ...difference, ...context });
    }
    info('InvoiceLedger', 'Shadow summary', {
      ...context, differences: result.differences.length, unexpected: result.unexpected, closing: result.closing,
    });
  } catch (err) {
    warn('InvoiceLedger', 'Statement could not be compared with the invoice record', {
      workspaceId: scope.workspaceId, boardId: scope.boardId, participant: scope.participant, message: err.message,
    });
  }
}

/**
 * The invoices and payment records the statement is built from, by `INVOICE_LEDGER_READ`:
 * `off` the old stores, `shadow` the old stores with the differences from the invoice
 * record logged, `on` the invoice record.
 */
async function statementInputs({
  scope, nameField, period, timezone, asAt, periodKey,
}) {
  const { workspaceId, boardId, participant } = scope;
  const mode = invoiceLedgerReadMode();
  const items = await participantPaymentItems(workspaceId, boardId, participant, nameField);
  if (mode === READ_MODE.ON) return inputsFromLedger({ ...scope, items });

  const legacy = { invoices: await participantInvoices(workspaceId, boardId, participant), items };
  if (mode === READ_MODE.SHADOW) {
    await logShadowDifferences({
      legacy, scope, period, timezone, asAt, periodKey,
    });
  }
  return legacy;
}

/**
 * The business letterhead image, or nothing.
 *
 * KAN-229: the statement of account was the only document type that never
 * showed the logo, because nothing on this path ever called `getLogoData`.
 *
 * The invoice path lets a failed read throw. A statement must not: it is
 * generated per participant inside a scheduled run, and
 * `settledStatementOfAccount` catches whatever a statement throws and carries
 * on with the board — so an unreadable logo object would not fail loudly, it
 * would silently produce no statement of account at all, for every
 * participant, while the budget statement beside it still went out. A
 * letterhead image is cosmetic; the account it states is not.
 */
async function providerLogo(business) {
  if (!business?.defaultLogo) return '';
  try {
    return await getLogoData(business);
  } catch (err) {
    warn('Automation', 'Default logo could not be read; statement of account header falls back to text', {
      workspaceId: business.workspaceId, defaultLogo: business.defaultLogo, reason: err?.message,
    });
    return '';
  }
}

async function uploadStatement(pdfBytes, { workspaceId, boardId, participant, periodKey }) {
  const slug = String(participant).replace(/[^a-zA-Z0-9]/g, '-');
  const key = buildOutputKey({
    workspaceId,
    boardId,
    type: OUTPUT_TYPE.STATEMENT_OF_ACCOUNT,
    name: `${slug}_${periodKey}_StatementOfAccount.pdf`,
  });
  const result = await uploadFileToS3(Buffer.from(pdfBytes), key, GENERATED_DOCUMENT_PUBLIC_READ);
  if (result?.$metadata?.httpStatusCode !== 200) {
    throw new Error('Upload of statement of account failed');
  }
  return getS3FileUrl(key, GENERATED_PDF_URL_EXPIRY_SECONDS, GENERATED_DOCUMENT_PUBLIC_READ);
}

/**
 * Generate and file one statement of account, or nothing.
 *
 * Returns null when section 4.5 says there is nothing to send, so the caller
 * can tell "no statement" from "a statement with no rows" without inspecting
 * the ledger itself.
 *
 * `claimStatementNumber` is a function, not a number, so the sequence is only
 * consumed once there is a statement to put it on. Passing the number in would
 * burn one on every participant with no activity, and the ISO+ boards are full
 * of profiles that were never invoiced.
 */
export async function generateStatementOfAccount({
  workspaceId, boardId, participant, period, timezone, periodKey, claimStatementNumber, nameField,
}) {
  const asAt = new Date();
  const { invoices, items } = await statementInputs({
    scope: { workspaceId, boardId, participant }, nameField, period, timezone, asAt, periodKey,
  });
  // KAN-274: every invoice and payment ever recorded now becomes its own line
  // item (see chargeRows/paymentRows in statementLedger.js), not only this
  // period's — so there is nothing left for an opening balance to carry
  // forward without counting the same invoice twice. `asAt` is the actual
  // moment of generation, not the period's own end: a statement's period is a
  // fixed calendar boundary computed ahead of time, and an invoice for that
  // same period is generated one cycle later, so it is always dated just
  // after that boundary. Using the real "now" is what lets this statement see
  // an invoice generated moments — or cycles — before it, rather than only
  // ever catching up one statement late.
  const { ledger, ageing, unmatchedPayments } = buildStatementLedger({
    invoices, items, period, openingBalance: 0, timezone, asAt,
  });

  // KAN-286: money recorded against an invoice this participant has no record
  // of is left off the statement. Said here, so it is not a silent omission.
  if (unmatchedPayments.length > 0) {
    warn('Automation', 'Payments left off the statement: no matching invoice for this participant', {
      workspaceId,
      boardId,
      participant,
      periodKey,
      payments: unmatchedPayments.map((p) => ({ invoiceNumber: p.invoiceNumber, amount: p.amount })),
    });
  }

  if (!hasStatementActivity(ledger)) {
    info('Automation', 'No account activity; no statement of account', {
      workspaceId, boardId, participant, periodKey,
    });
    return null;
  }

  const statementNumber = await claimStatementNumber();
  const [business, profile] = await Promise.all([
    Business.findOne({ workspaceId: mongoEq(String(workspaceId)) }).lean(),
    findParticipantProfile(String(workspaceId), String(boardId), String(participant)),
  ]);
  if (!business) {
    warn('Automation', 'No business profile; statement of account will have no provider block', {
      workspaceId, boardId, participant,
    });
  }

  const document = buildStatementDocument({
    business, profile, participant, statementNumber, period, ledger, ageing,
    logo: await providerLogo(business),
  });
  const pdfBytes = await renderStatementOfAccountPdf(document, timezone);
  const pdfUrl = await uploadStatement(pdfBytes, {
    workspaceId, boardId, participant, periodKey,
  });

  const itemId = statementOfAccountItemId(boardId, participant);
  await PDFLink.create({
    workspaceId,
    boardId,
    itemId,
    participant,
    type: PDFLINK_TYPE_STATEMENT_OF_ACCOUNT,
    periodKey,
    periodStart: period.start,
    periodEnd: period.end,
    // The same column the other generators use for the document's own number.
    invoiceNumber: statementNumber,
    // What the statement says is owing, so a later run's opening balance can be
    // checked against what the client was actually told.
    invoiceTotal: ledger.closingBalance,
    pdfLink: pdfUrl,
    createdBy: '',
    isDeleted: false,
    SignatureStatus: 'Unsigned',
  });

  info('Automation', 'Statement of account written', {
    workspaceId, boardId, participant, periodKey, statementNumber,
    closingBalance: ledger.closingBalance,
  });
  return { itemId, participant, pdfUrl, statementNumber };
}
