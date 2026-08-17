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

    // quarter and year take runOn as {month, day} — that is the shape
    // parseAutomationSettingsBody accepts (automationSettingsHelpers.js
    // validateRunOn rejects a bare integer for these two units) and the shape
    // the picker sends (Frontend/lib/automation-run-on-options.ts). Passing an
    // integer here pinned a path the API cannot produce.
    it('quarter: steps three months from the start date, not from `from`', () => {
      const settings = { ...base, every: { n: 1, unit: 'quarter' }, runOn: { month: 1, day: 1 } };
      // startDate is 2026-01-01, so the series is Jan 1, Apr 1, Jul 1, Oct 1.
      // Asking in April must give July, not "three months from today".
      const next = computeNextRun(settings, new Date('2026-04-02T00:00:00Z'), TZ);
      expect(wallClock(next)).toBe('2026-07-01 09:00');
      expect(next.toISOString()).toBe('2026-06-30T23:00:00.000Z'); // AEST, UTC+10
    });

    it('year: steps twelve months from the start date', () => {
      const settings = { ...base, every: { n: 1, unit: 'year' }, runOn: { month: 1, day: 1 } };
      const next = computeNextRun(settings, new Date('2026-03-02T00:00:00Z'), TZ);
      expect(wallClock(next)).toBe('2027-01-01 09:00');
      expect(next.toISOString()).toBe('2026-12-31T22:00:00.000Z'); // AEDT, UTC+11
    });
  });

  // runOn.month is the half of the picker's answer that used to be dropped on
  // the floor: the arithmetic read runOn as an integer, so `Number({month,
  // day})` was NaN and every quarter/year schedule threw RangeError: Invalid
  // time value out of Intl. Fixing the throw alone is not enough — a schedule
  // saved as "yearly on 15 March" has to actually land in March.
  describe('quarter and year: runOn {month, day}', () => {
    it('quarter: honours a month already past in this cycle by stepping to the next one', () => {
      // March is the third month of the quarter that starts at the January
      // startDate, so the series is Mar 20, Jun 20, Sep 20, Dec 20. `from` is
      // 25 March, five days after this cycle's slot.
      const settings = { ...base, every: { n: 1, unit: 'quarter' }, runOn: { month: 3, day: 20 } };
      const next = computeNextRun(settings, new Date('2026-03-25T00:00:00Z'), TZ);

      expect(wallClock(next)).toBe('2026-06-20 09:00');
      expect(next.toISOString()).toBe('2026-06-19T23:00:00.000Z'); // AEST, UTC+10
    });

    it('year: lands on a month later in the same year than `from`', () => {
      const settings = { ...base, every: { n: 1, unit: 'year' }, runOn: { month: 9, day: 5 } };
      const next = computeNextRun(settings, new Date('2026-03-02T00:00:00Z'), TZ);

      // Ignoring runOn.month would answer 1 Jan 2027 — a schedule the client
      // never asked for, ten months late.
      expect(wallClock(next)).toBe('2026-09-05 09:00');
      expect(next.toISOString()).toBe('2026-09-04T23:00:00.000Z'); // AEST, UTC+10
    });

    it('clamps the day to the length of the selected month', () => {
      // validateRunOn range-checks neither half of {month, day} for these two
      // units, so {month: 2, day: 31} reaches the arithmetic. February must
      // clamp, exactly as the monthly path does — rolling into 3 March would
      // shift every subsequent year of the series.
      const settings = { ...base, every: { n: 1, unit: 'year' }, runOn: { month: 2, day: 31 } };
      const next = computeNextRun(settings, new Date('2026-01-15T00:00:00Z'), TZ);

      expect(wallClock(next)).toBe('2026-02-28 09:00');
      expect(next.toISOString()).toBe('2026-02-27T22:00:00.000Z'); // AEDT, UTC+11
    });
  });

  // `every.n` is a free <input type="number" min={1}> and validateBlock accepts
  // any positive integer, so n >= 2 is reachable. The alignment modulus has to
  // match the step: aligning mod 3 while stepping 6 months means the chosen
  // month only appears by parity luck.
  describe('quarter and year: an interval greater than one', () => {
    /** The first four runs of a series, as wall-clock strings. */
    function series(settings, from, count = 4) {
      const runs = [];
      let cursor = from;
      for (let i = 0; i < count; i += 1) {
        cursor = computeNextRun(settings, cursor, TZ);
        runs.push(wallClock(cursor));
      }
      return runs;
    }

    it('quarter n=2: lands in the chosen month, not the one six months off it', () => {
      // Aligning mod 3 and stepping 6 produced Sep 20, Mar 20, Sep 20, Mar 20 —
      // June never occurred, and {month: 3} gave the byte-identical series. A
      // client who picked June was billed every September and March forever.
      const settings = {
        ...base,
        startDate: '2026-08-01',
        every: { n: 2, unit: 'quarter' },
        runOn: { month: 6, day: 20 },
      };
      const from = new Date('2026-08-01T00:00:00Z');

      expect(series(settings, from)).toEqual([
        '2026-12-20 09:00',
        '2027-06-20 09:00',
        '2027-12-20 09:00',
        '2028-06-20 09:00',
      ]);

      const first = computeNextRun(settings, from, TZ);
      expect(first.toISOString()).toBe('2026-12-19T22:00:00.000Z'); // AEDT, UTC+11

      // June and December, six months apart — and distinguishable from the
      // March/September series a {month: 3} schedule produces.
      const march = { ...settings, runOn: { month: 3, day: 20 } };
      expect(computeNextRun(march, from, TZ).toISOString()).not.toBe(first.toISOString());
    });

    it('year n=2: honours the chosen month even when that delays the first run a cycle', () => {
      // Deliberate, and pinned so nobody "fixes" it back. Starting Aug 2026,
      // the March slot phase-aligned to a two-year step is March 2028, not
      // March 2027 — one cycle later than the nearest March. Accepted: the
      // client picked March and still gets March. Billing them in a month they
      // did not choose, forever, is the worse failure.
      const settings = {
        ...base,
        startDate: '2026-08-01',
        every: { n: 2, unit: 'year' },
        runOn: { month: 3, day: 20 },
      };
      const first = computeNextRun(settings, new Date('2026-08-01T00:00:00Z'), TZ);

      expect(wallClock(first)).toBe('2028-03-20 09:00');
      expect(first.toISOString()).toBe('2028-03-19T22:00:00.000Z'); // AEDT, UTC+11
    });

    it('quarter n=1 is unchanged: the modulus still collapses to three months', () => {
      // n * MONTHS_PER_UNIT equals MONTHS_PER_UNIT when n is 1, so the mod-3
      // behaviour every other quarter case pins must survive untouched.
      const settings = { ...base, every: { n: 1, unit: 'quarter' }, runOn: { month: 3, day: 20 } };
      const next = computeNextRun(settings, new Date('2026-03-25T00:00:00Z'), TZ);

      expect(next.toISOString()).toBe('2026-06-19T23:00:00.000Z'); // AEST, UTC+10
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

    it('clamps to 29 February in a leap year', () => {
      // 2028 is a leap year: "the 31st" must use the extra day, not stay on
      // the 28th — and certainly not roll into 2 March.
      const settings = { ...base, every: { n: 1, unit: 'month' }, runOn: 31 };
      const next = computeNextRun(settings, new Date('2028-02-01T00:00:00Z'), TZ);
      expect(wallClock(next)).toBe('2028-02-29 09:00');
    });

    it('clamps a year-unit {month, day} to 29 February in a leap year', () => {
      const settings = { ...base, every: { n: 1, unit: 'year' }, runOn: { month: 2, day: 30 } };
      const next = computeNextRun(settings, new Date('2028-01-15T00:00:00Z'), TZ);
      expect(wallClock(next)).toBe('2028-02-29 09:00');
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

  // The worst failure this module can produce, because nothing downstream
  // catches it: a nextRunAt in the past that is also a fixed point. The tick
  // claims it, advanceSchedule answers the same instant, the claim CAS
  // succeeds, and the schedule fires on every tick forever. missedSlots.js
  // cannot see it either — its `next <= cursor` guard returns 0, so
  // `missedRuns` stays at zero and nothing alerts.
  //
  // The cause was a loop bounded by a month *offset* (`offset < 400`) rather
  // than by iterations: a startDate more than ~33 years back exhausted the cap
  // while the candidate was still behind `from`, and the last candidate was
  // returned anyway.
  describe('a startDate decades in the past', () => {
    const settings = {
      every: { n: 1, unit: 'month' },
      runOn: 15,
      runAt: '09:00',
      startDate: '1990-01-01',
    };
    const from = new Date('2026-08-17T00:00:00Z');

    it('still returns a run strictly after `from`, as the contract promises', () => {
      const next = computeNextRun(settings, from, TZ);
      expect(next.getTime()).toBeGreaterThan(from.getTime());
      expect(wallClock(next)).toBe('2026-09-15 09:00');
    });

    it('is not a fixed point: advancing from its own answer moves forward', () => {
      const next = computeNextRun(settings, from, TZ);
      const after = computeNextRun(settings, next, TZ);
      expect(after.getTime()).toBeGreaterThan(next.getTime());
    });

    it.each([
      ['quarter', { month: 3, day: 20 }],
      ['year', { month: 3, day: 20 }],
    ])('holds for the %s unit too', (unit, runOn) => {
      const next = computeNextRun(
        { every: { n: 1, unit }, runOn, runAt: '09:00', startDate: '1900-01-01' },
        from,
        TZ,
      );
      expect(next.getTime()).toBeGreaterThan(from.getTime());
    });
  });

  describe('runOn that is present but empty', () => {
    it('falls back to the startDate day rather than the 1st', () => {
      // `Number('' ?? fallback)` is 0, not the fallback — `??` only catches
      // null/undefined — so an empty runOn clamped to 1 and moved a monthly
      // schedule off its start day. Unreachable through the route today
      // (validateRunOn rejects it), which is exactly why it would not be
      // noticed if it became reachable.
      const settings = { ...base, every: { n: 1, unit: 'month' }, runOn: '', startDate: '2026-01-20' };
      const next = computeNextRun(settings, new Date('2026-03-01T00:00:00Z'), TZ);
      expect(wallClock(next)).toBe('2026-03-20 09:00');
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
