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
        statement: { prefix: 'STATEMENT-TOOLONG', nextNumber: 0 },
      }),
    });
    expect(errors.some((e) => /statement prefix/i.test(e))).toBe(true);
    expect(errors.some((e) => /statement number/i.test(e))).toBe(true);
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
