import { describe, it, expect } from 'vitest';

import { pickerScheduleError } from '../../../src/services/scheduler/pickerValidation.js';

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

  // runOn is deliberately not checked here. It decides which day within the
  // cadence, not whether the schedule can be advanced at all, and its rules
  // are unit-dependent and already enforced at the route layer by
  // utils/automationSettingsHelpers.js. Duplicating them would give two
  // copies to keep in step.
  it('does not reject on runOn, which the route layer owns', () => {
    expect(pickerScheduleError({ ...VALID, runOn: 'whenever' })).toBeNull();
  });
});
