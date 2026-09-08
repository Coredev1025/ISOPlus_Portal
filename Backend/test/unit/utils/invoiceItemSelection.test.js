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
  resolvedItemDate,
  selectInvoiceableItems,
} from '../../../src/utils/invoiceItemSelection.js';
import { computeNdisServiceDate } from '../../../src/utils/ndisMasterPlanLineHelpers.js';
import { resolveParticipantTaxRowDate } from '../../../src/utils/webhookParticipantTaxPdfHelpers.js';
import { ATTRIBUTE_NAMES } from '../../../src/constants/monthlyStatementAttributes.js';
import { formatLabelValue } from '../../../src/utils/ndisServiceRecords.js';

/**
 * The collaborators routes/webhook.js hands the participant-tax renderer,
 * reduced to the four resolveParticipantTaxRowDate actually reads.
 */
const participantTaxHelpers = (dateFmt) => ({
  getValueFromFlatData: (item, name) => item?.data?.[name] ?? null,
  attributeNames: ATTRIBUTE_NAMES,
  formatLabelValue,
  dateFmt,
});

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
  /**
   * The Master Shift Plan boards name this column "Shift Status"; the spec's
   * table names it "Job Status". The Invoice Generator list already tolerates
   * both (SHIFT_STATUS_KEYS), so selection has to as well — otherwise the list
   * returns rows selection silently drops, which is exactly the seam
   * automationItemSelection.js warns about.
   *
   * Observed on portal-dev 2026-08-26: listed=5, selected=0, dropped=5 on
   * board eNiJpH14PN3, whose column is "Shift Status".
   */
  it('reads the status from "Shift Status" as well as "Job Status"', () => {
    const item = ndisItem({
      'Shift Status': 'Completed',
      'Actual Shift Start Date and Time': '2025-01-07T11:00:00.000000+11:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_NDIS_CERTIFICATION, JAN_PERIOD)).toBe(true);
  });

  it('still drops an item whose status does not qualify under either spelling', () => {
    const item = ndisItem({
      'Shift Status': 'Scheduled',
      'Actual Shift Start Date and Time': '2025-01-07T11:00:00.000000+11:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_NDIS_CERTIFICATION, JAN_PERIOD)).toBe(false);
  });

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

  /**
   * SaH boards have no guarantee of spelling their status column
   * "Transaction Status" any more than NDIS boards spell theirs "Job Status" —
   * and unlike NDIS, STATUS_FIELD_ALIASES carried no entry at all for
   * "Transaction Status" until now, so a board naming it "Transaction status"
   * would resolve an empty status, fail every status check, and bill nothing
   * for the whole board with no error. This is exactly the "listed 5, selected
   * 0" failure already observed for Job Status (portal-dev 2026-08-26), just
   * on the SaH field instead.
   */
  it('reads the status from "Transaction status" as well as "Transaction Status"', () => {
    const item = sahItem({
      'Transaction status': 'Delivered - To be claimed and invoiced.',
      'Scheduled Shift Start Date & Time': '2025-01-07T11:00:00.000000+11:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_SAH, JAN_PERIOD)).toBe(true);
  });

  it('reads the status from "TransactionStatus" as well as "Transaction Status"', () => {
    const item = sahItem({
      TransactionStatus: 'Delivered - To be claimed and invoiced.',
      'Scheduled Shift Start Date & Time': '2025-01-07T11:00:00.000000+11:00',
    });
    expect(isItemInvoiceable(item, INVOICE_TYPE_SAH, JAN_PERIOD)).toBe(true);
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

/**
 * Section 2.3: selection and rendering must agree on which date an item HAS.
 *
 * Membership stays the OR of 2.1 — either field inside the period qualifies —
 * but the date the invoice PRINTS is resolved by status, and the renderers
 * already do that: `computeNdisServiceDate` takes the scheduled start for a
 * Cancelled NDIS shift and the actual start otherwise;
 * `resolveParticipantTaxRowDate` takes the actual end for a delivered SaH row
 * and the scheduled start otherwise.
 *
 * Without a shared resolver an NDIS Cancelled shift whose actual start is
 * inside the period and whose scheduled start is outside it is selected by
 * automation and then printed with a service date the billed period does not
 * cover. These tests pin the two to the same field.
 */
describe('resolvedItemDate (spec 2.3)', () => {
  const TZ = 'Australia/Sydney';
  const dateOnly = (value) => new Date(value).toLocaleString('en-AU', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: TZ,
  });

  const CANCELLED_SCHEDULED = '2025-01-07T11:00:00.000000+11:00';
  const CANCELLED_ACTUAL = '2025-02-19T11:00:00.000000+11:00';

  it('dates a cancelled NDIS shift by the same field the renderer prints', () => {
    const data = {
      'Job Status': 'Cancelled',
      'Scheduled Shift Start Date & Time': CANCELLED_SCHEDULED,
      'Actual Shift Start Date and Time': CANCELLED_ACTUAL,
    };

    expect(resolvedItemDate(ndisItem(data), INVOICE_TYPE_NDIS_CERTIFICATION))
      .toBe(CANCELLED_SCHEDULED);
    expect(dateOnly(resolvedItemDate(ndisItem(data), INVOICE_TYPE_NDIS_CERTIFICATION)))
      .toBe(computeNdisServiceDate(data, TZ));
  });

  it('dates a completed NDIS shift by the actual start, as the renderer does', () => {
    const data = {
      'Job Status': 'Completed',
      'Scheduled Shift Start Date & Time': CANCELLED_SCHEDULED,
      'Actual Shift Start Date and Time': CANCELLED_ACTUAL,
    };

    expect(resolvedItemDate(ndisItem(data), INVOICE_TYPE_NDIS_CERTIFICATION))
      .toBe(CANCELLED_ACTUAL);
    expect(dateOnly(resolvedItemDate(ndisItem(data), INVOICE_TYPE_NDIS_CERTIFICATION)))
      .toBe(computeNdisServiceDate(data, TZ));
  });

  it('falls back to the other field when the resolved one is empty', () => {
    const data = {
      'Job Status': 'Cancelled',
      'Actual Shift Start Date and Time': CANCELLED_ACTUAL,
    };

    expect(resolvedItemDate(ndisItem(data), INVOICE_TYPE_NDIS_CERTIFICATION))
      .toBe(CANCELLED_ACTUAL);
  });

  it('dates a delivered SaH row by the actual end, as the renderer prints it', () => {
    const data = {
      'Transaction Status': 'Delivered - To be claimed and invoiced.',
      'Scheduled Shift Start Date & Time': CANCELLED_SCHEDULED,
      // The '& Time' spelling deliberately: resolveParticipantTaxRowDate reads
      // that one only, so pinning agreement on the 'and Time' spelling would
      // pin the renderer's own 2.4 gap instead of the shared rule.
      'Actual Shift End Date & Time': CANCELLED_ACTUAL,
    };
    const item = sahItem(data);

    expect(resolvedItemDate(item, INVOICE_TYPE_SAH)).toBe(CANCELLED_ACTUAL);
    expect(dateOnly(resolvedItemDate(item, INVOICE_TYPE_SAH)))
      .toBe(resolveParticipantTaxRowDate(item, participantTaxHelpers(dateOnly)));
  });

  it('dates a cancelled SaH row by the scheduled start, as the renderer prints it', () => {
    const data = {
      'Transaction Status': 'Cancelled - To be claimed and invoiced if applicable',
      'Scheduled Shift Start Date & Time': CANCELLED_SCHEDULED,
      'Actual Shift End Date and Time': CANCELLED_ACTUAL,
    };
    const item = sahItem(data);

    expect(resolvedItemDate(item, INVOICE_TYPE_SAH)).toBe(CANCELLED_SCHEDULED);
    expect(dateOnly(resolvedItemDate(item, INVOICE_TYPE_SAH)))
      .toBe(resolveParticipantTaxRowDate(item, participantTaxHelpers(dateOnly)));
  });
});
