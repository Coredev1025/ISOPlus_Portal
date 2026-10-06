import { describe, it, expect } from 'vitest';

import { invoicePeriodSuffix } from '../../../src/utils/invoicePeriodSuffix.js';

/**
 * The period a generated document covers, as a filename fragment.
 *
 * Two invoices for the same participant on the same board differ only by the
 * period they bill, and the filename did not say which — so a folder of them
 * was distinguishable only by opening each one. Arnold's suggestion, and the
 * shape is his:
 *
 *   INV-1006-ISO+™-Mike_Bird_2026-08-01_to_2026-08-31.pdf
 *
 * Empty for a document with no period. Manual generation has none, and its
 * filenames must not change.
 */

const SYD = 'Australia/Sydney';

describe('invoicePeriodSuffix', () => {
  it('renders the period as an ISO date range', () => {
    const suffix = invoicePeriodSuffix({
      start: '2026-07-31T14:00:00.000Z',
      end: '2026-08-31T13:59:59.999Z',
    }, SYD);
    expect(suffix).toBe('_2026-08-01_to_2026-08-31');
  });

  it('resolves the day in the business timezone, not UTC', () => {
    // 2026-07-31T14:00Z is 1 August in Sydney. Formatting in UTC would name
    // the period a day early at both ends, and the filename is what a person
    // reconciles against.
    const suffix = invoicePeriodSuffix({
      start: '2026-07-31T14:00:00.000Z',
      end: '2026-08-31T13:59:59.999Z',
    }, SYD);
    expect(suffix).toContain('2026-08-01');
    expect(suffix).not.toContain('2026-07-31');
  });

  it('is empty when there is no period, so manual filenames are unchanged', () => {
    expect(invoicePeriodSuffix(null, SYD)).toBe('');
    expect(invoicePeriodSuffix(undefined, SYD)).toBe('');
    expect(invoicePeriodSuffix({}, SYD)).toBe('');
  });

  it('is empty when only one bound is present, rather than half a range', () => {
    expect(invoicePeriodSuffix({ start: '2026-08-01T00:00:00Z' }, SYD)).toBe('');
    expect(invoicePeriodSuffix({ end: '2026-08-31T00:00:00Z' }, SYD)).toBe('');
  });

  it('is empty when a bound does not parse', () => {
    expect(invoicePeriodSuffix({ start: 'not-a-date', end: '2026-08-31T00:00:00Z' }, SYD)).toBe('');
  });

  it('contains nothing that needs escaping in an S3 key', () => {
    const suffix = invoicePeriodSuffix({
      start: '2026-07-31T14:00:00.000Z',
      end: '2026-08-31T13:59:59.999Z',
    }, SYD);
    expect(suffix).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
