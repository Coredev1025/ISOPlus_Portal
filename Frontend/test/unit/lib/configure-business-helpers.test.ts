import { describe, it, expect } from 'vitest';

import {
  cloneDefaultSequences,
  DEFAULT_SEQUENCES,
  extractDocumentNumberingSequences,
  mapBusinessProfileToFormData,
} from '@/lib/configure-business-helpers';

/**
 * Shaped like a real GET /api/business/profile response — see
 * Backend/src/models/Business.js and Backend/src/utils/businessProfileUpdate.js.
 */
const PROFILE = {
  _id: '65f2a1b9c4d3e2f10a9b8c77',
  workspaceId: 'ws-0001-should-be-ignored',
  name: 'Hillsgrade Care Services Pty Ltd',
  defaultLogo: 'business-logos/ws-4471/default-1739412000000.png',
  squareLogo: 'business-logos/ws-4471/square-1739412000000.png',
  wideLogo: null,
  address: {
    street: '12 Grafton Street',
    country: 'Australia',
    suburb: 'Bondi Junction',
    state: 'NSW',
    postcode: '2022',
  },
  phone: '+61 2 9387 1122',
  email: 'accounts@hillsgradecare.com.au',
  abn: '51 824 753 556',
  acn: '824 753 556',
  companyRegistrationId: 'NDIS-4050012345',
  xeroIntegrated: true,
  bankDetails: {
    accountName: 'Hillsgrade Care Services Pty Ltd',
    bankName: 'Commonwealth Bank of Australia',
    bsb: '062-000',
    accountNumber: '12345678',
    paymentReference: 'INVOICE NUMBER',
    accountsReceivableTerms: 'Net 14',
    accountsPayableTerms: 'Net 30',
  },
  headOfficeTimezone: 'Australia/Brisbane',
  documentNumbering: {
    invoice: { prefix: 'INV-', nextNumber: 1042 },
    purchaseOrder: { prefix: 'PO-', nextNumber: 1000 },
    quote: { prefix: 'QT-', nextNumber: 1007 },
  },
};

describe('mapBusinessProfileToFormData', () => {
  it('flattens a full profile into the flat form shape', () => {
    expect(mapBusinessProfileToFormData(PROFILE, 'ws-4471')).toEqual({
      name: 'Hillsgrade Care Services Pty Ltd',
      phone: '+61 2 9387 1122',
      email: 'accounts@hillsgradecare.com.au',
      companyRegistrationId: 'NDIS-4050012345',
      street: '12 Grafton Street',
      country: 'Australia',
      suburb: 'Bondi Junction',
      state: 'NSW',
      postcode: '2022',
      abn: '51 824 753 556',
      acn: '824 753 556',
      workspaceId: 'ws-4471',
      bankAccountName: 'Hillsgrade Care Services Pty Ltd',
      bankName: 'Commonwealth Bank of Australia',
      bsb: '062-000',
      accountNumber: '12345678',
      paymentReference: 'INVOICE NUMBER',
      accountsReceivableTerms: 'Net 14',
      accountsPayableTerms: 'Net 30',
      headOfficeTimezone: 'Australia/Brisbane',
    });
  });

  it('uses the workspaceId argument and ignores the one stored on the record', () => {
    expect(mapBusinessProfileToFormData(PROFILE, 'ws-4471').workspaceId).toBe('ws-4471');
  });

  it('does not carry through fields the form does not own', () => {
    const result = mapBusinessProfileToFormData(PROFILE, 'ws-4471');

    expect(Object.keys(result).sort()).toEqual([
      'abn',
      'accountNumber',
      'accountsPayableTerms',
      'accountsReceivableTerms',
      'acn',
      'bankAccountName',
      'bankName',
      'bsb',
      'companyRegistrationId',
      'country',
      'email',
      'headOfficeTimezone',
      'name',
      'paymentReference',
      'phone',
      'postcode',
      'state',
      'street',
      'suburb',
      'workspaceId',
    ]);
  });

  it('turns an empty profile into empty strings and the Sydney timezone default', () => {
    expect(mapBusinessProfileToFormData({}, 'ws-4471')).toEqual({
      name: '',
      phone: '',
      email: '',
      companyRegistrationId: '',
      street: '',
      country: '',
      suburb: '',
      state: '',
      postcode: '',
      abn: '',
      acn: '',
      workspaceId: 'ws-4471',
      bankAccountName: '',
      bankName: '',
      bsb: '',
      accountNumber: '',
      paymentReference: '',
      accountsReceivableTerms: '',
      accountsPayableTerms: '',
      headOfficeTimezone: 'Australia/Sydney',
    });
  });

  it('blanks the address fields when the address subdocument is absent', () => {
    const result = mapBusinessProfileToFormData(
      { name: 'Hillsgrade Care Services Pty Ltd', phone: '+61 2 9387 1122' },
      'ws-4471',
    );

    expect(result.street).toBe('');
    expect(result.country).toBe('');
    expect(result.suburb).toBe('');
    expect(result.state).toBe('');
    expect(result.postcode).toBe('');
  });

  it('blanks the bank fields when the bankDetails subdocument is absent', () => {
    const result = mapBusinessProfileToFormData({ name: 'Hillsgrade Care' }, 'ws-4471');

    expect(result.bankAccountName).toBe('');
    expect(result.bankName).toBe('');
    expect(result.bsb).toBe('');
    expect(result.accountNumber).toBe('');
    expect(result.paymentReference).toBe('');
    expect(result.accountsReceivableTerms).toBe('');
    expect(result.accountsPayableTerms).toBe('');
  });

  it('blanks a partially filled address and bank record field by field', () => {
    const result = mapBusinessProfileToFormData(
      {
        address: { street: '12 Grafton Street', state: null },
        bankDetails: { bsb: '062-000', accountNumber: undefined },
      },
      'ws-4471',
    );

    expect(result.street).toBe('12 Grafton Street');
    expect(result.state).toBe('');
    expect(result.bsb).toBe('062-000');
    expect(result.accountNumber).toBe('');
  });

  it('replaces an empty headOfficeTimezone with the Sydney default but keeps a real one', () => {
    expect(mapBusinessProfileToFormData({ headOfficeTimezone: '' }, 'ws').headOfficeTimezone).toBe(
      'Australia/Sydney',
    );
    expect(
      mapBusinessProfileToFormData({ headOfficeTimezone: null }, 'ws').headOfficeTimezone,
    ).toBe('Australia/Sydney');
    expect(
      mapBusinessProfileToFormData({ headOfficeTimezone: 'Australia/Perth' }, 'ws')
        .headOfficeTimezone,
    ).toBe('Australia/Perth');
  });

  it('passes an empty workspaceId through unchanged rather than defaulting it', () => {
    expect(mapBusinessProfileToFormData(PROFILE, '').workspaceId).toBe('');
  });

  it('coerces a numeric postcode to the empty string, since only truthy values survive', () => {
    expect(mapBusinessProfileToFormData({ address: { postcode: 0 } }, 'ws').postcode).toBe('');
    expect(mapBusinessProfileToFormData({ address: { postcode: 2022 } }, 'ws').postcode).toBe(2022);
  });

  it('does not mutate the profile it was given', () => {
    const input = JSON.parse(JSON.stringify(PROFILE));
    mapBusinessProfileToFormData(input, 'ws-4471');

    expect(input).toEqual(JSON.parse(JSON.stringify(PROFILE)));
  });
});

describe('cloneDefaultSequences', () => {
  it('returns STM- copies that callers can mutate without changing the shared defaults', () => {
    const cloned = cloneDefaultSequences();

    expect(cloned).toEqual(DEFAULT_SEQUENCES);
    expect(cloned.statement.prefix).toBe('STM-');
    expect(cloned.invoice).not.toBe(DEFAULT_SEQUENCES.invoice);

    cloned.invoice.prefix = 'X-';
    expect(DEFAULT_SEQUENCES.invoice.prefix).toBe('INV-');
  });
});

describe('extractDocumentNumberingSequences', () => {
  it('returns all four sequences from a full record, defaulting any missing ones', () => {
    expect(extractDocumentNumberingSequences(PROFILE)).toEqual({
      invoice: { prefix: 'INV-', nextNumber: 1042 },
      purchaseOrder: { prefix: 'PO-', nextNumber: 1000 },
      quote: { prefix: 'QT-', nextNumber: 1007 },
      statement: { prefix: 'STM-', nextNumber: 1000 },
    });
  });

  it('returns schema defaults when documentNumbering is absent', () => {
    expect(extractDocumentNumberingSequences({ name: 'Hillsgrade Care' })).toEqual({
      invoice: { prefix: 'INV-', nextNumber: 1000 },
      purchaseOrder: { prefix: 'PO-', nextNumber: 1000 },
      quote: { prefix: 'QT-', nextNumber: 1000 },
      statement: { prefix: 'STM-', nextNumber: 1000 },
    });
  });

  it('returns schema defaults when documentNumbering is present but empty', () => {
    expect(extractDocumentNumberingSequences({ documentNumbering: {} })).toEqual({
      invoice: { prefix: 'INV-', nextNumber: 1000 },
      purchaseOrder: { prefix: 'PO-', nextNumber: 1000 },
      quote: { prefix: 'QT-', nextNumber: 1000 },
      statement: { prefix: 'STM-', nextNumber: 1000 },
    });
  });

  it('keeps present sequences and defaults only the ones that are missing', () => {
    expect(
      extractDocumentNumberingSequences({
        documentNumbering: { invoice: { prefix: 'INV-', nextNumber: 1042 } },
      }),
    ).toEqual({
      invoice: { prefix: 'INV-', nextNumber: 1042 },
      purchaseOrder: { prefix: 'PO-', nextNumber: 1000 },
      quote: { prefix: 'QT-', nextNumber: 1000 },
      statement: { prefix: 'STM-', nextNumber: 1000 },
    });
  });

  it('returns new sequence objects so callers can set state without mutating the record', () => {
    const invoice = { prefix: 'INV-', nextNumber: 1042 };
    const result = extractDocumentNumberingSequences({ documentNumbering: { invoice } });

    expect(result.invoice).toEqual(invoice);
    expect(result.invoice).not.toBe(invoice);
  });

  it('normalises a null documentNumbering to schema defaults rather than throwing', () => {
    expect(extractDocumentNumberingSequences({ documentNumbering: null })).toEqual({
      invoice: { prefix: 'INV-', nextNumber: 1000 },
      purchaseOrder: { prefix: 'PO-', nextNumber: 1000 },
      quote: { prefix: 'QT-', nextNumber: 1000 },
      statement: { prefix: 'STM-', nextNumber: 1000 },
    });
  });
});
