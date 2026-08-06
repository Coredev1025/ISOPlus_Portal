import { describe, it, expect } from 'vitest';
import { computeNextRun } from '../../../src/utils/automationScheduleHelpers.js';

// Epic 5, Task 12. `Next Run` is a read-only field the client sees, and the
// scheduler tick (Task 13) selects work with `nextRun <= now()`. A wrong answer
// here either bills a participant twice or never bills them, so this is pure and
// clock-free: `from` is always passed in, never read from the system clock.
//
// Times are asserted in the business's timezone, not UTC, because that is what
// "Run At 09:00" means to the person who typed it.

const TZ = 'Australia/Sydney';

/** What wall-clock time is `date` in `tz`? Format: "YYYY-MM-DD HH:mm". */
function wallClock(date, tz = TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const base = {
  runAt: '09:00',
  startDate: '2026-01-01',
};

describe('computeNextRun', () => {
  describe('interval units', () => {
    // Note on the instants below: 00:00Z is 11:00 in Sydney, not 00:00. Getting
    // that backwards is what made the first draft of these tests wrong.

    it('day: takes today\'s slot when it is still ahead', () => {
      const settings = { ...base, every: { n: 1, unit: 'day' } };
      // 21:00Z on the 9th = 08:00 Sydney on the 10th, an hour before the slot.
      const next = computeNextRun(settings, new Date('2026-03-09T21:00:00Z'), TZ);
      expect(wallClock(next)).toBe('2026-03-10 09:00');
    });

    it('day: skips to tomorrow when today\'s slot has already passed', () => {
      const settings = { ...base, every: { n: 1, unit: 'day' } };
      // 23:00Z on the 9th = 10:00 Sydney on the 10th, an hour after the slot.
      const next = computeNextRun(settings, new Date('2026-03-09T23:00:00Z'), TZ);
      expect(wallClock(next)).toBe('2026-03-11 09:00');
    });

    it('day: honours an interval greater than one', () => {
      const settings = { ...base, every: { n: 3, unit: 'day' } };
      // Anchored on startDate 2026-01-01, so the series is Jan 1, 4, 7, ...
      const next = computeNextRun(settings, new Date('2026-01-05T00:00:00Z'), TZ);
      expect(wallClock(next)).toBe('2026-01-07 09:00');
    });

    it('week: lands on the configured weekday, in the business timezone', () => {
      const settings = { ...base, every: { n: 1, unit: 'week' }, runOn: 'wednesday' };
      const next = computeNextRun(settings, new Date('2026-03-09T00:00:00Z'), TZ);
      expect(wallClock(next)).toBe('2026-03-11 09:00');

      // Assert the weekday in Sydney, not UTC. 09:00 Wednesday in Sydney is
      // Tuesday in UTC, so a getUTCDay() assertion here would be testing the
      // wrong calendar.
      const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long' }).format(next);
      expect(weekday).toBe('Wednesday');
    });

    it('month: lands on the configured day of month', () => {
      const settings = { ...base, every: { n: 1, unit: 'month' }, runOn: 15 };
      const next = computeNextRun(settings, new Date('2026-03-20T00:00:00Z'), TZ);
      expect(wallClock(next)).toBe('2026-04-15 09:00');
    });

    it('quarter: steps three months from the start date, not from `from`', () => {
      const settings = { ...base, every: { n: 1, unit: 'quarter' }, runOn: 1 };
      // startDate is 2026-01-01, so the series is Jan 1, Apr 1, Jul 1, Oct 1.
      // Asking in April must give July, not "three months from today".
      const next = computeNextRun(settings, new Date('2026-04-02T00:00:00Z'), TZ);
      expect(wallClock(next)).toBe('2026-07-01 09:00');
    });

    it('year: steps twelve months from the start date', () => {
      const settings = { ...base, every: { n: 1, unit: 'year' }, runOn: 1 };
      const next = computeNextRun(settings, new Date('2026-03-02T00:00:00Z'), TZ);
      expect(wallClock(next)).toBe('2027-01-01 09:00');
    });
  });

  describe('the cases that cause double-billing', () => {
    it('clamps the 31st to the last day of a 30-day month', () => {
      // The bug this prevents: rolling 31 April into 1 May, which silently
      // shifts every subsequent run and can fire twice in one month.
      const settings = { ...base, every: { n: 1, unit: 'month' }, runOn: 31 };
      const next = computeNextRun(settings, new Date('2026-04-01T00:00:00Z'), TZ);
      expect(wallClock(next)).toBe('2026-04-30 09:00');
    });

    it('clamps to 28 February in a non-leap year', () => {
      const settings = { ...base, every: { n: 1, unit: 'month' }, runOn: 31 };
      const next = computeNextRun(settings, new Date('2026-02-01T00:00:00Z'), TZ);
      expect(wallClock(next)).toBe('2026-02-28 09:00');
    });

    it('never returns a time at or before `from`', () => {
      const settings = { ...base, every: { n: 1, unit: 'day' } };
      const from = new Date('2026-03-10T00:00:00Z'); // exactly 11:00 Sydney
      const next = computeNextRun(settings, from, TZ);
      expect(next.getTime()).toBeGreaterThan(from.getTime());
    });

    it('does not run before the start date', () => {
      const settings = { ...base, every: { n: 1, unit: 'day' }, startDate: '2026-06-01' };
      const next = computeNextRun(settings, new Date('2026-03-10T00:00:00Z'), TZ);
      expect(wallClock(next)).toBe('2026-06-01 09:00');
    });
  });

  describe('daylight saving in Australia/Sydney', () => {
    it('keeps the wall-clock time across the April transition', () => {
      // 05 Apr 2026: clocks go back 03:00 -> 02:00, AEDT (+11) to AEST (+10).
      // `from` is 4 Apr 11:00 Sydney, still on +11; the next run is 5 Apr, on
      // +10. It must still read 09:00 — naive UTC arithmetic drifts it to 08:00.
      const settings = { ...base, every: { n: 1, unit: 'day' } };
      const from = new Date('2026-04-04T00:00:00Z');
      const next = computeNextRun(settings, from, TZ);

      expect(wallClock(next)).toBe('2026-04-05 09:00');

      // Prove the transition was actually crossed, so this test cannot quietly
      // stop exercising DST if the dates are ever edited.
      const offsetOf = (d) => new Intl.DateTimeFormat('en-US', {
        timeZone: TZ, timeZoneName: 'longOffset',
      }).formatToParts(d).find((p) => p.type === 'timeZoneName').value;
      expect(offsetOf(from)).toBe('GMT+11:00');
      expect(offsetOf(next)).toBe('GMT+10:00');
    });

    it('still produces a valid instant when the wall-clock time does not exist', () => {
      // 04 Oct 2026: clocks jump 02:00 -> 03:00, so 02:30 never occurs.
      // Any answer is acceptable except an Invalid Date or a silent skip.
      const settings = { runAt: '02:30', startDate: '2026-01-01', every: { n: 1, unit: 'day' } };
      const next = computeNextRun(settings, new Date('2026-10-03T20:00:00Z'), TZ);
      expect(next).toBeInstanceOf(Date);
      expect(Number.isNaN(next.getTime())).toBe(false);
    });
  });
});
