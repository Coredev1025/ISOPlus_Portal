import { describe, it, expect } from 'vitest';

import {
  INVOICE_TYPE_IMS_JOB_MANAGEMENT,
  INVOICE_TYPE_NDIS_CERTIFICATION,
  INVOICE_TYPE_NDIS_VERIFICATION,
  INVOICE_TYPE_SAH,
  INVOICE_TYPE_SAH_LOW_CAT,
} from '../../../src/constants/invoiceSelection.js';
import { invoiceTypeFromBoardLabel } from '../../../src/utils/invoiceTypeFromLabel.js';

/**
 * The five board labels are the five invoice types in section 2.2 of the
 * invoice selection spec, and the mapping is what lets a scheduled run look up
 * the right row of the configuration table.
 */

describe('invoiceTypeFromBoardLabel', () => {
  it.each([
    ['Care Management - NDIS - Certification', INVOICE_TYPE_NDIS_CERTIFICATION],
    ['Care Management - NDIS - Verification', INVOICE_TYPE_NDIS_VERIFICATION],
    ['Care Management - SaH', INVOICE_TYPE_SAH],
    ['Care Management - SaH - Low Cat', INVOICE_TYPE_SAH_LOW_CAT],
    ['IMS Job Management', INVOICE_TYPE_IMS_JOB_MANAGEMENT],
  ])('maps %s', (label, expected) => {
    expect(invoiceTypeFromBoardLabel(label)).toBe(expected);
  });

  it('puts Low Cat ahead of plain SaH, since its label contains the other', () => {
    // 'Care Management - SaH - Low Cat' also matches a naive SaH test. Getting
    // this the wrong way round would bill Low Cat under the SaH configuration.
    expect(invoiceTypeFromBoardLabel('Care Management - SaH - Low Cat'))
      .toBe(INVOICE_TYPE_SAH_LOW_CAT);
  });

  it('is not confused by case or padding', () => {
    expect(invoiceTypeFromBoardLabel('  care management - ndis - certification  '))
      .toBe(INVOICE_TYPE_NDIS_CERTIFICATION);
  });

  it('returns null for a board that is not invoiceable', () => {
    expect(invoiceTypeFromBoardLabel('Participant Profile')).toBe(null);
    expect(invoiceTypeFromBoardLabel('')).toBe(null);
    expect(invoiceTypeFromBoardLabel(null)).toBe(null);
    expect(invoiceTypeFromBoardLabel(undefined)).toBe(null);
  });

  it('does not guess a type for an NDIS board with no certification or verification', () => {
    // The two NDIS types have different boards and identical conditions today,
    // but picking one arbitrarily would put the wrong invoiceType on the
    // ledger row. Unrecognised is the honest answer.
    expect(invoiceTypeFromBoardLabel('Care Management - NDIS')).toBe(null);
  });
});
