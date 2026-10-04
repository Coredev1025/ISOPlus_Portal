import { SHADOW_CLASS, UNEXPECTED_SHADOW_CLASSES } from '../../constants/invoiceLedger.js';
import { buildStatementLedger } from '../statementLedger.js';
import { roundMoney } from '../statementTransactions.js';
import { parseInvoiceNumber } from './numbers.js';

/**
 * The shadow comparison (KAN-309): the same statement built from the old stores and from
 * the invoice record, every difference given a class. Pure: it returns the differences and
 * the caller decides what to log. A class in UNEXPECTED_SHADOW_CLASSES stops the switch.
 */

const plain = (number) => parseInvoiceNumber(String(number ?? ''))?.number ?? String(number ?? '');

/** The calendar day of an instant in the statement's timezone, so the comparison reads dates as the statement does. */
const dayIn = (value, timezone) => {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
};

/** Invoices grouped by plain number, each group in a stable order so pairs line up. */
function groupByNumber(invoices) {
  const groups = new Map();
  for (const inv of invoices || []) {
    const key = plain(inv.invoiceNumber);
    groups.set(key, [...(groups.get(key) || []), inv]);
  }
  for (const [key, list] of groups) {
    groups.set(key, [...list].sort((a, b) => `${a.createdAt}${a.invoiceTotal}`.localeCompare(`${b.createdAt}${b.invoiceTotal}`)));
  }
  return groups;
}

/** The differences between two invoices the two sides agree are the same one. */
function pairDifferences(number, old, neu, timezone) {
  const found = [];
  if (roundMoney(old.invoiceTotal) !== roundMoney(neu.invoiceTotal)) {
    found.push({
      class: SHADOW_CLASS.TOTAL_DIFFERS, invoice: number, legacy: roundMoney(old.invoiceTotal), ledger: roundMoney(neu.invoiceTotal),
    });
  }
  if (dayIn(old.createdAt, timezone) !== dayIn(neu.createdAt, timezone)) {
    found.push({
      class: SHADOW_CLASS.DATE_DIFFERS, invoice: number, legacy: dayIn(old.createdAt, timezone), ledger: dayIn(neu.createdAt, timezone),
    });
  }
  if (dayIn(old.dueDate, timezone) !== dayIn(neu.dueDate, timezone)) {
    found.push({
      class: SHADOW_CLASS.DUE_DATE_DIFFERS, invoice: number, legacy: dayIn(old.dueDate, timezone), ledger: dayIn(neu.dueDate, timezone),
    });
  }
  return found;
}

function numberDifferences(number, oldList, neuList, timezone) {
  if (oldList.length === 0) {
    return neuList.map((inv) => ({ class: SHADOW_CLASS.LEDGER_ONLY_INVOICE, invoice: number, total: roundMoney(inv.invoiceTotal) }));
  }
  if (neuList.length === 0) {
    return oldList.map((inv) => ({ class: SHADOW_CLASS.LEGACY_ONLY_INVOICE, invoice: number, total: roundMoney(inv.invoiceTotal) }));
  }
  const paired = Math.min(oldList.length, neuList.length);
  const found = [];
  for (let i = 0; i < paired; i += 1) found.push(...pairDifferences(number, oldList[i], neuList[i], timezone));
  if (oldList.length !== neuList.length) {
    found.push({
      class: SHADOW_CLASS.DUPLICATE_NUMBER, invoice: number, legacy: oldList.length, ledger: neuList.length,
    });
  }
  return found;
}

function invoiceDifferences(legacyInvoices, ledgerInvoices, timezone) {
  const legacy = groupByNumber(legacyInvoices);
  const ledger = groupByNumber(ledgerInvoices);
  const numbers = new Set([...legacy.keys(), ...ledger.keys()]);
  return [...numbers].flatMap((number) => numberDifferences(number, legacy.get(number) || [], ledger.get(number) || [], timezone));
}

const paymentKey = (timezone) => (p) => `${plain(p.invoiceNumber)}|${p.amount}|${dayIn(p.date, timezone)}`;

/** Multiset difference: the keys in `a` beyond what `b` holds, with their multiplicity. */
function surplus(aKeys, bKeys) {
  const have = new Map();
  for (const key of bKeys) have.set(key, (have.get(key) || 0) + 1);
  const out = [];
  for (const key of aKeys) {
    if ((have.get(key) || 0) > 0) have.set(key, have.get(key) - 1);
    else out.push(key);
  }
  return out;
}

function paymentDifferences(legacy, ledger, timezone) {
  const keyOf = paymentKey(timezone);
  const legacyMatched = legacy.payments.map(keyOf);
  const ledgerMatched = ledger.payments.map(keyOf);
  const classed = (cls, keys) => keys.map((payment) => ({ class: cls, payment }));
  return [
    ...classed(SHADOW_CLASS.PAYMENT_NO_LONGER_APPLIED, surplus(legacyMatched, ledgerMatched)),
    ...classed(SHADOW_CLASS.PAYMENT_NEWLY_APPLIED, surplus(ledgerMatched, legacyMatched)),
    // Whatever the ledger leaves unmatched that the old side did not apply: reported, never dropped.
    ...classed(SHADOW_CLASS.UNAPPLIED_PAYMENT, surplus(ledger.unmatchedPayments.map(keyOf), legacyMatched)),
  ];
}

const EXPLAINS_CLOSING = [
  SHADOW_CLASS.LEDGER_ONLY_INVOICE,
  SHADOW_CLASS.PAYMENT_NEWLY_APPLIED,
  SHADOW_CLASS.DUPLICATE_NUMBER,
];

/**
 * A closing balance that differs with none of the classes that move it among the
 * differences: something changed the figure that the classification cannot see. Exported
 * for its own test; the safety net behind the class counts.
 */
export function closingUnexplained(closing, differences) {
  return roundMoney(closing.legacy) !== roundMoney(closing.ledger)
    && !differences.some((d) => EXPLAINS_CLOSING.includes(d.class))
    && !differences.some((d) => UNEXPECTED_SHADOW_CLASSES.includes(d.class));
}

export function compareStatementInputs({
  legacy, ledger, period, asAt, timezone,
}) {
  const build = (side) => buildStatementLedger({
    invoices: side.invoices, items: side.items, period, openingBalance: 0, asAt, timezone,
  });
  const old = build(legacy);
  const neu = build(ledger);
  const closing = { legacy: old.ledger.closingBalance, ledger: neu.ledger.closingBalance };
  const differences = [
    ...invoiceDifferences(legacy.invoices, ledger.invoices, timezone),
    ...paymentDifferences(old, neu, timezone),
  ];
  if (closingUnexplained(closing, differences)) differences.push({ class: SHADOW_CLASS.CLOSING_DIFFERS, ...closing });
  return {
    differences,
    unexpected: differences.filter((d) => UNEXPECTED_SHADOW_CLASSES.includes(d.class)).length,
    closing,
  };
}
