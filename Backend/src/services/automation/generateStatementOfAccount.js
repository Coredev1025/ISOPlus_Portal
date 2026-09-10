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
import {
  GENERATED_DOCUMENT_PUBLIC_READ,
  GENERATED_PDF_URL_EXPIRY_SECONDS,
  OUTPUT_TYPE,
} from '../../constants/storage.js';
import { buildOutputKey } from '../../utils/s3OutputKey.js';
import { buildStatementDocument } from '../../utils/statementOfAccountDocument.js';
import {
  buildStatementLedger,
  collectPayments,
  hasStatementActivity,
} from '../../utils/statementLedger.js';
import { invoicesFromDocuments, openingBalanceBefore } from '../../utils/statementAccountHistory.js';
import { renderStatementOfAccountPdf } from '../../utils/statementOfAccountPdf.js';
import { findParticipantProfile } from '../email/recipients.js';
import { getS3FileUrl, uploadFileToS3 } from '../../utils/uploadS3.js';
import { mongoEq } from '../../utils/securityHelpers.js';
import { info, warn } from '../../utils/logger.js';

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
 * The service records that may carry a payment.
 *
 * Board-scoped rather than workspace-scoped, matching the run: a statement is
 * generated per board, and money entered on another board belongs to that
 * board's statement.
 */
async function participantPaymentItems(workspaceId, boardId, participant, nameField) {
  return Item.find({
    workspaceId: mongoEq(String(workspaceId)),
    boardId: mongoEq(String(boardId)),
    [`data.${nameField}`]: mongoEq(String(participant)),
  }).select('data invoicedBy').lean();
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
  const invoices = await participantInvoices(workspaceId, boardId, participant);
  const items = await participantPaymentItems(workspaceId, boardId, participant, nameField);
  const openingBalance = openingBalanceBefore(invoices, collectPayments(items), period.start);
  const { ledger, ageing } = buildStatementLedger({
    invoices, items, period, openingBalance, timezone,
  });

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
