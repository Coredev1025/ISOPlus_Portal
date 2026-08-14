import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  contactFieldsFromItemData,
  buildDraftAccRecInvoice,
} from '../../../src/utils/automationXeroInvoiceHelpers.js';

const ITEM = {
  'Recipient of the Quote': 'Jordan Fixture',
  'Recipient Email': 'jordan@example.test',
  'Recipient Address': '2 Sample Road',
  Suburb: 'Testville',
  State: 'NSW',
  Postcode: '2000',
  'Quantity (Direct Support)': 4,
  'Unit Price for Direct Support($)': 67.56,
  'Unit (Direct Support)': 'Hour',
};

const CONTACT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('contactFieldsFromItemData', () => {
  it('reads quote recipient fields', () => {
    expect(contactFieldsFromItemData(ITEM)).toEqual({
      name: 'Jordan Fixture',
      emailAddress: 'jordan@example.test',
      addressLine1: '2 Sample Road',
      city: 'Testville',
      region: 'NSW',
      postalCode: '2000',
    });
  });

  it('throws when name and email are both missing', () => {
    expect(() => contactFieldsFromItemData({})).toThrow(/Unresolvable Xero contact/);
  });

  it('does not throw when only a name is present', () => {
    expect(contactFieldsFromItemData({ 'Recipient of the Quote': 'Sam' }).name).toBe('Sam');
  });
});

describe('buildDraftAccRecInvoice', () => {
  const invoice = buildDraftAccRecInvoice({
    itemData: ITEM,
    contactId: CONTACT_ID,
    invoiceNumber: 'IN-1000',
    slot: new Date('2026-08-14T08:03:43.208Z'),
    timezone: 'Australia/Sydney',
    business: {},
    accounts: [{ Type: 'REVENUE', Code: '200' }],
  });

  it('is a DRAFT ACCREC with the Portal number as reference', () => {
    expect(invoice).toMatchObject({
      type: 'ACCREC',
      status: 'DRAFT',
      reference: 'IN-1000',
      lineAmountTypes: 'Exclusive',
      contact: { contactID: CONTACT_ID },
    });
  });

  it('dates the invoice on the claimed slot, not now', () => {
    expect(invoice.date).toBe('2026-08-14');
    expect(invoice.dueDate).toBe('2026-08-14');
  });

  it('emits GST-free lines with an account code', () => {
    expect(invoice.lineItems.length).toBeGreaterThan(0);
    expect(invoice.lineItems[0]).toMatchObject({
      quantity: 4,
      unitAmount: 67.56,
      taxType: 'EXEMPTOUTPUT',
      accountCode: '200',
    });
  });

  it('does not import xero.js', () => {
    const src = readFileSync(
      new URL('../../../src/utils/automationXeroInvoiceHelpers.js', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/services\/xero\.js/);
  });
});
