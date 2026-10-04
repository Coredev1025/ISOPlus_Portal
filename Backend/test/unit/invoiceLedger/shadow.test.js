import { describe, it, expect } from 'vitest';

import { compareStatementInputs, closingUnexplained } from '../../../src/utils/invoiceLedger/shadow.js';

/**
 * The shadow comparison (KAN-309): the same statement built from the old stores and from
 * the invoice record, with every difference given a class. A class outside the known list
 * is the signal that stops the switch (design section 7).
 */

const PERIOD = { start: '2026-07-01T00:00:00.000+10:00', end: '2026-08-31T23:59:59.999+10:00' };
const ASAT = new Date('2026-09-02T00:00:00Z');
const TZ = 'Australia/Sydney';

const inv = (number, total, createdAt = '2026-07-10T00:00:00.000Z') => ({
  invoiceNumber: number, invoiceTotal: total, createdAt, dueDate: createdAt, description: 'Services invoiced',
});
const paid = (marker, amount, id = marker) => ({
  itemId: `i-${id}`, invoicedBy: marker,
  data: { 'Payment Status': 'Paid', 'Amount Received($)': amount, 'Payment Received Date': '2026-07-20' },
});

const compare = (legacy, ledger) => compareStatementInputs({
  legacy, ledger, period: PERIOD, asAt: ASAT, timezone: TZ,
});
const classesOf = (result) => result.differences.map((d) => d.class);

describe('compareStatementInputs', () => {
  it('finds no difference when both sides agree', () => {
    const side = { invoices: [inv('INV-1', 100)], items: [paid('INV-1', 40)] };
    const result = compare(side, side);
    expect(result.differences).toEqual([]);
    expect(result.closing).toEqual({ legacy: 60, ledger: 60 });
  });

  it('treats a suffixed legacy number and the plain ledger number as the same invoice', () => {
    const result = compare(
      { invoices: [inv('INV-24 (ISO+™)', 100)], items: [paid('INV-24 (ISO+™)', 40)] },
      { invoices: [inv('INV-24', 100)], items: [paid('INV-24', 40)] },
    );
    expect(result.differences).toEqual([]);
  });

  it('classes an invoice only the ledger has as newly visible, with its payment newly applied', () => {
    const result = compare(
      { invoices: [], items: [paid('INV-3', 100)] },
      { invoices: [inv('INV-3', 400)], items: [paid('INV-3', 100)] },
    );
    expect(classesOf(result).sort()).toEqual(['ledger_only_invoice', 'payment_newly_applied']);
    expect(result.closing).toEqual({ legacy: 0, ledger: 300 });
  });

  it('classes an invoice only the old stores have as unexpected', () => {
    const result = compare({ invoices: [inv('INV-5', 50)], items: [] }, { invoices: [], items: [] });
    expect(classesOf(result)).toEqual(['legacy_only_invoice']);
    expect(result.unexpected).toBe(1);
  });

  it('classes a changed total and a changed date as unexpected', () => {
    const result = compare(
      { invoices: [inv('INV-1', 100)], items: [] },
      { invoices: [{ ...inv('INV-1', 120, '2026-07-11T00:00:00.000Z'), dueDate: '2026-07-10T00:00:00.000Z' }], items: [] },
    );
    expect(classesOf(result).sort()).toEqual(['date_differs', 'total_differs']);
    expect(result.unexpected).toBe(2);
  });

  it('classes a payment the old side applied and the ledger does not as unexpected', () => {
    const result = compare(
      { invoices: [inv('INV-1', 100)], items: [paid('INV-1', 40)] },
      { invoices: [inv('INV-1', 100)], items: [paid('INV-77', 40)] },
    );
    expect(classesOf(result)).toContain('payment_no_longer_applied');
    expect(result.unexpected).toBeGreaterThan(0);
  });

  it('counts a payment unplaceable on both sides as a known class, not a difference of totals', () => {
    const side = { invoices: [], items: [paid('INV-8', 25)] };
    const result = compare(side, side);
    expect(classesOf(result)).toEqual(['unapplied_payment']);
    expect(result.unexpected).toBe(0);
  });

  it('counts known classes apart from unexpected ones', () => {
    const result = compare(
      { invoices: [], items: [] },
      { invoices: [inv('INV-4', 10)], items: [] },
    );
    expect(result.unexpected).toBe(0);
    expect(result.differences[0]).toMatchObject({ class: 'ledger_only_invoice', invoice: 'INV-4', total: 10 });
    expect(result.differences.some((d) => d.class === 'closing_differs')).toBe(false);
  });

  // KAN-288: two documents can share a number. The old path lists both; the record may hold
  // one or both. A different count is the design's "duplicate-number pair" class.
  it('classes a different count of invoices with one number as a known duplicate-number difference', () => {
    const result = compare(
      { invoices: [inv('INV-5', 100), inv('INV-5', 100)], items: [] },
      { invoices: [inv('INV-5', 100)], items: [] },
    );
    expect(classesOf(result)).toEqual(['duplicate_number']);
    expect(result.differences[0]).toMatchObject({ invoice: 'INV-5', legacy: 2, ledger: 1 });
    expect(result.unexpected).toBe(0);
    expect(result.closing).toEqual({ legacy: 200, ledger: 100 });

    const reverse = compare(
      { invoices: [inv('INV-5', 100)], items: [] },
      { invoices: [inv('INV-5', 100), inv('INV-5', 100)], items: [] },
    );
    expect(classesOf(reverse)).toEqual(['duplicate_number']);
  });

  it('compares the invoices of a duplicate pair one for one', () => {
    const result = compare(
      { invoices: [inv('INV-5', 100), inv('INV-5', 100)], items: [] },
      { invoices: [inv('INV-5', 100), inv('INV-5', 90)], items: [] },
    );
    expect(classesOf(result)).toEqual(['total_differs']);
  });

  // The ledger keeps the due date the operator or the schedule set; the old path always
  // derived issue plus fourteen days. A known class, counted, because it moves ageing.
  it('classes a changed due date as known', () => {
    const result = compare(
      { invoices: [{ ...inv('INV-1', 100), dueDate: '2026-07-24T00:00:00.000Z' }], items: [] },
      { invoices: [{ ...inv('INV-1', 100), dueDate: '2026-08-09T00:00:00.000Z' }], items: [] },
    );
    expect(classesOf(result)).toEqual(['due_date_differs']);
    expect(result.unexpected).toBe(0);
  });

  it('compares dates by the day in the statement timezone, not by the UTC day', () => {
    // 14:00Z and 00:00Z next day are both 10 July in Sydney (UTC+10).
    const same = compare(
      { invoices: [inv('INV-1', 100, '2026-07-09T14:00:00.000Z')], items: [] },
      { invoices: [inv('INV-1', 100, '2026-07-10T00:00:00.000Z')], items: [] },
    );
    expect(classesOf(same)).not.toContain('date_differs');
    // 13:30Z (23:30 on the 9th) and 14:30Z (00:30 on the 10th) are different Sydney days.
    const differ = compare(
      { invoices: [inv('INV-1', 100, '2026-07-09T13:30:00.000Z')], items: [] },
      { invoices: [inv('INV-1', 100, '2026-07-09T14:30:00.000Z')], items: [] },
    );
    expect(classesOf(differ)).toContain('date_differs');
  });

  it('reports a payment unmatched on the ledger side even when its marker differs from the old one', () => {
    const result = compare(
      { invoices: [], items: [paid('INV-8', 25)] },
      { invoices: [], items: [paid('INV-9', 25)] },
    );
    expect(classesOf(result)).toEqual(['unapplied_payment']);
  });

  it('flags a closing balance that differs with nothing to explain it', () => {
    expect(closingUnexplained({ legacy: 60, ledger: 70 }, [])).toBe(true);
    expect(closingUnexplained({ legacy: 60, ledger: 70 }, [{ class: 'ledger_only_invoice' }])).toBe(false);
    expect(closingUnexplained({ legacy: 60, ledger: 70 }, [{ class: 'total_differs' }])).toBe(false);
    expect(closingUnexplained({ legacy: 60, ledger: 60 }, [])).toBe(false);
  });
});
