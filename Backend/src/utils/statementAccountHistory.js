/**
 * The account history a statement of account is built from.
 *
 * Section 4 of the invoice selection spec asks the statement to carry figures
 * through from documents already raised rather than recomputing them. The
 * documents are PDFLink rows: the scheduled generators write `invoiceTotal`
 * and `invoiceNumber` on each one precisely so this file never has to re-add
 * source items — the Age Care total is the participant contribution on most
 * boards and the full service amount on Low Cat, and replicating that branch
 * here would get it wrong the day one of them changes.
 */

import {
  PDFLINK_TYPE_AGE_CARE_INVOICE,
  PDFLINK_TYPE_NDIS_INVOICE,
} from '../constants/automation.js';
import { resolveDueDate } from './ndisInvoiceGeneratorPdfHelpers.js';
import { roundMoney } from './statementTransactions.js';

const INVOICE_TYPES = new Set([PDFLINK_TYPE_NDIS_INVOICE, PDFLINK_TYPE_AGE_CARE_INVOICE]);

const isDated = (value) => !Number.isNaN(new Date(value).getTime());

/**
 * The invoices among a participant's documents, in the shape the ledger takes.
 *
 * A row with no `invoiceTotal` is skipped rather than treated as nil: it is a
 * document written before the generators recorded the figure, and charging a
 * statement $0.00 for it would state something false. So is a row with no
 * usable `createdAt` — Mongoose defaults it, so only a hand-inserted row lacks
 * one, and without it the invoice has no place on the ledger. `dueDate` is
 * derived because PDFLink does not store one — `resolveDueDate` is the same
 * issue-plus-fourteen-days rule manual invoicing applies, so ageing here and
 * ageing on the invoice agree.
 */
export function invoicesFromDocuments(documents) {
  return (documents || [])
    .filter((row) => INVOICE_TYPES.has(row?.type)
      && row?.invoiceTotal !== undefined && row?.invoiceTotal !== null
      && isDated(row.createdAt))
    .map((row) => ({
      invoiceNumber: row.invoiceNumber ?? '',
      invoiceTotal: roundMoney(row.invoiceTotal),
      createdAt: row.createdAt,
      dueDate: resolveDueDate(row.createdAt, null),
      description: 'Services invoiced',
    }));
}

const before = (value, boundary) => {
  const at = new Date(value).getTime();
  return !Number.isNaN(at) && at < new Date(boundary).getTime();
};

/**
 * What was owing when the period opened.
 *
 * Everything charged before the boundary, less everything paid before it.
 * Derived rather than stored: a stored opening balance is a second copy of the
 * same fact, and the two disagree the first time a document is reissued.
 *
 * A payment with no date is placed on its invoice's date — the same rule
 * `statementLedger.js` applies when it nets that payment onto the charge row.
 * The two must agree on which side of the boundary the money fell, or the
 * closing balance and the ageing disagree and the statement refuses to render.
 */
export function openingBalanceBefore(invoices, payments, periodStart) {
  const raisedAt = new Map((invoices || []).map((inv) => [inv.invoiceNumber, inv.createdAt]));
  const paidAt = (p) => (isDated(p.date) ? p.date : raisedAt.get(p.invoiceNumber));
  const charged = (invoices || [])
    .filter((inv) => before(inv.createdAt, periodStart))
    .reduce((sum, inv) => sum + Number(inv.invoiceTotal || 0), 0);
  const paid = (payments || [])
    .filter((p) => before(paidAt(p), periodStart))
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
  return roundMoney(charged - paid);
}
