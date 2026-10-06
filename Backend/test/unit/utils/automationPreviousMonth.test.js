import { describe, it, expect } from 'vitest';

import {
  previousCalendarMonth,
  previousMonthServiceDeliveryWindow,
} from '../../../src/utils/automationPreviousMonth.js';

/**
 * Characterization, written before the statement period was made
 * cadence-aware and deliberately pinned to literals rather than recomputed
 * from the same helpers it checks.
 *
 * A statement run on a monthly cadence must keep producing exactly these
 * bounds and exactly these labels after that change: the numbers below are
 * what a customer's August statement says today, and a shift of one day either
 * way moves a service off one statement and onto another.
 */
describe('the previous calendar month, as statements have always computed it', () => {
  const TZ = 'Australia/Sydney';

  // 14 August 2026, 15:09 in Sydney. Mid-month on purpose: the calendar-month
  // window does not depend on which day the schedule fires.
  const MID_MONTH_SLOT = '2026-08-14T05:09:00.000Z';

  it('labels the month before the slot, in the schedule timezone', () => {
    expect(previousCalendarMonth(MID_MONTH_SLOT, TZ)).toEqual({
      year: '2026',
      monthNumber: '07',
      monthLabel: 'July',
    });
  });

  it('bounds the whole of that month, in that timezone', () => {
    expect(previousMonthServiceDeliveryWindow(MID_MONTH_SLOT, TZ)).toEqual({
      // 1 July 00:00 +10:00 through the last millisecond of 31 July.
      serviceDeliveryStart: '2026-06-30T14:00:00.000Z',
      serviceDeliveryEnd: '2026-07-31T13:59:59.999Z',
    });
  });

  // The slot the statement-of-account integration test runs on: 1 September
  // 23:00 in Sydney, which is still 1 September locally and must resolve to
  // August, not to July.
  it('resolves the day-boundary slot in the schedule timezone, not in UTC', () => {
    const SLOT = '2026-09-01T13:00:00.000Z';
    expect(previousCalendarMonth(SLOT, TZ)).toEqual({
      year: '2026',
      monthNumber: '08',
      monthLabel: 'August',
    });
    expect(previousMonthServiceDeliveryWindow(SLOT, TZ)).toEqual({
      serviceDeliveryStart: '2026-07-31T14:00:00.000Z',
      serviceDeliveryEnd: '2026-08-31T13:59:59.999Z',
    });
  });
});
