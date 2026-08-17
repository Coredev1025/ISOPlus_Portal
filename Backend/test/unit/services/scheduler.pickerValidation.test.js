import { describe, it, expect } from 'vitest';

import { pickerScheduleError } from '../../../src/services/scheduler/pickerValidation.js';
import { computeNextRun } from '../../../src/utils/automationScheduleHelpers.js';

const VALID = { every: { n: 1, unit: 'month' }, runOn: 15, runAt: '09:00' };

describe('pickerScheduleError', () => {
  it('accepts a well-formed schedule', () => {
    expect(pickerScheduleError(VALID)).toBeNull();
  });

  it('accepts every unit the picker offers', () => {
    for (const unit of ['day', 'week', 'month', 'quarter', 'year']) {
      expect(pickerScheduleError({ ...VALID, every: { n: 2, unit } })).toBeNull();
    }
  });

  it('rejects a unit outside the enum', () => {
    // Persisted happily before this existed, and advanceSchedule then treated
    // it as a month — a schedule billing on a cadence nobody chose.
    expect(pickerScheduleError({ ...VALID, every: { n: 1, unit: 'fortnight' } })).toMatch(
      /every\.unit/,
    );
  });

  it.each([0, -3, 1.5, '2', null, undefined, NaN])('rejects every.n of %s', (n) => {
    expect(pickerScheduleError({ ...VALID, every: { n, unit: 'month' } })).toMatch(/every\.n/);
  });

  // The API validator (utils/automationSettingsHelpers.js validateBlock) has
  // applied this ceiling since the field existed; this module did not, so the
  // two write-path validators for the same field disagreed — which is the
  // thing this module exists to prevent, not to add another instance of.
  it.each([366, 1000, 100000])('rejects an every.n of %s, above the ceiling', (n) => {
    expect(pickerScheduleError({ ...VALID, every: { n, unit: 'day' } })).toMatch(/every\.n/);
  });

  it('accepts an every.n exactly at the ceiling', () => {
    expect(pickerScheduleError({ ...VALID, every: { n: 365, unit: 'day' } })).toBeNull();
  });

  it('rejects a missing every block', () => {
    expect(pickerScheduleError({ runOn: 15, runAt: '09:00' })).toMatch(/every/);
  });

  it.each(['99:99', '9:00', '24:00', '12:60', 'noon', '', '0900'])(
    'rejects a runAt of "%s"',
    (runAt) => {
      expect(pickerScheduleError({ ...VALID, runAt })).toMatch(/runAt/);
    },
  );

  it.each(['00:00', '09:05', '23:59'])('accepts a runAt of "%s"', (runAt) => {
    expect(pickerScheduleError({ ...VALID, runAt })).toBeNull();
  });

  it('rejects a startDate that is not a real date', () => {
    expect(pickerScheduleError({ ...VALID, startDate: 'not-a-date' })).toMatch(/startDate/);
  });

  it.each([null, undefined])('accepts an absent startDate (%s)', (startDate) => {
    expect(pickerScheduleError({ ...VALID, startDate })).toBeNull();
  });

  it('accepts a Date and a parseable string startDate', () => {
    expect(pickerScheduleError({ ...VALID, startDate: new Date('2026-08-01') })).toBeNull();
    expect(pickerScheduleError({ ...VALID, startDate: '2026-08-01' })).toBeNull();
  });

  it('rejects a null or non-object schedule', () => {
    expect(pickerScheduleError(null)).toMatch(/schedule/);
    expect(pickerScheduleError('monthly')).toMatch(/schedule/);
  });

  // runOn is deliberately not checked here, and this is the decision rather
  // than an oversight — see the comment on `pickerScheduleError` for the full
  // reasoning and the follow-up that would close it.
  //
  // The consequence is real and worth pinning: an unreadable runOn does not
  // fail the save, it falls back to the startDate's own weekday/day. The
  // schedule below runs on Thursdays because 2026-01-01 was a Thursday, not
  // because anyone chose Thursday.
  it('accepts an unreadable runOn, falling back to the startDate weekday', () => {
    const schedule = {
      every: { n: 1, unit: 'week' },
      runOn: 'whenever',
      runAt: '09:00',
      startDate: '2026-01-01',
    };
    expect(pickerScheduleError(schedule)).toBeNull();

    const next = computeNextRun(schedule, new Date('2026-03-10T00:00:00Z'), 'Australia/Sydney');
    const weekday = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney',
      weekday: 'long',
    }).format(next);
    expect(weekday).toBe('Thursday');
  });
});
