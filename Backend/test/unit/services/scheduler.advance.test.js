import { describe, it, expect } from 'vitest';
import { advanceSchedule } from '../../../src/services/scheduler/advance.js';

const TZ = 'Australia/Sydney';

describe('advanceSchedule', () => {
  it('uses cron arithmetic for a cron job', () => {
    const next = advanceSchedule(
      { cron: '0 9 * * *', timezone: TZ, schedule: null },
      new Date('2026-08-12T00:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-08-12T23:00:00.000Z'); // 09:00 Sydney next day
  });

  it('uses picker arithmetic for a schedule job', () => {
    const next = advanceSchedule(
      {
        cron: null,
        timezone: TZ,
        schedule: {
          every: { n: 2, unit: 'week' },
          runOn: 'monday',
          runAt: '09:00',
          startDate: new Date('2026-08-03T00:00:00+10:00'),
        },
      },
      new Date('2026-08-12T00:00:00Z'),
    );
    // 16 Aug 2026 09:00 Sydney (AEST, UTC+10) — the second Monday on/after
    // startDate that is strictly after `now`.
    expect(next.toISOString()).toBe('2026-08-16T23:00:00.000Z');
  });

  it('throws when a job has neither', () => {
    expect(() => advanceSchedule({ cron: null, schedule: null, timezone: TZ }, new Date()))
      .toThrow(/exactly one/i);
  });

  it('normalises a Date-valued startDate to the same instant as the equivalent string, so a series does not go off-phase', () => {
    // automationScheduleHelpers.parseStartDate only matches a YYYY-MM-DD
    // string. ScheduledJob.schedule.startDate and AutomationSettings'
    // block.startDate are both declared as Mongoose Date, so a real document
    // read from the DB hits this path, not the string path. Without
    // normalisation, parseStartDate silently fails to match `String(new
    // Date(...))` and computeNextRun falls back to anchoring on `now`,
    // permanently dropping the intended start date from the series.
    const baseSchedule = {
      every: { n: 1, unit: 'quarter' },
      runOn: 15,
      runAt: '09:00',
    };
    const now = new Date('2026-08-12T00:00:00Z');

    const withStringStartDate = advanceSchedule(
      { cron: null, timezone: TZ, schedule: { ...baseSchedule, startDate: '2026-01-15' } },
      now,
    );
    const withDateStartDate = advanceSchedule(
      {
        cron: null,
        timezone: TZ,
        schedule: { ...baseSchedule, startDate: new Date('2026-01-15') },
      },
      now,
    );

    expect(withStringStartDate.toISOString()).toBe('2026-10-14T22:00:00.000Z');
    expect(withDateStartDate.toISOString()).toBe(withStringStartDate.toISOString());
  });
});
