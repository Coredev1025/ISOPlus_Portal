import { describe, it, expect } from 'vitest';

import { missingDocumentBranding } from '../../../src/utils/businessDocumentReadiness.js';

/**
 * What a generated invoice is missing from the business profile.
 *
 * Arnold asked why a generated PDF had no logo and no bank details. The answer
 * was that the workspace had never set them — but nothing anywhere said so.
 * The document generates happily, reaches a client, and the only signal is a
 * human noticing the blank space.
 *
 * Bank details are the serious half: an invoice with no account number cannot
 * be paid. A missing logo is cosmetic. They are reported separately for that
 * reason.
 */

const complete = () => ({
  defaultLogo: 'logos/55390/logo.png',
  bankDetails: {
    accountName: 'ISO Consulting Services',
    bankName: 'Example Bank',
    bsb: '000-000',
    accountNumber: '12345678',
  },
});

describe('missingDocumentBranding', () => {
  it('reports nothing for a complete profile', () => {
    expect(missingDocumentBranding(complete())).toEqual([]);
  });

  it('reports a missing logo', () => {
    const business = complete();
    delete business.defaultLogo;
    expect(missingDocumentBranding(business)).toEqual(['defaultLogo']);
  });

  it('reports each missing bank field by name', () => {
    const business = complete();
    business.bankDetails.accountNumber = '';
    business.bankDetails.bsb = '   ';
    expect(missingDocumentBranding(business)).toEqual(['bankDetails.bsb', 'bankDetails.accountNumber']);
  });

  it('reports every bank field when bankDetails is absent entirely', () => {
    const business = complete();
    delete business.bankDetails;
    expect(missingDocumentBranding(business)).toEqual([
      'defaultLogo' in business ? 'bankDetails.accountName' : 'bankDetails.accountName',
      'bankDetails.bankName',
      'bankDetails.bsb',
      'bankDetails.accountNumber',
    ]);
  });

  it('treats a whitespace-only value as missing', () => {
    // A field someone tabbed through is not a configured field, and renders as
    // blank space on the document exactly like an empty one.
    const business = complete();
    business.defaultLogo = '   ';
    expect(missingDocumentBranding(business)).toContain('defaultLogo');
  });

  it('handles a null business without throwing', () => {
    // Generation already refuses without a business, but this runs on the
    // logging path and must never be the thing that breaks a run.
    expect(() => missingDocumentBranding(null)).not.toThrow();
    expect(missingDocumentBranding(null).length).toBeGreaterThan(0);
  });
});
