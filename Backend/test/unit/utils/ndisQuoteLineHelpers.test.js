import { describe, it, expect, vi } from 'vitest';
import {
  buildNdisQuoteXeroLineItems,
  buildNdisQuotePdfOrders,
  buildNdisQuoteRecipientAddresses,
  resolveNdisQuoteRecipientContact,
  buildNdisQuoteMappedAndXeroPayload,
} from '../../../src/utils/ndisQuoteLineHelpers.js';

/*
 * ndisQuoteLineHelpers.js turns an ISO+ NDIS Quote item into the Xero quote
 * line items and the PDF order table. `NDISQuoteValues` is the flat
 * attribute-name-keyed object the quote routes assemble; `refs` is the tuple of
 * resolved support-catalogue rows in a fixed order:
 *
 *   [directSupport, providerTravel, activityBasedTransport, centreCapital,
 *    providerTravelLabourTravelTime]
 *
 * (src/utils/xeroNdisRouteHandlers.js passes `refs.slice(1)`, i.e. everything
 * after the service-area row.)
 */

const GST_TYPE = 'EXEMPTOUTPUT';

const refs = (overrides = []) => {
  const base = [
    { itemName: 'Assistance With Self-Care' },
    { itemName: 'Provider Travel - Non-Labour Cost' },
    { itemName: 'Activity Based Transport' },
    { itemName: 'Centre Capital Costs' },
    { itemName: 'Labour Travel Time' },
  ];
  return base.map((v, i) => (i in overrides ? overrides[i] : v));
};

const fullQuote = (overrides = {}) => ({
  'Direct Support Item Number': '01_011_0107_1_1',
  'Unit (Direct Support)': 'Hour(H)',
  'Quantity (Direct Support)': '10',
  'Unit Price for Direct Support($)': '70.00',

  'Provider Travel - Non-Labour Cost Item Number': '01_799_0107_1_1',
  'Unit (Provider Travel - Non-Labour Cost)': 'Each(E)',
  'Quantity (Provider Travel)': '20',
  'Unit Price for Provider Travel($)': '0.80',

  'Activity Based Transport Item Number': '02_051_0108_1_1',
  'Unit (Activity Based Transport)': 'Each(E)',
  'Quantity (Activity Based Transport)': '15',
  'Unit Price for Activity Based Transport($)': '1.20',

  'Centre Capital Costs Item': '01_082_0103_1_1',
  'Unit (Centre Capital Costs)': 'Hour(H)',
  'Quantity (Centre Capital Costs)': '10',
  'Unit Price for Centre Capital Costs($)': '12.00',

  'Unit (Labour Travel Time)': 'Hour(H)',
  'Quantity (Labour Travel Time)': '2',
  'Unit Price for Labour Travel Time ($)': '65.00',

  Allowances: 'Sleepover',
  'Unit (Allowances)': 'Each(E)',
  'Allowances Amount($)': '35.00',

  'Non-Face-to-Face Supports': 'Report writing',
  'Unit (Non-Face-to-Face Support)': 'Hour(H)',
  'Quantity (Non-Face-to-Face Support)': '1.5',
  'Unit Price for Non-Face-to-Face Support ($)': '60.00',
  ...overrides,
});

describe('buildNdisQuoteXeroLineItems', () => {
  // Breaks if a line is dropped, reordered, or priced from the wrong column —
  // this array is posted to Xero as the quote.
  it('builds all seven line types in a fixed order, all GST exempt', () => {
    expect(buildNdisQuoteXeroLineItems(fullQuote(), refs())).toEqual([
      {
        description: '01_011_0107_1_1-Assistance With Self-Care - Hour(H)',
        unit: 'Hour(H)',
        quantity: 10,
        unitAmount: 70,
        taxType: GST_TYPE,
      },
      {
        description: '01_799_0107_1_1-Provider Travel - Non-Labour Cost - Each(E)',
        unit: 'Each(E)',
        quantity: 20,
        unitAmount: 0.8,
        taxType: GST_TYPE,
      },
      {
        description: '02_051_0108_1_1-Activity Based Transport - Each(E)',
        unit: 'Each(E)',
        quantity: 15,
        unitAmount: 1.2,
        taxType: GST_TYPE,
      },
      {
        description: '01_082_0103_1_1-Centre Capital Costs - Hour(H)',
        unit: 'Hour(H)',
        quantity: 10,
        unitAmount: 12,
        taxType: GST_TYPE,
      },
      {
        description: 'Provider Travel - Labour Travel Time Costs-Labour Travel Time - Hour(H)',
        unit: 'Hour(H)',
        quantity: 2,
        unitAmount: 65,
        taxType: GST_TYPE,
      },
      {
        description: 'Allowances - Sleepover - Each(E)',
        unit: 'Each(E)',
        quantity: 1,
        unitAmount: 35,
        taxType: GST_TYPE,
      },
      {
        description: 'Non-Face-to-Face Support - Report writing - Hour(H)',
        unit: 'Hour(H)',
        quantity: 1.5,
        unitAmount: 60,
        taxType: GST_TYPE,
      },
    ]);
  });

  // Breaks if either half of the gate goes: a quantity with no price, or a
  // price with no quantity, is an incomplete row and must not reach Xero.
  it('needs both a quantity and a price for the four catalogue lines', () => {
    const codes = (overrides) => buildNdisQuoteXeroLineItems(fullQuote(overrides), refs())
      .map((line) => line.description);

    expect(codes({ 'Quantity (Direct Support)': 0 })).toHaveLength(6);
    expect(codes({ 'Unit Price for Direct Support($)': '' })).toHaveLength(6);
    expect(codes({ 'Quantity (Provider Travel)': undefined })).toHaveLength(6);
    expect(codes({ 'Unit Price for Activity Based Transport($)': 0 })).toHaveLength(6);
    expect(codes({ 'Quantity (Centre Capital Costs)': null })).toHaveLength(6);
  });

  // Characterizing a truthiness gap with real pricing consequences: the gates
  // test the RAW value, and ISO+ posts numeric columns as strings, so a quantity
  // or price of "0" is truthy and produces a $0.00 line on the Xero quote and
  // the quote PDF instead of being skipped.
  it('emits a zero-value line when a quantity or price arrives as the string "0"', () => {
    const zeroQty = buildNdisQuoteXeroLineItems(
      fullQuote({ 'Quantity (Direct Support)': '0' }),
      refs(),
    )[0];
    expect(zeroQty.quantity).toBe(0);
    expect(zeroQty.unitAmount).toBe(70);

    const zeroPrice = buildNdisQuoteXeroLineItems(
      fullQuote({ 'Unit Price for Direct Support($)': '0' }),
      refs(),
    )[0];
    expect(zeroPrice.quantity).toBe(10);
    expect(zeroPrice.unitAmount).toBe(0);
  });

  // Breaks if the labour travel gate starts requiring a price too: this line is
  // deliberately quantity-gated only, and its price defaults to 1.
  it('emits labour travel on quantity alone, defaulting the price to 1', () => {
    const line = buildNdisQuoteXeroLineItems(
      fullQuote({ 'Unit Price for Labour Travel Time ($)': '0' }),
      refs(),
    ).find((l) => l.description.startsWith('Provider Travel - Labour Travel Time Costs'));

    expect(line.quantity).toBe(2);
    expect(line.unitAmount).toBe(1);
  });

  // Same deliberate default on the non-face-to-face line.
  it('defaults the non-face-to-face price to 1 when none is given', () => {
    const line = buildNdisQuoteXeroLineItems(
      fullQuote({ 'Unit Price for Non-Face-to-Face Support ($)': undefined }),
      refs(),
    ).find((l) => l.description.startsWith('Non-Face-to-Face Support'));

    expect(line.unitAmount).toBe(1);
  });

  // Breaks if the allowances gate loosens: an allowance type with no amount, or
  // an amount with no type, is not a quotable line.
  it('needs both the allowance type and its amount', () => {
    expect(buildNdisQuoteXeroLineItems(fullQuote({ Allowances: '' }), refs())
      .some((l) => l.description.startsWith('Allowances'))).toBe(false);
    expect(buildNdisQuoteXeroLineItems(fullQuote({ 'Allowances Amount($)': 0 }), refs())
      .some((l) => l.description.startsWith('Allowances'))).toBe(false);
  });

  it('needs both the non-face-to-face type and its quantity', () => {
    expect(buildNdisQuoteXeroLineItems(fullQuote({ 'Non-Face-to-Face Supports': '' }), refs())
      .some((l) => l.description.startsWith('Non-Face-to-Face'))).toBe(false);
    expect(buildNdisQuoteXeroLineItems(fullQuote({ 'Quantity (Non-Face-to-Face Support)': '' }), refs())
      .some((l) => l.description.startsWith('Non-Face-to-Face'))).toBe(false);
  });

  // Breaks if the fallback description goes: a line with no item number and no
  // resolved catalogue name would otherwise be described as the empty string.
  it('falls back to a generic description when neither number nor name resolves', () => {
    const line = buildNdisQuoteXeroLineItems(
      fullQuote({ 'Direct Support Item Number': '', 'Unit (Direct Support)': '' }),
      refs([null]),
    )[0];

    expect(line.description).toBe('Direct Support');
    expect(line.unit).toBe('');
  });

  it('omits the unit suffix when the quote has no unit', () => {
    const line = buildNdisQuoteXeroLineItems(
      fullQuote({ 'Unit (Direct Support)': '' }),
      refs(),
    )[0];

    expect(line.description).toBe('01_011_0107_1_1-Assistance With Self-Care');
  });

  it('returns an empty array for an empty quote', () => {
    expect(buildNdisQuoteXeroLineItems({}, refs())).toEqual([]);
  });

  // Breaks if the quantity/price coercion goes: ISO+ posts these as strings and
  // Xero rejects a string quantity.
  it('coerces every quantity and price to a number', () => {
    for (const line of buildNdisQuoteXeroLineItems(fullQuote(), refs())) {
      expect(typeof line.quantity).toBe('number');
      expect(typeof line.unitAmount).toBe('number');
    }
  });
});

describe('buildNdisQuotePdfOrders', () => {
  // Copied from the quote routes: the PDF renders every figure to two decimals.
  const formatValue = (val) => {
    const num = Number(val);
    return isNaN(num) ? val : (Math.round(num * 100) / 100).toFixed(2);
  };

  // Breaks on a changed column order, a lost GST label, or a subtotal that no
  // longer sums quantity * price — all of them print onto the quote PDF.
  it('renders one six-column row per Xero line and sums the subtotal', () => {
    const { ordersArr, subTotal } = buildNdisQuotePdfOrders(fullQuote(), refs(), formatValue);

    expect(ordersArr).toEqual([
      ['01_011_0107_1_1-Assistance With Self-Care - Hour(H)', 'Hour(H)', '10.00', '70.00', 'GST Free', '700.00'],
      ['01_799_0107_1_1-Provider Travel - Non-Labour Cost - Each(E)', 'Each(E)', '20.00', '0.80', 'GST Free', '16.00'],
      ['02_051_0108_1_1-Activity Based Transport - Each(E)', 'Each(E)', '15.00', '1.20', 'GST Free', '18.00'],
      ['01_082_0103_1_1-Centre Capital Costs - Hour(H)', 'Hour(H)', '10.00', '12.00', 'GST Free', '120.00'],
      ['Provider Travel - Labour Travel Time Costs-Labour Travel Time - Hour(H)', 'Hour(H)', '2.00', '65.00', 'GST Free', '130.00'],
      ['Allowances - Sleepover - Each(E)', 'Each(E)', '1.00', '35.00', 'GST Free', '35.00'],
      ['Non-Face-to-Face Support - Report writing - Hour(H)', 'Hour(H)', '1.50', '60.00', 'GST Free', '90.00'],
    ]);
    // 700 + 16 + 18 + 120 + 130 + 35 + 90
    expect(subTotal).toBe(1109);
  });

  // Breaks if the subtotal starts accumulating the rounded strings rather than
  // the raw products — that is what keeps the PDF total and the Xero total
  // agreeing to the cent.
  it('accumulates the unrounded product into the subtotal', () => {
    const { ordersArr, subTotal } = buildNdisQuotePdfOrders(
      {
        'Direct Support Item Number': 'X1',
        'Quantity (Direct Support)': '3',
        'Unit Price for Direct Support($)': '0.335',
      },
      refs([null]),
      formatValue,
    );

    expect(ordersArr[0][5]).toBe('1.01');
    expect(subTotal).toBeCloseTo(1.005, 10);
  });

  it('returns an empty table and a zero subtotal for an empty quote', () => {
    expect(buildNdisQuotePdfOrders({}, refs(), formatValue)).toEqual({ ordersArr: [], subTotal: 0 });
  });
});

describe('buildNdisQuoteRecipientAddresses', () => {
  const quote = {
    'Recipient Address': '1 Fixture Street',
    Suburb: 'Testville',
    State: 'NSW',
    Postcode: 2000,
  };

  // Breaks if either address type is dropped: Xero needs both a POBOX and a
  // STREET address on a contact, and the postcode must be a string.
  it('emits the same address as both POBOX and STREET with a string postcode', () => {
    expect(buildNdisQuoteRecipientAddresses(quote)).toEqual([
      { addressType: 'POBOX', addressLine1: '1 Fixture Street', city: 'Testville', region: 'NSW', postalCode: '2000' },
      { addressType: 'STREET', addressLine1: '1 Fixture Street', city: 'Testville', region: 'NSW', postalCode: '2000' },
    ]);
  });

  // Characterizing an unguarded read: `NDISQuoteValues.Postcode.toString()` has
  // no optional chaining, so a quote with no postcode throws here rather than
  // producing an address with a blank postcode.
  it('throws when the quote has no postcode', () => {
    expect(() => buildNdisQuoteRecipientAddresses({ ...quote, Postcode: undefined }))
      .toThrow(TypeError);
  });
});

describe('resolveNdisQuoteRecipientContact', () => {
  const quote = {
    'Recipient of the Quote': 'Rivers Family Trust',
    'Recipient Email': 'accounts@example.com',
    'Recipient Address': '1 Fixture Street',
    Suburb: 'Testville',
    State: 'NSW',
    Postcode: '2000',
    updatedAt: '2026-02-01T00:00:00.000Z',
  };

  const args = (overrides = {}) => ({
    NDISQuoteValues: quote,
    getContactByEmail: vi.fn().mockResolvedValue(null),
    createOrUpdateContact: vi.fn(async (payload) => ({ contactID: 'xero-1', ...payload })),
    setIntegrationMessage: vi.fn().mockResolvedValue(undefined),
    workspaceId: '55369',
    boardId: 'eNiJpH14PN3',
    itemId: 'quote-1',
    ...overrides,
  });

  const expectedPayload = {
    name: 'Rivers Family Trust',
    addresses: buildNdisQuoteRecipientAddresses(quote),
    emailAddress: 'accounts@example.com',
  };

  // Breaks if the create path stops sending the addresses or the email, or if
  // the user is no longer told a contact is being created.
  it('creates a contact when Xero has none for the email', async () => {
    const a = args();
    const contact = await resolveNdisQuoteRecipientContact(a);

    expect(a.getContactByEmail).toHaveBeenCalledWith('accounts@example.com');
    expect(a.setIntegrationMessage).toHaveBeenCalledWith(
      '55369', 'eNiJpH14PN3', 'quote-1', 'The contact does not exist in Xero, creating...',
    );
    expect(a.createOrUpdateContact).toHaveBeenCalledWith(expectedPayload);
    expect(contact.contactID).toBe('xero-1');
  });

  // Breaks if the staleness comparison inverts: updating a Xero contact that is
  // newer than ISO+ would overwrite edits made in Xero.
  it('keeps the Xero contact when Xero is newer than ISO+', async () => {
    const existing = { contactID: 'xero-9', updatedDateUTC: '2026-03-01T00:00:00.000Z' };
    const a = args({ getContactByEmail: vi.fn().mockResolvedValue(existing) });

    await expect(resolveNdisQuoteRecipientContact(a)).resolves.toBe(existing);
    expect(a.createOrUpdateContact).not.toHaveBeenCalled();
    expect(a.setIntegrationMessage).not.toHaveBeenCalled();
  });

  // Breaks on an off-by-one at the boundary: equal timestamps must NOT trigger
  // an update, because `>=` favours the Xero copy.
  it('keeps the Xero contact when the timestamps are exactly equal', async () => {
    const existing = { contactID: 'xero-9', updatedDateUTC: '2026-02-01T00:00:00.000Z' };
    const a = args({ getContactByEmail: vi.fn().mockResolvedValue(existing) });

    await expect(resolveNdisQuoteRecipientContact(a)).resolves.toBe(existing);
    expect(a.createOrUpdateContact).not.toHaveBeenCalled();
  });

  // Breaks if the contactID is dropped from the update payload — Xero would
  // create a duplicate contact instead of updating the existing one.
  it('updates the Xero contact in place when ISO+ is newer', async () => {
    const existing = { contactID: 'xero-9', updatedDateUTC: '2026-01-01T00:00:00.000Z' };
    const a = args({ getContactByEmail: vi.fn().mockResolvedValue(existing) });

    await resolveNdisQuoteRecipientContact(a);

    expect(a.createOrUpdateContact).toHaveBeenCalledWith({ contactID: 'xero-9', ...expectedPayload });
    expect(a.setIntegrationMessage).not.toHaveBeenCalled();
  });

  // Characterizing the unparseable-date case: `new Date(undefined)` is NaN and
  // every comparison against NaN is false, so the contact is updated.
  it('updates the contact when either timestamp is unparseable', async () => {
    const existing = { contactID: 'xero-9', updatedDateUTC: 'not a date' };
    const a = args({ getContactByEmail: vi.fn().mockResolvedValue(existing) });

    await resolveNdisQuoteRecipientContact(a);

    expect(a.createOrUpdateContact).toHaveBeenCalledWith({ contactID: 'xero-9', ...expectedPayload });
  });
});

describe('buildNdisQuoteMappedAndXeroPayload', () => {
  const lineItems = [
    { description: 'Direct Support', unit: 'Hour(H)', quantity: 10, unitAmount: 70, taxType: GST_TYPE },
    { description: 'Provider Travel', unit: 'Each(E)', quantity: 20, unitAmount: 0.8, taxType: GST_TYPE },
  ];
  const contact = { contactID: 'xero-1' };
  const business = { bankDetails: { accountsReceivableTerms: 'Payment due within 14 days of invoice date.' } };
  const NOW = '2026-08-10T00:00:00.000Z';

  const TERMS = (payment) => 'Terms & Conditions\n'
    + '- This quote remains valid until the expiry date indicated above.\n'
    + `- Payment Terms: ${payment}\n`
    + '- All prices are subject to change with prior notice.\n'
    + '- A cancellation fee may apply as per the terms of the service agreement.';

  // Breaks if a mapped field is renamed or the terms wording changes — the
  // mapped quote drives the PDF and the terms print on it verbatim.
  it('maps the quote fields and builds the Xero payload', () => {
    const result = buildNdisQuoteMappedAndXeroPayload({
      NDISQuoteValues: {
        'Issue Date': '2026-08-01',
        'Expiry Date': '2026-09-01',
        'Job Title': 'Weekly self-care support',
        'Unit Price($) - GST Excl.': '70.00',
        Quantity: '10',
        'Job Description': '<p>Support at <b>home</b></p>',
      },
      lineItems,
      contact,
      business,
      nowISO: NOW,
    });

    expect(result.mappedQuote).toEqual({
      issueDate: '2026-08-01',
      expiryDate: '2026-09-01',
      jobTitle: 'Weekly self-care support',
      unitPrice: '70.00',
      quantity: '10',
      jobDescription: 'Support at home',
      quoteChecklist: ['Direct Support', 'Provider Travel'],
    });
    expect(result.xeroQuote).toEqual({
      contact: { contactID: 'xero-1' },
      date: '2026-08-01',
      expiryDate: '2026-09-01',
      lineItems,
      terms: TERMS('Payment due within 14 days of invoice date.'),
    });
  });

  // Breaks if the first-line fallbacks are dropped: a quote with no header
  // fields would otherwise go to Xero blank.
  it('falls back to now and to the first line item for every missing field', () => {
    const result = buildNdisQuoteMappedAndXeroPayload({
      NDISQuoteValues: {},
      lineItems,
      contact,
      business,
      nowISO: NOW,
    });

    expect(result.mappedQuote).toEqual({
      issueDate: NOW,
      expiryDate: NOW,
      jobTitle: 'Direct Support',
      unitPrice: 70,
      quantity: 10,
      jobDescription: 'Direct Support',
      quoteChecklist: ['Direct Support', 'Provider Travel'],
    });
    expect(result.xeroQuote.date).toBe(NOW);
  });

  // Breaks if the empty-line-items case starts throwing on `lineItems[0]`.
  it('survives an empty line item list', () => {
    const result = buildNdisQuoteMappedAndXeroPayload({
      NDISQuoteValues: {},
      lineItems: [],
      contact,
      business: null,
      nowISO: NOW,
    });

    expect(result.mappedQuote).toEqual({
      issueDate: NOW,
      expiryDate: NOW,
      jobTitle: '',
      unitPrice: 0,
      quantity: 0,
      jobDescription: '',
      quoteChecklist: [],
    });
    // No bank details configured: the payment terms line falls back to a space.
    expect(result.xeroQuote.terms).toBe(TERMS(' '));
  });

  // Breaks if the tag strip is removed: ISO+ rich-text descriptions would put
  // raw HTML on the quote PDF.
  it('strips HTML tags from the job description', () => {
    const result = buildNdisQuoteMappedAndXeroPayload({
      NDISQuoteValues: { 'Job Description': '<div class="x">Line one<br/>Line two</div>' },
      lineItems,
      contact,
      business,
      nowISO: NOW,
    });

    expect(result.mappedQuote.jobDescription).toBe('Line oneLine two');
  });

  it('falls back to a space when the business has no accounts receivable terms', () => {
    const result = buildNdisQuoteMappedAndXeroPayload({
      NDISQuoteValues: {},
      lineItems,
      contact,
      business: { bankDetails: { accountsReceivableTerms: '' } },
      nowISO: NOW,
    });

    expect(result.xeroQuote.terms).toBe(TERMS(' '));
  });
});
