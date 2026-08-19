import { describe, it, expect } from 'vitest';

import {
  appendXeroLineDateSuffix,
  xeroRound2,
  xeroRound4,
  xeroServiceRowDate,
} from '../../../src/utils/xeroLineFormatting.js';

/**
 * These rules were private to routes/xero.js and are now shared with the
 * scheduled push, so both paths shape a Xero line identically. Characterized
 * against the extracted behaviour: nothing here is new, and any difference
 * between an invoice pushed from the page and one pushed by a schedule would
 * show up as a failure in this file.
 */
describe('xeroRound2 / xeroRound4', () => {
  it('rounds money to two places and a unit price to four', () => {
    expect(xeroRound2(131.004)).toBe(131);
    expect(xeroRound2(131.005)).toBe(131.01);
    expect(xeroRound4(65.123456)).toBe(65.1235);
  });

  // The Number.EPSILON nudge, and the reason it is there: Math.round(1.005*100)
  // is 100 in binary floating point, so a half-cent line amount would round
  // DOWN and the invoice would not add up.
  it('rounds a half-cent up rather than down', () => {
    expect(xeroRound2(1.005)).toBe(1.01);
    expect(xeroRound2(8.615)).toBe(8.62);
  });

  it('reads numeric strings', () => {
    expect(xeroRound2('131.006')).toBe(131.01);
  });

  // A NaN reaching a Xero line amount is rejected by the API with a message
  // that names nothing useful, so it is never allowed to get there.
  it.each([undefined, null, '', 'abc', {}, NaN, Infinity])('turns %j into 0', (value) => {
    expect(xeroRound2(value)).toBe(0);
    expect(xeroRound4(value)).toBe(0);
  });

  it('keeps a negative amount negative', () => {
    expect(xeroRound2(-20.005)).toBe(-20);
  });
});

describe('xeroServiceRowDate', () => {
  const delivered = 'Delivered - To be claimed and invoiced.';

  it('dates a delivered row on the day it was delivered', () => {
    expect(xeroServiceRowDate({
      transactionStatus: delivered,
      serviceDeliveryDate: '2026-03-04',
      scheduledServiceDate: '2026-03-01',
    })).toBe('2026-03-04');
  });

  it('dates anything else on the day it was scheduled', () => {
    expect(xeroServiceRowDate({
      transactionStatus: 'Scheduled - Not yet delivered.',
      serviceDeliveryDate: '2026-03-04',
      scheduledServiceDate: '2026-03-01',
    })).toBe('2026-03-01');
  });

  it('matches any status beginning with "delivered", whatever its case', () => {
    expect(xeroServiceRowDate({
      transactionStatus: 'DELIVERED and adjusted',
      serviceDeliveryDate: '2026-03-04',
      scheduledServiceDate: '2026-03-01',
    })).toBe('2026-03-04');
  });

  // A row carrying only one of the two dates still has to be dated.
  it('falls back to the other date when the preferred one is absent', () => {
    expect(xeroServiceRowDate({ transactionStatus: delivered, scheduledServiceDate: '2026-03-01' }))
      .toBe('2026-03-01');
    expect(xeroServiceRowDate({ transactionStatus: 'Scheduled', serviceDeliveryDate: '2026-03-04' }))
      .toBe('2026-03-04');
  });

  it('returns an empty string for a row with neither', () => {
    expect(xeroServiceRowDate({ transactionStatus: delivered })).toBe('');
    expect(xeroServiceRowDate(undefined)).toBe('');
  });
});

describe('appendXeroLineDateSuffix', () => {
  it('appends the row date to the description', () => {
    expect(appendXeroLineDateSuffix('Assistance', '16/12/2025')).toBe('Assistance - 16/12/2025');
  });

  // A replayed push must not produce 'Service - 01/02/2025 - 01/02/2025'.
  it('is idempotent', () => {
    const once = appendXeroLineDateSuffix('Assistance', '16/12/2025');
    expect(appendXeroLineDateSuffix(once, '16/12/2025')).toBe(once);
  });

  it('leaves the description alone when there is no date', () => {
    expect(appendXeroLineDateSuffix('Assistance', '')).toBe('Assistance');
  });

  it('falls back to "Service" for a blank description', () => {
    expect(appendXeroLineDateSuffix('   ', '16/12/2025')).toBe('Service - 16/12/2025');
  });

  // The date goes into a regular expression, so a description that happens to
  // contain regex metacharacters must not change what "already suffixed" means.
  it('treats the date as a literal, not a pattern', () => {
    expect(appendXeroLineDateSuffix('Assistance - 16.12.2025', '16/12/2025'))
      .toBe('Assistance - 16.12.2025 - 16/12/2025');
  });
});
