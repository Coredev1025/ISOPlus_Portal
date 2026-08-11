import { describe, it, expect } from 'vitest';
import {
  computeNextRun,
  countMissedSlots,
  isValidSchedule,
  minIntervalMinutes,
} from '../../../src/services/scheduler/nextRun.js';

const TZ = 'Australia/Sydney';

describe('computeNextRun', () => {
  it('resolves a monthly slot to the correct UTC instant across a month boundary', () => {
    // 1 Sep 2026 02:00 in Sydney is 31 Aug 2026 16:00 UTC. The local date and
    // the UTC date are in different months, which is what breaks naive handling.
    const next = computeNextRun('0 2 1 * *', TZ, new Date('2026-08-15T00:00:00Z'));
    expect(next.toISOString()).toBe('2026-08-31T16:00:00.000Z');
  });

  it('rolls forward when the local time does not exist (DST starts)', () => {
    // Sydney clocks jump 02:00 -> 03:00 on 4 Oct 2026, so 02:30 never happens.
    const next = computeNextRun('30 2 * * *', TZ, new Date('2026-10-03T14:00:00Z'));
    expect(next.toISOString()).toBe('2026-10-03T16:30:00.000Z');
  });

  it('takes the first occurrence when the local time happens twice (DST ends)', () => {
    // Sydney clocks fall back on 5 Apr 2026, so 02:30 happens twice.
    const next = computeNextRun('30 2 * * *', TZ, new Date('2026-04-04T14:00:00Z'));
    expect(next.toISOString()).toBe('2026-04-04T15:30:00.000Z');
  });

  it('handles a simple interval expression', () => {
    const next = computeNextRun('*/30 * * * *', TZ, new Date('2026-08-11T04:05:00Z'));
    expect(next.toISOString()).toBe('2026-08-11T04:30:00.000Z');
  });
});

describe('countMissedSlots', () => {
  it('counts the slots skipped between the due time and now', () => {
    const missed = countMissedSlots(
      '*/30 * * * *',
      TZ,
      new Date('2026-08-11T00:00:00Z'),
      new Date('2026-08-11T03:00:00Z'),
    );
    expect(missed).toBe(5);
  });

  it('is zero when the schedule is not yet due', () => {
    const missed = countMissedSlots(
      '*/30 * * * *',
      TZ,
      new Date('2026-08-11T03:00:00Z'),
      new Date('2026-08-11T00:00:00Z'),
    );
    expect(missed).toBe(0);
  });

  it('is zero when only the due slot itself has passed', () => {
    const missed = countMissedSlots(
      '*/30 * * * *',
      TZ,
      new Date('2026-08-11T00:00:00Z'),
      new Date('2026-08-11T00:29:00Z'),
    );
    expect(missed).toBe(0);
  });

  it('stops at the cap rather than looping forever', () => {
    const missed = countMissedSlots(
      '*/30 * * * *',
      TZ,
      new Date('2020-01-01T00:00:00Z'),
      new Date('2026-01-01T00:00:00Z'),
      10,
    );
    expect(missed).toBe(10);
  });
});

describe('minIntervalMinutes', () => {
  it('returns the constant gap for a simple interval expression', () => {
    const minutes = minIntervalMinutes('*/30 * * * *', TZ, new Date('2026-08-11T00:00:00Z'));
    expect(minutes).toBe(30);
  });

  it('returns the smallest gap, not the average, for a mixed-cadence expression', () => {
    // Fires hourly from 9am-5pm and not at all overnight, so most gaps are 60
    // minutes but one gap per day is much larger. The floor check cares about
    // the smallest gap a hand-edited cron could actually produce.
    const minutes = minIntervalMinutes('0 9-17 * * *', TZ, new Date('2026-08-11T00:00:00Z'));
    expect(minutes).toBe(60);
  });

  it('does not spuriously shrink or invert across a Sydney DST transition', () => {
    // Sydney clocks fall back on 5 Apr 2026 (03:00 -> 02:00), so the walk
    // below crosses a transition where a naive implementation could compute a
    // zero or negative gap. A daily cron's true minimum gap should still be a
    // healthy number of hours, nowhere near the 60-minute at-most-once floor.
    const minutes = minIntervalMinutes(
      '0 2 * * *',
      TZ,
      new Date('2026-04-03T12:00:00Z'), // a couple of days before the transition
    );
    expect(minutes).toBeGreaterThanOrEqual(23 * 60);
  });

  it('walks from the given reference time, not from a fixed slot', () => {
    const early = minIntervalMinutes('*/30 * * * *', TZ, new Date('2026-08-11T00:00:00Z'));
    const later = minIntervalMinutes('*/30 * * * *', TZ, new Date('2026-08-11T06:00:00Z'));
    expect(early).toBe(later);
  });
});

describe('isValidSchedule', () => {
  it('accepts a valid expression and timezone', () => {
    expect(isValidSchedule('*/30 * * * *', TZ)).toBe(true);
  });

  it('rejects an invalid cron expression', () => {
    expect(isValidSchedule('not-a-cron', TZ)).toBe(false);
  });

  it('rejects an unknown timezone', () => {
    // cron-parser accepts this at parse time and only fails inside next(),
    // so validation has to go through Intl.
    expect(isValidSchedule('*/30 * * * *', 'Mars/Olympus')).toBe(false);
  });

  it('rejects a missing timezone rather than falling back to the system zone', () => {
    expect(isValidSchedule('*/30 * * * *', undefined)).toBe(false);
    expect(isValidSchedule('*/30 * * * *', '')).toBe(false);
  });
});
