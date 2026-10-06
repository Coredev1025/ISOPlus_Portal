// Backend/test/unit/utils/invoiceRecipientHelpers.test.js
//
// KAN-272: the single recipient/address resolution rule shared by every
// invoice and statement generator (Statement of Account, NDIS invoice PDF,
// SaH/SaH(Low-cat) tax invoice PDF, Xero participant tax invoice, and email
// routing). Case A/AA/B, straight off the ticket's action table:
//
//   A.  Billing Email + Billing Contact + Billing Address all present
//       -> recipient is the Billing Contact, printed as themselves.
//   AA. Billing Email present, but Billing Contact or Billing Address blank
//       -> still the Billing Contact as the recipient, but printed under the
//          participant's own name and address.
//   B.  Billing Email blank
//       -> recipient is the participant, under their own name and address.

import { describe, it, expect } from 'vitest';
import {
  resolveInvoiceRecipient,
  readProfileRecipientAttributes,
  RECIPIENT_TYPE_BILLING_CONTACT,
  RECIPIENT_TYPE_CLIENT_PARTICIPANT,
} from '../../../src/utils/invoiceRecipientHelpers.js';

const FULL = {
  billingEmail: 'nora@plan-manager.example.com',
  billingContact: 'Nominee Nora',
  billingAddress: 'PO Box 1, Sydney NSW 2000',
  fullName: 'Jane Smith',
  address: '5 Client Rd',
  suburb: 'Newtown',
  state: 'NSW',
  postcode: '2042',
};

describe('resolveInvoiceRecipient', () => {
  describe('Case A: Billing Email, Billing Contact and Billing Address all present', () => {
    it('addresses the Billing Contact, printed as themselves', () => {
      const result = resolveInvoiceRecipient(FULL);

      expect(result).toEqual({
        recipientType: RECIPIENT_TYPE_BILLING_CONTACT,
        recipientName: 'Nominee Nora',
        addressLines: ['PO Box 1, Sydney NSW 2000'],
        billingEmail: 'nora@plan-manager.example.com',
      });
    });

    it('trims whitespace around every field', () => {
      const result = resolveInvoiceRecipient({
        ...FULL,
        billingEmail: '  nora@plan-manager.example.com  ',
        billingContact: '  Nominee Nora  ',
        billingAddress: '  PO Box 1, Sydney NSW 2000  ',
      });

      expect(result.recipientName).toBe('Nominee Nora');
      expect(result.addressLines).toEqual(['PO Box 1, Sydney NSW 2000']);
      expect(result.billingEmail).toBe('nora@plan-manager.example.com');
    });
  });

  describe('Case AA: Billing Email present, but Billing Contact or Billing Address is blank', () => {
    it('falls back to the participant\'s own name and address when Billing Contact is blank', () => {
      const result = resolveInvoiceRecipient({ ...FULL, billingContact: '' });

      expect(result).toEqual({
        recipientType: RECIPIENT_TYPE_BILLING_CONTACT,
        recipientName: 'Jane Smith',
        addressLines: ['5 Client Rd', 'Newtown', 'NSW 2042'],
        billingEmail: 'nora@plan-manager.example.com',
      });
    });

    it('falls back to the participant\'s own name and address when Billing Address is blank', () => {
      const result = resolveInvoiceRecipient({ ...FULL, billingAddress: '' });

      expect(result).toEqual({
        recipientType: RECIPIENT_TYPE_BILLING_CONTACT,
        recipientName: 'Jane Smith',
        addressLines: ['5 Client Rd', 'Newtown', 'NSW 2042'],
        billingEmail: 'nora@plan-manager.example.com',
      });
    });

    it('treats a whitespace-only Billing Contact as blank', () => {
      const result = resolveInvoiceRecipient({ ...FULL, billingContact: '   ' });

      expect(result.recipientName).toBe('Jane Smith');
    });

    it('falls back when both Billing Contact and Billing Address are blank', () => {
      const result = resolveInvoiceRecipient({ ...FULL, billingContact: '', billingAddress: '' });

      expect(result.recipientType).toBe(RECIPIENT_TYPE_BILLING_CONTACT);
      expect(result.recipientName).toBe('Jane Smith');
      expect(result.addressLines).toEqual(['5 Client Rd', 'Newtown', 'NSW 2042']);
    });

    // Still recipientType billing_contact even though nothing billing-shaped
    // is printed — the mailbox is still the Billing Email, per the ticket's
    // action table.
    it('still routes the email to the Billing Email', () => {
      const result = resolveInvoiceRecipient({ ...FULL, billingContact: '' });

      expect(result.billingEmail).toBe('nora@plan-manager.example.com');
    });
  });

  describe('Case B: Billing Email is blank', () => {
    it('addresses the participant under their own name and address', () => {
      const result = resolveInvoiceRecipient({ ...FULL, billingEmail: '' });

      expect(result).toEqual({
        recipientType: RECIPIENT_TYPE_CLIENT_PARTICIPANT,
        recipientName: 'Jane Smith',
        addressLines: ['5 Client Rd', 'Newtown', 'NSW 2042'],
        billingEmail: null,
      });
    });

    it('ignores a populated Billing Contact/Address when Billing Email is blank', () => {
      // The old dropdown-driven behaviour let a workspace pick "Billing
      // Contact" even when there was no Billing Email to send to; this is the
      // rule that replaces it — Billing Email presence alone decides.
      const result = resolveInvoiceRecipient({ ...FULL, billingEmail: '' });

      expect(result.recipientName).not.toBe('Nominee Nora');
      expect(result.addressLines).not.toEqual(['PO Box 1, Sydney NSW 2000']);
    });

    it('treats a whitespace-only Billing Email as blank', () => {
      const result = resolveInvoiceRecipient({ ...FULL, billingEmail: '   ' });

      expect(result.recipientType).toBe(RECIPIENT_TYPE_CLIENT_PARTICIPANT);
      expect(result.billingEmail).toBeNull();
    });

    it('omits missing address parts rather than leaving empty segments', () => {
      expect(resolveInvoiceRecipient({
        billingEmail: '', fullName: 'Jane', address: '', suburb: 'Newtown', state: 'NSW', postcode: '',
      }).addressLines).toEqual(['Newtown', 'NSW']);

      expect(resolveInvoiceRecipient({
        billingEmail: '', fullName: 'Jane', address: '', suburb: '', state: '', postcode: '2042',
      }).addressLines).toEqual(['2042']);
    });
  });

  it('returns empty/null values rather than throwing when called with nothing', () => {
    expect(resolveInvoiceRecipient()).toEqual({
      recipientType: RECIPIENT_TYPE_CLIENT_PARTICIPANT,
      recipientName: '',
      addressLines: [],
      billingEmail: null,
    });
  });

  // Numeric/label-object attribute values reach this resolver already
  // stringified by each call site's own reader; this only has to survive
  // whatever whitespace or nullish input each site passes through.
  it('coerces null and undefined fields to empty rather than throwing', () => {
    expect(() => resolveInvoiceRecipient({
      billingEmail: null, billingContact: undefined, billingAddress: null, fullName: undefined,
    })).not.toThrow();
  });
});

describe('readProfileRecipientAttributes', () => {
  const profileItem = {
    data: {
      'Billing Email': 'nora@plan-manager.example.com',
      'Billing Contact': 'Nominee Nora',
      'Billing Address': 'PO Box 1, Sydney NSW 2000',
      Address: '5 Client Rd',
      Suburb: 'Newtown',
      State: 'NSW',
      Postcode: '2042',
    },
  };
  const getValueFromFlatData = (item, name) => item?.data?.[name] ?? null;

  it('reads every attribute the resolver needs, off whatever reader the call site already has', () => {
    expect(readProfileRecipientAttributes(profileItem, getValueFromFlatData, 'Jane Smith')).toEqual({
      billingEmail: 'nora@plan-manager.example.com',
      billingContact: 'Nominee Nora',
      billingAddress: 'PO Box 1, Sydney NSW 2000',
      fullName: 'Jane Smith',
      address: '5 Client Rd',
      suburb: 'Newtown',
      state: 'NSW',
      postcode: '2042',
    });
  });

  it('falls back from Postcode to Post Code', () => {
    const altSpelling = {
      data: { ...profileItem.data, Postcode: undefined, 'Post Code': '2043' },
    };
    delete altSpelling.data.Postcode;

    const result = readProfileRecipientAttributes(altSpelling, getValueFromFlatData, 'Jane Smith');
    expect(result.postcode).toBe('2043');
  });

  it('never throws on a profile with no data at all', () => {
    expect(() => readProfileRecipientAttributes({}, getValueFromFlatData, '')).not.toThrow();
    expect(readProfileRecipientAttributes({}, getValueFromFlatData, '').billingEmail).toBe('');
  });
});

// KAN-298. State is a dropdown on the participant profile, so its stored value
// is an object. It used to be printed as "[object Object]".
describe('select-type profile attributes (KAN-298)', () => {
  const getValueFromFlatData = (item, name) => item?.data?.[name] ?? null;
  const SELECT = (name) => ({ id: 'uuid-1', name, color: '#FFFFFF' });

  it('reads a select State as its name', () => {
    const profileItem = { data: { Address: '13 Sample Street', Suburb: 'Sampletown', State: SELECT('NSW'), Postcode: 5000 } };

    const read = readProfileRecipientAttributes(profileItem, getValueFromFlatData, 'Jane Smith');

    expect(read.state).toBe('NSW');
    expect(read.postcode).toBe('5000');
  });

  it('reads a State stored as a list of select values', () => {
    const profileItem = { data: { State: [SELECT('VIC')] } };
    expect(readProfileRecipientAttributes(profileItem, getValueFromFlatData, 'Jane').state).toBe('VIC');
  });

  it('prints the participant address with the state name, for Case B and Case AA', () => {
    const profileItem = { data: { Address: '13 Sample Street', Suburb: 'Sampletown', State: SELECT('NSW'), Postcode: 5000 } };

    const recipient = resolveInvoiceRecipient(
      readProfileRecipientAttributes(profileItem, getValueFromFlatData, 'TEs TestSurname'),
    );

    expect(recipient.addressLines).toEqual(['13 Sample Street', 'Sampletown', 'NSW 5000']);
    expect(recipient.addressLines.join(' ')).not.toContain('[object Object]');
  });

  it('also copes when a select object is passed straight to the resolver', () => {
    const recipient = resolveInvoiceRecipient({
      fullName: 'Jane', address: '5 Rd', suburb: 'Newtown', state: SELECT('NSW'), postcode: 2042,
    });
    expect(recipient.addressLines).toEqual(['5 Rd', 'Newtown', 'NSW 2042']);
  });

  it('leaves the state out, not "[object Object]", when the select value has no readable text', () => {
    const recipient = resolveInvoiceRecipient({
      fullName: 'Jane', address: '5 Rd', suburb: 'Newtown', state: {}, postcode: 2042,
    });
    expect(recipient.addressLines).toEqual(['5 Rd', 'Newtown', '2042']);
  });
});

