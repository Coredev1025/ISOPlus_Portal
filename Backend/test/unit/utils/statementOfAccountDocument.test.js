import { describe, it, expect } from 'vitest';

import { buildStatementDocument } from '../../../src/utils/statementOfAccountDocument.js';

const business = {
  name: 'Dev-Test11',
  abn: '12 345 678 901',
  address: {
    street: '1 Example St', suburb: 'Sydney', state: 'NSW', postcode: '2000', country: 'Australia',
  },
  bankDetails: {
    accountName: 'Dev-Test11 Pty Ltd', bankName: 'CBA', bsb: '062-000', accountNumber: '1234 5678',
  },
};

const profile = {
  data: {
    Address: '5 Client Rd', Suburb: 'Newtown', State: 'NSW', Postcode: '2042',
  },
};

const base = {
  business,
  profile,
  participant: 'Masoud Test',
  statementNumber: 'STMT-1026',
  period: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-31T23:59:59.999Z' },
  ledger: { rows: [], openingBalance: 0, closingBalance: 0, totalCharges: 0, totalPayments: 0 },
  ageing: {
    current: 0, d1to30: 0, d31to60: 0, d61to90: 0, d90plus: 0,
  },
};

describe('buildStatementDocument', () => {
  it('names the provider from the business profile', () => {
    const doc = buildStatementDocument(base);
    expect(doc.provider).toMatchObject({ name: 'Dev-Test11', abn: '12 345 678 901' });
    expect(doc.provider.address).toContain('1 Example St');
    expect(doc.provider.address).toContain('2000');
  });

  it('addresses the recipient from their profile', () => {
    const doc = buildStatementDocument(base);
    expect(doc.recipient.name).toBe('Masoud Test');
    expect(doc.recipient.address).toBe('5 Client Rd, Newtown, NSW 2042');
  });

  // KAN-298: State is a dropdown on the profile, so it is stored as an object.
  it('prints the name of a select State, never "[object Object]"', () => {
    const selectProfile = {
      data: {
        Address: '13 Sample Street', Suburb: 'Sampletown',
        State: { id: 'uuid-1', name: 'NSW', color: '#FFFFFF' }, Postcode: 5000,
      },
    };

    const doc = buildStatementDocument({ ...base, profile: selectProfile });

    expect(doc.recipient.address).toBe('13 Sample Street, Sampletown, NSW 5000');
    expect(JSON.stringify(doc)).not.toContain('[object Object]');
  });

  // A profile with no address still gets a statement — a blank address line is
  // survivable, refusing to state the account is not.
  it('leaves the address blank rather than failing when the profile has none', () => {
    const doc = buildStatementDocument({ ...base, profile: { data: {} } });
    expect(doc.recipient.address).toBe('');
  });

  /**
   * KAN-272. Recipient/address resolution is now Case A/AA/B, derived from
   * Billing Email/Billing Contact/Billing Address rather than always the
   * participant's own profile address.
   */
  describe('Case A/AA/B recipient resolution', () => {
    it('Case A: addresses the Billing Contact when Billing Email, Contact and Address are all present', () => {
      const doc = buildStatementDocument({
        ...base,
        profile: {
          data: {
            'Billing Email': 'nora@plan-manager.example.com',
            'Billing Contact': 'Nominee Nora',
            'Billing Address': 'PO Box 1, Sydney NSW 2000',
            Address: '5 Client Rd', Suburb: 'Newtown', State: 'NSW', Postcode: '2042',
          },
        },
      });

      expect(doc.recipient).toEqual({ name: 'Nominee Nora', address: 'PO Box 1, Sydney NSW 2000' });
    });

    it('Case AA: falls back to the participant\'s own name and address when Billing Contact is blank', () => {
      const doc = buildStatementDocument({
        ...base,
        participant: 'Masoud Test',
        profile: {
          data: {
            'Billing Email': 'nora@plan-manager.example.com',
            'Billing Address': 'PO Box 1, Sydney NSW 2000',
            Address: '5 Client Rd', Suburb: 'Newtown', State: 'NSW', Postcode: '2042',
          },
        },
      });

      expect(doc.recipient).toEqual({ name: 'Masoud Test', address: '5 Client Rd, Newtown, NSW 2042' });
    });

    // Case B (no Billing Email at all) is already covered above — the
    // original fixture profile carries no billing fields, and the recipient
    // is the participant under their own name and address.
  });

  it('carries the statement number and the period into the meta block', () => {
    const doc = buildStatementDocument(base);
    expect(doc.meta.statementNumber).toBe('STMT-1026');
    expect(doc.meta.periodStart).toBe(base.period.start);
    expect(doc.meta.periodEnd).toBe(base.period.end);
    // The account reference the spec asks for; the participant is the account.
    expect(doc.meta.accountNumber).toBe('Masoud Test');
  });

  it('takes the payment block from the same bank details the invoice uses', () => {
    const doc = buildStatementDocument(base);
    expect(doc.bank).toMatchObject({
      accountName: 'Dev-Test11 Pty Ltd', bankName: 'CBA', bsb: '062-000', accountNumber: '1234 5678',
    });
    // The reference tells the client what to put on the transfer.
    expect(doc.bank.reference).toBe('STMT-1026');
  });

  it('survives a business with no bank details recorded', () => {
    const doc = buildStatementDocument({ ...base, business: { name: 'X' } });
    expect(doc.bank.accountNumber).toBe('');
    expect(doc.provider.abn).toBe('');
  });
});

/**
 * KAN-229. The logo arrives already resolved — a data URI, not an S3 key.
 *
 * This module is pure and does no I/O by design, so reading the image out of
 * the store stays with the service that already loads the business.
 */
describe('buildStatementDocument — the business logo', () => {
  const LOGO = 'data:image/png;base64,AAAA';

  it('carries the resolved logo onto the provider block', () => {
    expect(buildStatementDocument({ ...base, logo: LOGO }).provider.logo).toBe(LOGO);
  });

  // A business with no Default Logo, and a logo the store could not return,
  // reach here the same way: as nothing. The statement still states the
  // account — the header simply falls back to text, which is what it does
  // today for every business.
  it('is an empty string when there is no logo', () => {
    expect(buildStatementDocument(base).provider.logo).toBe('');
    expect(buildStatementDocument({ ...base, logo: null }).provider.logo).toBe('');
  });
});
