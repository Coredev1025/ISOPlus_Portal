import { describe, it, expect } from 'vitest';
import { previousCalendarMonth, previousMonthServiceDeliveryWindow } from '../../../src/utils/automationPreviousMonth.js';
import { schedulePeriodServiceDeliveryWindow } from '../../../src/utils/automationScheduleWindow.js';
import {
  isNdisBoardLabel,
  canGenerateMonthlyStatement,
} from '../../../src/utils/automationBoardFlags.js';
import { parseReceivableDays, invoiceDatesFromSlot } from '../../../src/utils/automationInvoiceDates.js';
import { groupItemIdsByParticipant } from '../../../src/utils/automationInvoiceGrouping.js';

describe('previousCalendarMonth', () => {
  it('returns August 2026 for a 1 Sept 09:00 Sydney slot', () => {
    expect(previousCalendarMonth('2026-08-31T23:00:00.000Z', 'Australia/Sydney')).toEqual({
      year: '2026',
      monthNumber: '08',
      monthLabel: 'August',
    });
  });

  it('rolls the year on a January slot', () => {
    expect(previousCalendarMonth('2026-01-01T00:00:00.000Z', 'UTC')).toEqual({
      year: '2025',
      monthNumber: '12',
      monthLabel: 'December',
    });
  });
});

describe('previousMonthServiceDeliveryWindow', () => {
  it('maps an August Sydney slot to July Service Delivery Date bounds', () => {
    expect(previousMonthServiceDeliveryWindow('2026-08-14T05:09:00.000Z', 'Australia/Sydney')).toEqual({
      serviceDeliveryStart: '2026-06-30T14:00:00.000Z',
      serviceDeliveryEnd: '2026-07-31T13:59:59.999Z',
    });
  });
});

describe('schedulePeriodServiceDeliveryWindow', () => {
  const SLOT = '2026-08-14T05:09:00.000Z';
  const TZ = 'Australia/Sydney';

  it('uses the completed monthly period ending at the slot, not the previous calendar month', () => {
    // 14 Aug 15:09 Sydney minus one month is 14 Jul. The Invoice Generator
    // page's leftover pickers must not decide this — the claimed schedule does.
    expect(schedulePeriodServiceDeliveryWindow(SLOT, TZ, { every: { n: 1, unit: 'month' } })).toEqual({
      serviceDeliveryStart: '2026-07-13T14:00:00.000Z',
      serviceDeliveryEnd: '2026-08-13T13:59:59.999Z',
    });
  });

  it('uses the completed fortnight for every-2-weeks, not the previous calendar month', () => {
    expect(schedulePeriodServiceDeliveryWindow(SLOT, TZ, { every: { n: 2, unit: 'week' } })).toEqual({
      serviceDeliveryStart: '2026-07-30T14:00:00.000Z',
      serviceDeliveryEnd: '2026-08-13T13:59:59.999Z',
    });
  });

  it('falls back to the previous calendar month when the job has no picker', () => {
    expect(schedulePeriodServiceDeliveryWindow(SLOT, TZ, undefined)).toEqual(
      previousMonthServiceDeliveryWindow(SLOT, TZ),
    );
  });
});

describe('automationBoardFlags', () => {
  it('treats NDIS in the label as the NDIS Invoice Generator', () => {
    expect(isNdisBoardLabel('Care Management - NDIS')).toBe(true);
    expect(isNdisBoardLabel('NDIS')).toBe(true);
    expect(isNdisBoardLabel('Care Management')).toBe(false);
  });

  it('allows monthly statements only on Care Management that is not Low Cat', () => {
    expect(canGenerateMonthlyStatement('Care Management')).toBe(true);
    expect(canGenerateMonthlyStatement('Care Management - NDIS')).toBe(true);
    expect(canGenerateMonthlyStatement('Care Management - SaH - Low Cat')).toBe(false);
    expect(canGenerateMonthlyStatement('NDIS')).toBe(false);
  });
});

describe('invoiceDatesFromSlot', () => {
  it('defaults due date to 14 days when terms are missing', () => {
    expect(parseReceivableDays(undefined)).toBe(14);
    const { invoiceDate, dueDate } = invoiceDatesFromSlot('2026-08-14T09:00:00.000Z', '14 days');
    expect(invoiceDate).toBe('2026-08-14T09:00:00.000Z');
    expect(dueDate).toBe('2026-08-28T09:00:00.000Z');
  });
});

describe('groupItemIdsByParticipant', () => {
  it('groups Invoice Generator rows by participant and de-dupes item ids', () => {
    expect(groupItemIdsByParticipant([
      { sourceItemId: 'a', participant: 'Sam' },
      { sourceItemId: 'b', participant: 'Sam' },
      { sourceItemId: 'a', participant: 'Sam' },
      { sourceItemId: 'c', participant: 'Lee' },
    ], { idKey: 'sourceItemId', participantKey: 'participant' })).toEqual([
      { participant: 'Sam', itemIds: ['a', 'b'] },
      { participant: 'Lee', itemIds: ['c'] },
    ]);
  });
});
