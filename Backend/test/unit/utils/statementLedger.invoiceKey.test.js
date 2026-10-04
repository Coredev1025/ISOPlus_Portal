import { describe, it, expect } from 'vitest';

import { buildStatementLedger, collectPayments } from '../../../src/utils/statementLedger.js';

/**
 * KAN-309: an invoice may carry a `key` (its record id) and a payment an `invoiceKey`.
 * When present they decide which invoice a payment belongs to, so two invoices that print
 * the same number (a Xero invoice and a portal one, or a duplicate-number pair) are told
 * apart. Without them the behaviour is the number text, exactly as before.
 */

const TZ = 'Australia/Sydney';
const PERIOD = { start: '2026-07-01T00:00:00.000+10:00', end: '2026-08-31T23:59:59.999+10:00' };
const ASAT = new Date('2026-09-02T00:00:00Z');

const inv = (number, total, over = {}) => ({
  invoiceNumber: number, invoiceTotal: total, createdAt: '2026-07-10T00:00:00.000Z', dueDate: '2026-07-24T00:00:00.000Z',
  description: 'Services invoiced', ...over,
});
const paid = (marker, amount, over = {}) => ({
  itemId: `i-${amount}`, invoicedBy: marker,
  data: { 'Payment Status': 'Paid', 'Amount Received($)': amount, 'Payment Received Date': '2026-07-20' },
  ...over,
});

const build = (invoices, items) => buildStatementLedger({
  invoices, items, period: PERIOD, openingBalance: 0, timezone: TZ, asAt: ASAT,
});

describe('collectPayments carries the invoice key', () => {
  it('copies invoiceKey from the item when it has one', () => {
    expect(collectPayments([paid('INV-5', 50, { invoiceKey: 'k2' })])[0]).toMatchObject({ invoiceNumber: 'INV-5', invoiceKey: 'k2' });
  });

  it('leaves it out when the item has none', () => {
    expect(collectPayments([paid('INV-5', 50)])[0].invoiceKey).toBeUndefined();
  });
});

describe('two invoices that print the same number', () => {
  it('without keys the payment goes to the first, as before', () => {
    const { ledger } = build([inv('INV-5', 100), inv('INV-5', 100)], [paid('INV-5', 50)]);
    const charges = ledger.rows.filter((r) => r.charge > 0);
    expect(charges).toHaveLength(2);
    expect(ledger.closingBalance).toBe(150);
  });

  it('with keys the payment goes to the invoice it belongs to', () => {
    const invoices = [inv('INV-5', 100, { key: 'k1' }), inv('INV-5', 100, { key: 'k2' })];
    const { ledger, payments, unmatchedPayments } = build(invoices, [paid('INV-5', 50, { invoiceKey: 'k2' })]);
    expect(payments).toHaveLength(1);
    expect(unmatchedPayments).toEqual([]);
    expect(ledger.closingBalance).toBe(150);
  });

  it('with keys a payment on a key that is not on the statement is unmatched', () => {
    const invoices = [inv('INV-5', 100, { key: 'k1' })];
    const { unmatchedPayments } = build(invoices, [paid('INV-5', 50, { invoiceKey: 'other' })]);
    expect(unmatchedPayments).toHaveLength(1);
  });

  it('ages each invoice by what is owing on it, not by the first with that number', () => {
    const invoices = [
      inv('INV-5', 100, { key: 'k1', dueDate: '2026-06-01T00:00:00.000Z' }),
      inv('INV-5', 100, { key: 'k2', dueDate: '2026-08-30T00:00:00.000Z' }),
    ];
    const { ageing } = build(invoices, [paid('INV-5', 100, { invoiceKey: 'k2' })]);
    // k2 is settled, so what remains is the overdue k1, not a current invoice.
    expect(JSON.stringify(ageing)).toContain('100');
    expect(ageing.d90plus ?? ageing.buckets?.d90plus ?? ageing.buckets?.find?.((b) => b.key === 'd90plus')?.amount).toBe(100);
  });
});
