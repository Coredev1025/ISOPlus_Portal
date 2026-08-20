import { describe, it, expect } from 'vitest';

import {
  INVOICE_TYPE_IMS_JOB_MANAGEMENT,
  INVOICE_TYPE_NDIS_CERTIFICATION,
  INVOICE_TYPE_NDIS_VERIFICATION,
  INVOICE_TYPE_SAH,
  INVOICE_TYPE_SAH_LOW_CAT,
} from '../../../src/constants/invoiceSelection.js';
import {
  isItemInvoiceable,
  selectInvoiceableItems,
} from '../../../src/utils/invoiceItemSelection.js';

/**
 * Selection is the rule in section 2.1 of the invoice selection spec: an item
 * belongs on a run's invoice when EITHER of its two date fields falls in the
 * period AND its status is one of the type's qualifying values.
 *
 * The period arrives as ISO instants because that is what
 * schedulePeriodServiceDeliveryWindow already produces — the timezone day
 * boundary is resolved upstream by startOfDayInstant, so nothing here
 * hardcodes a zone.
 */

// January is +11:00 in Sydney (daylight saving), July is +10:00. Both windows
// are used below, because a plain string comparison passes one and fails the
// other, which is the bug section 2.5 warns about.
const JAN_PERIOD = {
  start: '2025-01-01T00:00:00.000+11:00',
  end: '2025-01-31T23:59:59.999+11:00',
};
const JUL_PERIOD = {
  start: '2025-07-01T00:00:00.000+10:00',
  end: '2025-07-31T23:59:59.999+10:00',
};

const ndisItem = (data) => ({ itemId: 'i1', data });
const sahItem = (data) => ({ itemId: 's1', data });

describe('isItemInvoiceable — NDIS certification and verification', () => {
  it('includes a Completed shift whose actual start falls in the period', () => {
    const item = ndisItem({
      'Job Status': 'Completed',
      'Actual Shift Start Date and Time': '2025-01-07T11:00:00.000000+11:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_NDIS_CERTIFICATION, JAN_PERIOD)).toBe(true);
  });

  it('includes a Cancelled shift on its scheduled date when there is no actual date', () => {
    const item = ndisItem({
      'Job Status': 'Cancelled',
      'Scheduled Shift Start Date & Time': '2025-01-09T09:00:00.000000+11:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_NDIS_CERTIFICATION, JAN_PERIOD)).toBe(true);
  });

  it('includes an item when only the SECOND of its two date fields is in the period', () => {
    // The OR in 2.1: scheduled sits outside, actual sits inside. Selecting on
    // the primary field alone would silently drop this row.
    const item = ndisItem({
      'Job Status': 'Completed',
      'Scheduled Shift Start Date & Time': '2024-12-28T09:00:00.000000+11:00',
      'Actual Shift Start Date and Time': '2025-01-02T09:00:00.000000+11:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_NDIS_CERTIFICATION, JAN_PERIOD)).toBe(true);
  });

  it('excludes a status outside the qualifying set even when the date matches', () => {
    const item = ndisItem({
      'Job Status': 'Scheduled',
      'Actual Shift Start Date and Time': '2025-01-07T11:00:00.000000+11:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_NDIS_CERTIFICATION, JAN_PERIOD)).toBe(false);
  });

  it('excludes an item whose both dates fall outside the period', () => {
    const item = ndisItem({
      'Job Status': 'Completed',
      'Scheduled Shift Start Date & Time': '2024-12-20T09:00:00.000000+11:00',
      'Actual Shift Start Date and Time': '2024-12-21T09:00:00.000000+11:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_NDIS_CERTIFICATION, JAN_PERIOD)).toBe(false);
  });

  it('applies the same rule to verification as to certification', () => {
    const item = ndisItem({
      'Job Status': 'Cancelled',
      'Actual Shift Start Date and Time': '2025-01-07T11:00:00.000000+11:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_NDIS_VERIFICATION, JAN_PERIOD)).toBe(true);
  });
});

describe('isItemInvoiceable — both field spellings (section 2.4)', () => {
  it('reads the ampersand spelling of a field the constants name with "and"', () => {
    const item = ndisItem({
      'Job Status': 'Completed',
      'Actual Shift Start Date & Time': '2025-01-07T11:00:00.000000+11:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_NDIS_CERTIFICATION, JAN_PERIOD)).toBe(true);
  });

  it('reads the "and" spelling of a field the constants name with an ampersand', () => {
    const item = ndisItem({
      'Job Status': 'Cancelled',
      'Scheduled Shift Start Date and Time': '2025-01-09T09:00:00.000000+11:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_NDIS_CERTIFICATION, JAN_PERIOD)).toBe(true);
  });
});

describe('isItemInvoiceable — daylight saving (section 2.5)', () => {
  it('keeps a July shift inside a July period, where the offset is +10:00', () => {
    const item = ndisItem({
      'Job Status': 'Completed',
      'Actual Shift Start Date and Time': '2025-07-15T11:00:00.000000+10:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_NDIS_CERTIFICATION, JUL_PERIOD)).toBe(true);
  });

  it('excludes the last instant before a period begins, across the offset change', () => {
    // 2025-06-30T23:59+10:00 is before the July window opens. Comparing the
    // strings would read "2025-06-30..." < "2025-07-01..." correctly here, but
    // the instant comparison is what stays correct when the offsets differ.
    const item = ndisItem({
      'Job Status': 'Completed',
      'Actual Shift Start Date and Time': '2025-06-30T23:59:00.000000+10:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_NDIS_CERTIFICATION, JUL_PERIOD)).toBe(false);
  });

  it('treats an item written with a different offset than the period as the same instant', () => {
    // 2025-01-01T00:30+11:00 is 2024-12-31T13:30Z — inside the January window.
    // Expressed as +10:00 the same instant reads 2024-12-31T23:30, which a
    // string comparison would place before the period start.
    const item = ndisItem({
      'Job Status': 'Completed',
      'Actual Shift Start Date and Time': '2024-12-31T23:30:00.000000+10:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_NDIS_CERTIFICATION, JAN_PERIOD)).toBe(true);
  });
});

describe('isItemInvoiceable — SaH and SaH Low Cat', () => {
  const SAH_STATUSES = [
    'Cancelled - To be claimed and invoiced if applicable',
    'Delivered - To be claimed and invoiced',
    'Adjustment (Refund) - To be claimed and invoiced.',
    'Adjustment (Charge) - To be claimed and invoiced.',
  ];

  it.each(SAH_STATUSES)('qualifies on transaction status %s', (status) => {
    const item = sahItem({
      'Transaction Status': status,
      'Scheduled Shift Start Date & Time': '2025-01-07T11:00:00.000000+11:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_SAH, JAN_PERIOD)).toBe(true);
  });

  it('matches the delivered status whether or not it carries a trailing period', () => {
    // The spec lists it without, the code constant carries one. Selection must
    // not depend on which spelling reached the database.
    const item = sahItem({
      'Transaction Status': 'Delivered - To be claimed and invoiced.',
      'Scheduled Shift Start Date & Time': '2025-01-07T11:00:00.000000+11:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_SAH, JAN_PERIOD)).toBe(true);
  });

  it('selects on the actual END date, not the actual start, for SaH', () => {
    const item = sahItem({
      'Transaction Status': 'Delivered - To be claimed and invoiced.',
      'Actual Shift Start Date & Time': '2024-12-20T09:00:00.000000+11:00',
      'Actual Shift End Date & Time': '2025-01-05T17:00:00.000000+11:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_SAH, JAN_PERIOD)).toBe(true);
  });

  it('excludes a SaH status that is not one of the four qualifying values', () => {
    const item = sahItem({
      'Transaction Status': 'Delivered - Not to be claimed',
      'Scheduled Shift Start Date & Time': '2025-01-07T11:00:00.000000+11:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_SAH, JAN_PERIOD)).toBe(false);
  });

  it('applies the same configuration to Low Cat as to SaH', () => {
    const item = sahItem({
      'Transaction Status': 'Delivered - To be claimed and invoiced.',
      'Scheduled Shift Start Date & Time': '2025-01-07T11:00:00.000000+11:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_SAH_LOW_CAT, JAN_PERIOD)).toBe(true);
  });
});

describe('isItemInvoiceable — IMS Job Management is deliberately unconfigured', () => {
  it('throws rather than guessing conditions the spec has not supplied', () => {
    const item = { itemId: 'x', data: { 'Job Status': 'Completed' } };
    expect(() => isItemInvoiceable(item, INVOICE_TYPE_IMS_JOB_MANAGEMENT, JAN_PERIOD))
      .toThrow(/IMS Job Management/i);
  });

  it('throws on an unknown invoice type rather than billing nothing silently', () => {
    const item = { itemId: 'x', data: {} };
    expect(() => isItemInvoiceable(item, 'not-a-type', JAN_PERIOD)).toThrow(/unknown invoice type/i);
  });
});

describe('isItemInvoiceable — malformed data', () => {
  it('excludes an item with no date fields at all', () => {
    expect(isItemInvoiceable(ndisItem({ 'Job Status': 'Completed' }), INVOICE_TYPE_NDIS_CERTIFICATION, JAN_PERIOD))
      .toBe(false);
  });

  it('excludes an item whose date does not parse', () => {
    const item = ndisItem({
      'Job Status': 'Completed',
      'Actual Shift Start Date and Time': 'not a date',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_NDIS_CERTIFICATION, JAN_PERIOD)).toBe(false);
  });

  it('excludes an item with an empty-string date rather than treating it as the epoch', () => {
    const item = ndisItem({
      'Job Status': 'Completed',
      'Actual Shift Start Date and Time': '',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_NDIS_CERTIFICATION, JAN_PERIOD)).toBe(false);
  });

  it('reads a status held as a label object rather than a plain string', () => {
    const item = ndisItem({
      'Job Status': { label: 'Completed' },
      'Actual Shift Start Date and Time': '2025-01-07T11:00:00.000000+11:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_NDIS_CERTIFICATION, JAN_PERIOD)).toBe(true);
  });
});

describe('selectInvoiceableItems', () => {
  const inPeriod = ndisItem({
    'Job Status': 'Completed',
    'Actual Shift Start Date and Time': '2025-01-07T11:00:00.000000+11:00',
  });
  const outOfPeriod = {
    itemId: 'i2',
    data: {
      'Job Status': 'Completed',
      'Actual Shift Start Date and Time': '2024-11-07T11:00:00.000000+11:00',
    },
  };

  it('returns only the qualifying items', () => {
    const selected = selectInvoiceableItems(
      [inPeriod, outOfPeriod], INVOICE_TYPE_NDIS_CERTIFICATION, JAN_PERIOD,
    );
    expect(selected.map((i) => i.itemId)).toEqual(['i1']);
  });

  it('excludes an item already claimed by an invoice (section 3)', () => {
    const claimed = {
      itemId: 'i3',
      invoicedBy: 'INV-1194 (ISO+™)',
      data: {
        'Job Status': 'Completed',
        'Actual Shift Start Date and Time': '2025-01-07T11:00:00.000000+11:00',
      },
    };
    const selected = selectInvoiceableItems(
      [inPeriod, claimed], INVOICE_TYPE_NDIS_CERTIFICATION, JAN_PERIOD,
    );
    expect(selected.map((i) => i.itemId)).toEqual(['i1']);
  });

  it('does not mutate the array it is given', () => {
    const items = [inPeriod, outOfPeriod];
    selectInvoiceableItems(items, INVOICE_TYPE_NDIS_CERTIFICATION, JAN_PERIOD);
    expect(items).toHaveLength(2);
  });

  it('returns an empty array for no input rather than throwing', () => {
    expect(selectInvoiceableItems([], INVOICE_TYPE_NDIS_CERTIFICATION, JAN_PERIOD)).toEqual([]);
  });
});
