import { DEFAULT_INVOICE_DUE_DAYS } from '../constants/automation.js';

export function parseReceivableDays(terms) {
  const match = String(terms || '').match(/\d+/);
  const n = match ? Number(match[0]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INVOICE_DUE_DAYS;
}

export function invoiceDatesFromSlot(slot, terms) {
  const invoiceDate = new Date(slot).toISOString();
  const due = new Date(invoiceDate);
  due.setUTCDate(due.getUTCDate() + parseReceivableDays(terms));
  return { invoiceDate, dueDate: due.toISOString() };
}
