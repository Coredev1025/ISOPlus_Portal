import { resolveDueDate } from '../ndisInvoiceGeneratorPdfHelpers.js';
import { roundMoney } from '../statementTransactions.js';

/**
 * What the statement of account takes from the invoice record (KAN-309), in the shapes
 * `buildStatementLedger` already takes, so the ledger maths is untouched. Pure.
 */

const isDated = (value) => value !== undefined && value !== null && !Number.isNaN(new Date(value).getTime());
const hasTotal = (invoice) => invoice.total !== undefined && invoice.total !== null && Number.isFinite(Number(invoice.total));

/**
 * An invoice the statement cannot use: no numeric total (stating $0.00 for it would say
 * something false) or no valid issue date (it has no place on the ledger). The old path
 * left such rows out too.
 */
const usable = (invoice) => hasTotal(invoice) && isDated(invoice.issuedAt);

/** The invoices the statement leaves out for that reason, so the caller can say so. */
export function unusableInvoices(invoices) {
  return (invoices || []).filter((invoice) => !usable(invoice));
}

/**
 * The invoices, one per invoice (not per document row). `key` is the record id, which
 * ties a payment to its invoice even when two invoices print the same number. The number
 * printed is the plain one; a stored due date is used, else the same issue-plus-fourteen-days
 * the old path always derived.
 */
export function invoicesFromLedger(invoices) {
  return (invoices || []).filter(usable).map((invoice) => ({
    key: String(invoice._id),
    invoiceNumber: invoice.number,
    invoiceTotal: roundMoney(invoice.total),
    createdAt: invoice.issuedAt,
    dueDate: isDated(invoice.dueDate) ? invoice.dueDate : resolveDueDate(invoice.issuedAt, null),
    description: 'Services invoiced',
  }));
}

/**
 * The service records with `invoicedBy` replaced by the number of the invoice each is on,
 * and `invoiceKey` by its record id, so a payment is matched to its invoice by the record
 * and never by the text of a number. A record on no invoice keeps its marker and has no
 * key: its payment comes back as unmatched when that marker names nothing on the statement,
 * and is logged, never dropped silently.
 */
export function itemsOnActiveInvoices(items, activeByItemId) {
  return (items || []).map((item) => {
    const active = activeByItemId.get(String(item.itemId));
    return active ? { ...item, invoicedBy: active.number, invoiceKey: String(active._id) } : item;
  });
}
