import { describe, it, expect } from 'vitest';
import {
  enrichNdisInvoiceGeneratorRows,
  buildNdisInvoicePdfClientDetails,
  buildNdisXeroInvoiceReference,
  buildMasterItemsMap,
} from '../../../src/utils/ndisInvoiceGeneratorOutput.js';

/*
 * The output/shaping end of NDIS invoicing: the line-item description the
 * participant reads on the invoice, the client block printed on the PDF, and
 * the reference pushed to Xero.
 *
 * Every expected timestamp below is hand-converted. 2026-03-02T22:30:00Z is
 * inside AEDT (UTC+11, DST runs to 5 April 2026), so Sydney reads 09:30 on
 * 3 March; 2026-03-03T00:30:00Z is 11:30 on 3 March. en-AU renders those as
 * "03/03/2026, 09:30 am" / "03/03/2026, 11:30 am".
 */

const ACTUAL_START_UTC = '2026-03-02T22:30:00Z';
const ACTUAL_END_UTC = '2026-03-03T00:30:00Z';
const SYDNEY_START = '03/03/2026, 09:30 am';
const SYDNEY_END = '03/03/2026, 11:30 am';
const UTC_START = '02/03/2026, 10:30 pm';
const UTC_END = '03/03/2026, 12:30 am';

const SUPPORT_NUMBER = '01_011_0107_1_1';

const row = (overrides = {}) => ({
  id: `mp-1:direct_support_time`,
  sourceItemId: 'mp-1',
  service: `Assistance With Self-Care Activities - ${SUPPORT_NUMBER}`,
  supportNumber: SUPPORT_NUMBER,
  unit: 'Hour(H)',
  quantity: 2,
  unitPrice: 70,
  totalAmount: 140,
  status: 'pending',
  ...overrides,
});

const completedMasterItem = (overrides = {}) => ({
  itemId: 'mp-1',
  data: {
    'Shift Status': 'Completed',
    'Actual Shift Start Date and Time': ACTUAL_START_UTC,
    'Actual Shift End Date and Time': ACTUAL_END_UTC,
    'Scheduled Shift Start Date & Time': '2026-03-02T21:00:00Z',
    'Scheduled Shift End Date & Time': '2026-03-02T23:00:00Z',
    ...overrides,
  },
});

const mapOf = (...items) => new Map(items.map((item) => [item.itemId, item]));

describe('enrichNdisInvoiceGeneratorRows', () => {
  // Breaks if the non-array guard is dropped (routes pass whatever the row
  // builder returned) — .map on a non-array throws.
  it('returns an empty array for non-array input', () => {
    expect(enrichNdisInvoiceGeneratorRows(null, new Map())).toEqual([]);
    expect(enrichNdisInvoiceGeneratorRows(undefined, new Map())).toEqual([]);
    expect(enrichNdisInvoiceGeneratorRows({ 0: row() }, new Map())).toEqual([]);
  });

  // Breaks if the shift window is dropped, inserted in the wrong place, or the
  // wrong timestamps (scheduled rather than actual) are used for a completed
  // shift. The window is appended immediately after the support item number.
  it('inserts the actual shift window straight after the support number for a completed shift', () => {
    const input = row({ service: `Assistance - ${SUPPORT_NUMBER} - Group Size: 2` });
    const [enriched] = enrichNdisInvoiceGeneratorRows([input], mapOf(completedMasterItem()));

    expect(enriched.service).toBe(
      `Assistance - ${SUPPORT_NUMBER} - from ${SYDNEY_START} to ${SYDNEY_END} - Group Size: 2`,
    );
    expect(enriched).not.toBe(input);
    expect(input.service).toBe(`Assistance - ${SUPPORT_NUMBER} - Group Size: 2`);
    expect(enriched.totalAmount).toBe(140);
    expect(enriched.quantity).toBe(2);
  });

  // Breaks if the suffix is inserted at index 0 when the number is absent
  // instead of appended.
  it('appends the window when the support number does not appear in the description', () => {
    const [enriched] = enrichNdisInvoiceGeneratorRows(
      [row({ service: 'Assistance With Self-Care Activities' })],
      mapOf(completedMasterItem()),
    );

    expect(enriched.service).toBe(
      `Assistance With Self-Care Activities - from ${SYDNEY_START} to ${SYDNEY_END}`,
    );
  });

  // Breaks if a cancelled shift is given actual times: a cancellation is billed
  // against the shift that was scheduled, not one that happened.
  it('uses the scheduled window for a cancelled shift', () => {
    const cancelled = {
      itemId: 'mp-1',
      data: {
        'Shift Status': 'Cancelled',
        'Actual Shift Start Date and Time': ACTUAL_START_UTC,
        'Actual Shift End Date and Time': ACTUAL_END_UTC,
        'Scheduled Shift Start Date & Time': '2026-03-02T21:00:00Z',
        'Scheduled Shift End Date and Time': '2026-03-02T23:00:00Z',
      },
    };

    const [enriched] = enrichNdisInvoiceGeneratorRows([row()], mapOf(cancelled));

    expect(enriched.service).toBe(
      `Assistance With Self-Care Activities - ${SUPPORT_NUMBER} - from 03/03/2026, 08:00 am to 03/03/2026, 10:00 am`,
    );
  });

  // Breaks if the status scan stops at the first populated key: an item that
  // carries both must be treated as cancelled, which changes which timestamps
  // are printed.
  it('prefers a cancelled status over a completed one when the item carries both', () => {
    const conflicting = completedMasterItem({ 'Job Status': 'Cancelled' });

    const [enriched] = enrichNdisInvoiceGeneratorRows([row()], mapOf(conflicting));

    expect(enriched.service).toBe(
      `Assistance With Self-Care Activities - ${SUPPORT_NUMBER} - from 03/03/2026, 08:00 am to 03/03/2026, 10:00 am`,
    );
  });

  // Breaks if the timezone argument stops being threaded through — the invoice
  // would print head-office-local times for every business.
  it('formats the window in the timezone it is given', () => {
    const [enriched] = enrichNdisInvoiceGeneratorRows([row()], mapOf(completedMasterItem()), 'UTC');

    expect(enriched.service).toBe(
      `Assistance With Self-Care Activities - ${SUPPORT_NUMBER} - from ${UTC_START} to ${UTC_END}`,
    );
  });

  // Breaks if the "already has a window" guard is dropped — the legacy row
  // builder already appends one, and the row would get it twice.
  it('leaves a description that already carries a window untouched', () => {
    const already = row({
      service: `Assistance - ${SUPPORT_NUMBER} - from ${SYDNEY_START} to ${SYDNEY_END}`,
    });

    const [enriched] = enrichNdisInvoiceGeneratorRows([already], mapOf(completedMasterItem()));

    expect(enriched).toBe(already);
  });

  it.each([
    ['the row has no matching master plan item', row({ sourceItemId: 'mp-other' }), completedMasterItem()],
    ['the unit is not hour based', row({ unit: 'Each(E)' }), completedMasterItem()],
    ['the shift is neither completed nor cancelled', row(), completedMasterItem({ 'Shift Status': 'In Progress' })],
    ['the row has no support number', row({ supportNumber: '' }), completedMasterItem()],
    ['a shift timestamp is missing', row(), completedMasterItem({ 'Actual Shift End Date and Time': '' })],
    ['a shift timestamp is unparseable', row(), completedMasterItem({ 'Actual Shift Start Date and Time': 'not a date' })],
  ])('returns the row unchanged when %s', (_label, inputRow, masterItem) => {
    const [enriched] = enrichNdisInvoiceGeneratorRows([inputRow], mapOf(masterItem));

    expect(enriched).toBe(inputRow);
  });

  // Breaks if enrichment stops being per-row (e.g. the first row's description
  // is reused, or an unmatched row is dropped from the result).
  it('enriches each row independently and keeps the row count', () => {
    const rows = [
      row(),
      row({ id: 'mp-2:direct_support_time', sourceItemId: 'mp-2', unit: 'Each(E)' }),
      row({ id: 'mp-3:direct_support_time', sourceItemId: 'mp-3' }),
    ];

    const enriched = enrichNdisInvoiceGeneratorRows(rows, mapOf(
      completedMasterItem(),
      { ...completedMasterItem(), itemId: 'mp-2' },
    ));

    expect(enriched).toHaveLength(3);
    expect(enriched[0].service).toBe(
      `Assistance With Self-Care Activities - ${SUPPORT_NUMBER} - from ${SYDNEY_START} to ${SYDNEY_END}`,
    );
    expect(enriched[1]).toBe(rows[1]);
    expect(enriched[2]).toBe(rows[2]);
  });
});

describe('buildNdisInvoicePdfClientDetails', () => {
  // Breaks if any field is allowed through as '' — the pdfme templates need a
  // non-empty string for every placeholder, which is why the fallback is ' '.
  it('fills every field with a single space when nothing is known', () => {
    expect(buildNdisInvoicePdfClientDetails()).toEqual({
      Contact: ' ',
      Address: ' ',
      'Participant Name': ' ',
      'NDIS Number': ' ',
    });
  });

  // Breaks if the precedence order is reordered: the prepared profile is the
  // hydrated, authoritative copy and must win over the raw stored item.
  it('prefers the prepared profile over the stored item and the API values', () => {
    const details = buildNdisInvoicePdfClientDetails({
      participantProfile: {
        fullName: 'Jane Doe',
        // KAN-272: Contact/Address only print the Billing Contact/Address
        // when a Billing Email is also present — see the Case A/AA/B tests
        // below. This test is about precedence between the prepared profile,
        // the stored item and the API values, so it supplies one to stay a
        // Case A fixture.
        billingEmail: 'plan@partners.example.com',
        billingContact: 'Plan Partners',
        billingAddress: '12 Ledger Rd, Sydney NSW 2000',
      },
      participantProfileItem: {
        data: {
          'Full Name/Preferred Name': 'Stale Name',
          'Billing Contact': 'Stale Contact',
          'Billing Address': 'Stale Address',
          'NDIS Number': '430 000 001',
        },
      },
      apiProfileValues: { fullName: 'API Name', billingContact: 'API Contact' },
      fallbackParticipantName: 'Fallback Name',
    });

    expect(details).toEqual({
      Contact: 'Plan Partners',
      Address: '12 Ledger Rd, Sydney NSW 2000',
      'Participant Name': 'Jane Doe',
      'NDIS Number': '430000001',
    });
  });

  // Breaks if the stored item is no longer read when the profile is blank —
  // the webhook PDF path passes an item and an empty profile.
  it('falls back to the stored item, then the API values, then the supplied name', () => {
    expect(buildNdisInvoicePdfClientDetails({
      participantProfileItem: { data: { 'Full Name/Preferred Name': 'Stored Name' } },
      apiProfileValues: { fullName: 'API Name' },
      fallbackParticipantName: 'Fallback Name',
    })['Participant Name']).toBe('Stored Name');

    expect(buildNdisInvoicePdfClientDetails({
      apiProfileValues: { fullName: 'API Name' },
      fallbackParticipantName: 'Fallback Name',
    })['Participant Name']).toBe('API Name');

    expect(buildNdisInvoicePdfClientDetails({
      fallbackParticipantName: 'Fallback Name',
    })['Participant Name']).toBe('Fallback Name');
  });

  // The last resort only fires for the lowercase 'Preferred name' spelling,
  // because every other key it reads is already covered above it. Breaks if
  // that final getParticipantDisplayName call is removed.
  it('reads the lowercase "Preferred name" spelling as a last resort', () => {
    const details = buildNdisInvoicePdfClientDetails({
      participantProfileItem: { data: { 'Preferred name': 'Janey' } },
    });

    expect(details['Participant Name']).toBe('Janey');
    expect(details.Contact).toBe('Janey');
  });

  // Breaks if the address parts are joined in the wrong order or with the wrong
  // separators — this block is printed verbatim on the invoice.
  it('composes the address from street, suburb, state and postcode', () => {
    const details = buildNdisInvoicePdfClientDetails({
      participantProfile: {
        fullName: 'Jane Doe',
        address: '4/12 Smith St',
        suburb: 'Newtown',
        state: 'NSW',
        postcode: '2042',
      },
    });

    expect(details.Address).toBe('4/12 Smith St, Newtown, NSW 2042');
  });

  // Breaks if missing parts leave empty segments ("', , 2042'").
  it('omits missing address parts rather than leaving empty segments', () => {
    expect(buildNdisInvoicePdfClientDetails({
      participantProfile: { postcode: '2042' },
    }).Address).toBe('2042');

    expect(buildNdisInvoicePdfClientDetails({
      participantProfile: { suburb: 'Newtown', state: 'NSW' },
    }).Address).toBe('Newtown, NSW');
  });

  // Breaks if the billing address stops short-circuiting the composed one.
  // KAN-272: that short-circuit only happens in Case A — Billing Email and
  // Billing Contact both present too — so both are supplied here.
  it('uses the billing address instead of the composed address when present', () => {
    const details = buildNdisInvoicePdfClientDetails({
      participantProfile: {
        billingEmail: 'plan@partners.example.com',
        billingContact: 'Plan Partners',
        billingAddress: 'PO Box 55, Newtown NSW 2042',
        address: '4/12 Smith St',
        suburb: 'Newtown',
      },
    });

    expect(details.Address).toBe('PO Box 55, Newtown NSW 2042');
  });

  // Breaks if the NDIS number stops being digit-sanitised: NDIS rejects a claim
  // whose participant number carries spaces or punctuation.
  it('strips punctuation from the NDIS number and finds it under a non-standard key', () => {
    expect(buildNdisInvoicePdfClientDetails({
      participantProfileItem: { data: { 'NDIS Number': '430 000 001' } },
    })['NDIS Number']).toBe('430000001');

    expect(buildNdisInvoicePdfClientDetails({
      participantProfileItem: { data: { 'NDIS Participant No.': '430-000-002' } },
    })['NDIS Number']).toBe('430000002');
  });

  // Characterizes the non-numeric case: sanitising leaves nothing, so the raw
  // stored text is printed instead of a blank.
  it('prints a non-numeric NDIS Number verbatim', () => {
    expect(buildNdisInvoicePdfClientDetails({
      participantProfileItem: { data: { 'NDIS Number': 'PENDING' } },
    })['NDIS Number']).toBe('PENDING');
  });

  // Breaks if Contact stops falling back to the participant, or Participant
  // Name stops falling back to the contact.
  it('cross-fills Contact and Participant Name from each other', () => {
    expect(buildNdisInvoicePdfClientDetails({
      participantProfile: { fullName: 'Jane Doe' },
    }).Contact).toBe('Jane Doe');

    expect(buildNdisInvoicePdfClientDetails({
      participantProfile: { billingContact: 'Plan Partners' },
    })['Participant Name']).toBe('Plan Partners');
  });

  /**
   * KAN-272. Contact/Address now gate on Billing Email — Case A/AA/B — rather
   * than using a Billing Contact/Address that was set but never checked
   * against whether there was a Billing Email to route to.
   */
  describe('Case A/AA/B recipient resolution', () => {
    const fullProfile = {
      fullName: 'Jane Doe',
      billingEmail: 'nora@plan-manager.example.com',
      billingContact: 'Plan Partners',
      billingAddress: '12 Ledger Rd, Sydney NSW 2000',
      address: '4/12 Smith St',
      suburb: 'Newtown',
      state: 'NSW',
      postcode: '2042',
    };

    it('Case A: prints the Billing Contact and Billing Address when Billing Email is present', () => {
      const details = buildNdisInvoicePdfClientDetails({ participantProfile: fullProfile });

      expect(details.Contact).toBe('Plan Partners');
      expect(details.Address).toBe('12 Ledger Rd, Sydney NSW 2000');
    });

    it('Case AA: prints the participant\'s own name and address when Billing Contact is blank', () => {
      const details = buildNdisInvoicePdfClientDetails({
        participantProfile: { ...fullProfile, billingContact: '' },
      });

      expect(details.Contact).toBe('Jane Doe');
      expect(details.Address).toBe('4/12 Smith St, Newtown, NSW 2042');
    });

    it('Case AA: prints the participant\'s own name and address when Billing Address is blank', () => {
      const details = buildNdisInvoicePdfClientDetails({
        participantProfile: { ...fullProfile, billingAddress: '' },
      });

      expect(details.Contact).toBe('Jane Doe');
      expect(details.Address).toBe('4/12 Smith St, Newtown, NSW 2042');
    });

    it('Case B: prints the participant\'s own name and address when Billing Email is blank, even with a Billing Contact on file', () => {
      const details = buildNdisInvoicePdfClientDetails({
        participantProfile: { ...fullProfile, billingEmail: '' },
      });

      expect(details.Contact).toBe('Jane Doe');
      expect(details.Address).toBe('4/12 Smith St, Newtown, NSW 2042');
    });
  });
});

describe('buildNdisXeroInvoiceReference', () => {
  // Breaks if the separator or the order changes — this string is how the
  // finance team matches a Xero invoice back to a participant.
  it('joins the participant name and NDIS number with a dash', () => {
    const reference = buildNdisXeroInvoiceReference(
      { fullName: 'Jane Doe' },
      { data: { 'NDIS Number': '430 000 001' } },
    );

    expect(reference).toBe('Jane Doe - 430000001');
  });

  it('falls back to the display name on the item when the profile has no name', () => {
    const reference = buildNdisXeroInvoiceReference(
      {},
      { data: { 'Preferred Name': 'Janey', 'NDIS Number': '430000001' } },
    );

    expect(reference).toBe('Janey - 430000001');
  });

  // Breaks if the filter(Boolean) is dropped: 'Jane Doe - ' or ' - 430000001'
  // would reach Xero.
  it('emits only the part it has', () => {
    expect(buildNdisXeroInvoiceReference({ fullName: 'Jane Doe' }, null)).toBe('Jane Doe');
    expect(buildNdisXeroInvoiceReference({}, { data: { 'NDIS Number': '430000001' } })).toBe('430000001');
  });

  // Breaks if the ' ' fallback is dropped — Xero rejects an empty reference.
  it('returns a single space when nothing is known', () => {
    expect(buildNdisXeroInvoiceReference(undefined, undefined)).toBe(' ');
    expect(buildNdisXeroInvoiceReference({}, {})).toBe(' ');
  });
});

describe('buildMasterItemsMap', () => {
  // Breaks if the null guard is dropped.
  it('returns an empty map for missing input', () => {
    expect(buildMasterItemsMap(null).size).toBe(0);
    expect(buildMasterItemsMap(undefined).size).toBe(0);
    expect(buildMasterItemsMap([]).size).toBe(0);
  });

  // Breaks if the itemId is not stringified: rows carry String(sourceItemId),
  // so a numeric key would never be found and no row would be enriched.
  it('keys items by their stringified itemId', () => {
    const numeric = { itemId: 42, data: {} };

    const map = buildMasterItemsMap([numeric]);

    expect(map.get('42')).toBe(numeric);
    expect(map.has(42)).toBe(false);
  });

  // Breaks if the filter is dropped — an item with no id would take the
  // undefined key and shadow lookups.
  it('drops items with no itemId', () => {
    const good = { itemId: 'mp-1', data: {} };

    const map = buildMasterItemsMap([{ data: {} }, null, { itemId: '', data: {} }, good]);

    expect([...map.keys()]).toEqual(['mp-1']);
    expect(map.get('mp-1')).toBe(good);
  });

  it('keeps the last item when two share an id', () => {
    const first = { itemId: 'mp-1', data: { n: 1 } };
    const second = { itemId: 'mp-1', data: { n: 2 } };

    expect(buildMasterItemsMap([first, second]).get('mp-1')).toBe(second);
  });
});
