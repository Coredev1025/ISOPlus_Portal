import { describe, it, expect } from 'vitest';
import { collectBusinessProfileErrors } from '../../../src/validators/businessProfile.js';

describe('collectBusinessProfileErrors', () => {
  it('requires a valid business name', () => {
    const errors = collectBusinessProfileErrors({});
    expect(errors.some((e) => /Business name/i.test(e))).toBe(true);
  });

  it('accepts a minimal valid profile', () => {
    const errors = collectBusinessProfileErrors({ name: 'Acme' });
    expect(errors).toEqual([]);
  });

  // The domain labels either side of a dot are never empty. Shares
  // EMAIL_PATTERN with the automation settings, so both refuse the same typos.
  it.each(['a@b..com', 'a@.example.com', 'a@example.com.'])(
    'rejects the empty domain label in %s',
    (email) => {
      const errors = collectBusinessProfileErrors({ name: 'Acme', email });
      expect(errors).toContain('Invalid email format');
    },
  );

  it('accepts an ordinary address', () => {
    const errors = collectBusinessProfileErrors({
      name: 'Acme',
      email: 'billing@iso-plus.com.au',
    });
    expect(errors).toEqual([]);
  });

  it('validates phone, email, abn, acn, bsb formats', () => {
    const errors = collectBusinessProfileErrors({
      name: 'Acme',
      phone: 'bad',
      email: 'not-email',
      abn: '123',
      acn: '12',
      bsb: '12',
      accountNumber: '1',
    });
    expect(errors.length).toBeGreaterThan(3);
  });

  it('validates document numbering json', () => {
    const bad = collectBusinessProfileErrors({
      name: 'Acme',
      documentNumbering: '{',
    });
    expect(bad).toContain('Invalid document numbering format');

    const good = collectBusinessProfileErrors({
      name: 'Acme',
      documentNumbering: JSON.stringify({
        invoice: { prefix: 'INV-', nextNumber: 1000 },
      }),
    });
    expect(good).toEqual([]);
  });

  it('validates statement sequence fields in document numbering', () => {
    const errors = collectBusinessProfileErrors({
      name: 'Acme',
      documentNumbering: JSON.stringify({
        statement: { prefix: 'STATEMENT-TOOLONG', nextNumber: -1 },
      }),
    });
    expect(errors.some((e) => /statement prefix/i.test(e))).toBe(true);
    expect(errors.some((e) => /statement number/i.test(e))).toBe(true);
  });

  it('accepts a nextNumber of 0 for invoice, PO, quote, statement and statementOfAccount', () => {
    const errors = collectBusinessProfileErrors({
      name: 'Acme',
      documentNumbering: JSON.stringify({
        invoice: { prefix: 'INV-', nextNumber: 0 },
        purchaseOrder: { prefix: 'PO-', nextNumber: 0 },
        quote: { prefix: 'QT-', nextNumber: 0 },
        statement: { prefix: 'STM-', nextNumber: 0 },
        statementOfAccount: { prefix: 'SOA-', nextNumber: 0 },
      }),
    });
    expect(errors).toEqual([]);
  });

  it('validates statementOfAccount sequence fields in document numbering', () => {
    const errors = collectBusinessProfileErrors({
      name: 'Acme',
      documentNumbering: JSON.stringify({
        statementOfAccount: { prefix: 'STATEMENT-OF-ACCOUNT', nextNumber: -1 },
      }),
    });
    expect(errors.some((e) => /statementOfAccount prefix/i.test(e))).toBe(true);
    expect(errors.some((e) => /statementOfAccount number/i.test(e))).toBe(true);
  });

  it('accepts a valid statement numbering sequence', () => {
    const errors = collectBusinessProfileErrors({
      name: 'Acme',
      documentNumbering: JSON.stringify({
        statement: { prefix: 'STM-', nextNumber: 1 },
      }),
    });
    expect(errors).toEqual([]);
  });
});

// KAN-322: each page validates the fields it owns and nothing else, so a stored
// legacy value on the other page can never block a save.
describe('collectBusinessProfileErrors by section (KAN-322)', () => {
  const BAD_BANK = { bsb: '12', accountNumber: '1', bankAccountName: 'x'.repeat(101) };
  const BAD_IDENTITY = { abn: '123', acn: '12', phone: 'bad', email: 'nope', postcode: 'x' };
  const BAD_NUMBERING = { documentNumbering: '{' };

  describe('Business Configuration save', () => {
    it('rejects an invalid bank or numbering value that is sent, whichever page it claims to come from', () => {
      const errors = collectBusinessProfileErrors({
        section: 'business',
        name: 'Acme',
        ...BAD_BANK,
        ...BAD_NUMBERING,
      });
      expect(errors).toContain('BSB must be exactly 6 digits');
      expect(errors).toContain('Account number must be between 6 and 10 digits');
      expect(errors).toContain('Invalid document numbering format');
    });

    it('accepts a request that sends only the fields this page owns', () => {
      expect(collectBusinessProfileErrors({ section: 'business', name: 'Acme', abn: '51121558187' })).toEqual([]);
    });

    it('still requires the business name', () => {
      const errors = collectBusinessProfileErrors({ section: 'business' });
      expect(errors.some((e) => /Business name/i.test(e))).toBe(true);
    });

    it.each([
      ['ABN', { abn: '123' }, 'ABN must be exactly 11 digits'],
      ['ACN', { acn: '12' }, 'ACN must be exactly 9 digits'],
      ['phone', { phone: 'bad' }, 'Invalid phone number format'],
      ['email', { email: 'nope' }, 'Invalid email format'],
      ['postcode', { postcode: 'x' }, 'Invalid postcode format'],
    ])('still rejects an invalid %s', (_label, fields, message) => {
      const errors = collectBusinessProfileErrors({ section: 'business', name: 'Acme', ...fields });
      expect(errors).toContain(message);
    });
  });

  describe('Finance Settings save', () => {
    it('does not require a business name', () => {
      expect(collectBusinessProfileErrors({ section: 'finance' })).toEqual([]);
      expect(collectBusinessProfileErrors({ section: 'finance', bsb: '062000' })).toEqual([]);
    });

    it('rejects an invalid identity value that is sent, whichever page it claims to come from', () => {
      const errors = collectBusinessProfileErrors({ section: 'finance', ...BAD_IDENTITY });
      expect(errors).toContain('ABN must be exactly 11 digits');
      expect(errors).toContain('ACN must be exactly 9 digits');
      expect(errors).toContain('Invalid phone number format');
      expect(errors).toContain('Invalid email format');
      expect(errors).toContain('Invalid postcode format');
      expect(errors.some((e) => /Business name/i.test(e))).toBe(false);
    });

    it.each([
      ['BSB', { bsb: '12' }, 'BSB must be exactly 6 digits'],
      ['account number', { accountNumber: '1' }, 'Account number must be between 6 and 10 digits'],
      ['account name', { bankAccountName: 'x'.repeat(101) }, 'Bank account name must be less than 100 characters'],
      ['numbering json', { documentNumbering: '{' }, 'Invalid document numbering format'],
    ])('still rejects an invalid %s', (_label, fields, message) => {
      const errors = collectBusinessProfileErrors({ section: 'finance', ...fields });
      expect(errors).toContain(message);
    });

    it('still rejects a bad numbering prefix', () => {
      const errors = collectBusinessProfileErrors({
        section: 'finance',
        documentNumbering: JSON.stringify({ invoice: { prefix: 'WAY-TOO-LONG', nextNumber: 1 } }),
      });
      expect(errors.some((e) => /invoice prefix/i.test(e))).toBe(true);
    });
  });

  it('validates both sections when the request names none, as before', () => {
    const errors = collectBusinessProfileErrors({ ...BAD_BANK, ...BAD_IDENTITY });
    expect(errors).toContain('BSB must be exactly 6 digits');
    expect(errors).toContain('ABN must be exactly 11 digits');
    expect(errors.some((e) => /Business name/i.test(e))).toBe(true);
  });
});
