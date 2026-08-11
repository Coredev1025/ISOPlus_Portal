import { describe, it, expect } from 'vitest';
import {
  computeNextRun,
  countMissedSlots,
  isValidSchedule,
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
