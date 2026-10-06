import { describe, it, expect } from 'vitest';

import { statementPeriodForSchedule } from '../../../src/utils/automationStatementPeriod.js';

/**
 * Section 4.1 of the invoice selection spec: the statement period is
 * configured separately from invoicing and can be weekly or monthly. Before
 * this helper existed the statement path ignored the configured cadence
 * entirely, so a weekly schedule restated the whole previous calendar month
 * every week, each time under a fresh statement number.
 */
describe('statementPeriodForSchedule', () => {
  const TZ = 'Australia/Sydney';
  // 14 August 2026, 15:09 in Sydney.
  const SLOT = '2026-08-14T05:09:00.000Z';

  const CALENDAR_JULY = {
    serviceDeliveryStart: '2026-06-30T14:00:00.000Z',
    serviceDeliveryEnd: '2026-07-31T13:59:59.999Z',
  };

  it('is the previous calendar month when no schedule reaches it', () => {
    const period = statementPeriodForSchedule(SLOT, TZ, undefined);
    expect(period.window).toEqual(CALENDAR_JULY);
    expect(period.budgetPeriod).toEqual({ year: '2026', monthNumber: '07', monthLabel: 'July' });
  });

  // The behaviour characterized in automationPreviousMonth.test.js, which a
  // monthly workspace must keep byte for byte. Note this is NOT what stepping
  // one month back from the slot day gives: that would be 13 July – 13 August.
  it('is the previous calendar month on a monthly cadence, whatever day it fires', () => {
    const period = statementPeriodForSchedule(SLOT, TZ, { every: { n: 1, unit: 'month' } });
    expect(period.window).toEqual(CALENDAR_JULY);
    expect(period.budgetPeriod).toEqual({ year: '2026', monthNumber: '07', monthLabel: 'July' });
  });

  it('is the week that just ended on a weekly cadence', () => {
    const period = statementPeriodForSchedule(SLOT, TZ, { every: { n: 1, unit: 'week' } });
    expect(period.window).toEqual({
      // 7 August 00:00 +10:00 through the last millisecond of 13 August.
      serviceDeliveryStart: '2026-08-06T14:00:00.000Z',
      serviceDeliveryEnd: '2026-08-13T13:59:59.999Z',
    });
  });

  it('is the fortnight that just ended on a two-week cadence', () => {
    const period = statementPeriodForSchedule(SLOT, TZ, { every: { n: 2, unit: 'week' } });
    expect(period.window).toEqual({
      serviceDeliveryStart: '2026-07-30T14:00:00.000Z',
      serviceDeliveryEnd: '2026-08-13T13:59:59.999Z',
    });
  });

  /**
   * The budget statement's own template is a calendar-month document: its
   * fixed text says "the services you received in the previous calendar
   * month", its budget rows are fetched by month and year, and its quarter
   * banner is derived from a month number. A week has no honest month label to
   * put on it, so the period says there is none rather than naming the month
   * the week happens to fall in.
   */
  it('offers no budget-statement month for a period shorter than a month', () => {
    for (const every of [{ n: 1, unit: 'week' }, { n: 2, unit: 'week' }, { n: 3, unit: 'day' }]) {
      expect(statementPeriodForSchedule(SLOT, TZ, { every }).budgetPeriod).toBeNull();
    }
  });

  it('offers no budget-statement month for a period longer than a month', () => {
    for (const every of [{ n: 2, unit: 'month' }, { n: 1, unit: 'quarter' }, { n: 1, unit: 'year' }]) {
      expect(statementPeriodForSchedule(SLOT, TZ, { every }).budgetPeriod).toBeNull();
    }
  });
});
