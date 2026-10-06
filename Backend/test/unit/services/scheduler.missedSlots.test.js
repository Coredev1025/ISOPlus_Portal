import { describe, it, expect } from 'vitest';

import { missedSlotsFor, MAX_MISSED_WALK } from '../../../src/services/scheduler/missedSlots.js';

const TZ = 'Australia/Sydney';

/** A cron job due at `nextRunAt`. */
function cronJob(nextRunAt, cron = '*/30 * * * *') {
  return { cron, schedule: null, timezone: TZ, nextRunAt: new Date(nextRunAt) };
}

/** A picker job due at `nextRunAt`. */
function pickerJob(nextRunAt, every = { n: 1, unit: 'month' }) {
  return {
    cron: null,
    schedule: { every, runOn: 15, runAt: '09:00', startDate: null },
    timezone: TZ,
    nextRunAt: new Date(nextRunAt),
  };
}

describe('missedSlotsFor — cron, unchanged behaviour', () => {
  it('counts nothing when the due slot has not passed', () => {
    expect(missedSlotsFor(cronJob('2026-08-11T04:00:00Z'), new Date('2026-08-11T03:00:00Z'))).toBe(0);
  });

  it('counts nothing when now is the due slot', () => {
    expect(missedSlotsFor(cronJob('2026-08-11T04:00:00Z'), new Date('2026-08-11T04:00:00Z'))).toBe(0);
  });

  it('counts the half-hourly slots skipped over two hours', () => {
    // Due 04:00, now 06:00, every 30 minutes: 04:30, 05:00, 05:30 were missed.
    // 06:00 is the slot about to run, not a missed one.
    expect(missedSlotsFor(cronJob('2026-08-11T04:00:00Z'), new Date('2026-08-11T06:00:00Z'))).toBe(3);
  });
});

describe('missedSlotsFor — picker schedules', () => {
  it('counts nothing when the due slot has not passed', () => {
    expect(
      missedSlotsFor(pickerJob('2026-09-15T00:00:00Z'), new Date('2026-08-15T00:00:00Z')),
    ).toBe(0);
  });

  it('counts the monthly slots skipped while the scheduler was down', () => {
    // Due 15 Aug, back up 16 Nov: 15 Sep, 15 Oct and 15 Nov went by.
    const missed = missedSlotsFor(
      pickerJob('2026-08-14T23:00:00Z'),
      new Date('2026-11-16T00:00:00Z'),
    );
    expect(missed).toBe(3);
  });

  it('counts a multi-unit cadence in its own steps, not in months', () => {
    // Every 3 months from 15 Aug, back up 16 May: 15 Nov, 15 Feb and 15 May.
    // Nine calendar months elapsed; three slots, because the cadence is the
    // unit of counting.
    const missed = missedSlotsFor(
      pickerJob('2026-08-14T23:00:00Z', { n: 3, unit: 'month' }),
      new Date('2027-05-16T00:00:00Z'),
    );
    expect(missed).toBe(3);
  });

  it('returns zero rather than walking when the schedule has no unit', () => {
    const job = { cron: null, schedule: { every: {} }, timezone: TZ, nextRunAt: new Date(0) };
    expect(missedSlotsFor(job, new Date())).toBe(0);
  });

  it('caps the walk instead of looping for years of downtime', () => {
    const missed = missedSlotsFor(
      pickerJob('2026-08-14T23:00:00Z', { n: 1, unit: 'day' }),
      new Date('3026-08-14T23:00:00Z'),
    );
    expect(missed).toBe(MAX_MISSED_WALK);
  });
});

describe('missedSlotsFor — hydrated documents', () => {
  it('agrees with the lean row a Mongoose document was read from', async () => {
    const { default: ScheduledJob } = await import('../../../src/models/ScheduledJob.js');
    const schedule = { every: { n: 1, unit: 'month' }, runOn: 15, runAt: '09:00', startDate: null };
    const created = await ScheduledJob.create({
      kind: 'missed-slots-doc',
      targetId: 'ws-doc',
      cron: null,
      schedule,
      timezone: TZ,
      nextRunAt: new Date('2026-05-14T23:00:00Z'),
    });
    const lean = await ScheduledJob.findById(created._id).lean();
    const now = new Date('2026-08-16T00:00:00Z');

    // Spreading a Mongoose subdocument copies internals rather than fields,
    // so the picker schedule used to collapse to its defaults and this
    // returned 93 against the lean row's 3.
    expect(missedSlotsFor(created, now)).toBe(missedSlotsFor(lean, now));
    expect(missedSlotsFor(created, now)).toBe(3);
  });
});

describe('missedSlotsFor — malformed rows', () => {
  it('returns zero for a row carrying neither representation', () => {
    const job = { cron: null, schedule: null, timezone: TZ, nextRunAt: new Date(0) };
    expect(missedSlotsFor(job, new Date())).toBe(0);
  });

  it('returns zero when nextRunAt is missing', () => {
    expect(missedSlotsFor({ ...pickerJob('2026-08-14T23:00:00Z'), nextRunAt: null }, new Date())).toBe(0);
  });
});
