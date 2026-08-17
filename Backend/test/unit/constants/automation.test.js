// Backend/test/unit/constants/automation.test.js
import { describe, it, expect } from 'vitest';

import {
  AUTOMATION_UNITS,
  MAX_EVERY_N,
  MONTHS_PER_UNIT,
  RUN_AT_PATTERN,
  WEEKDAYS,
} from '../../../src/constants/automation.js';
import AutomationSettings from '../../../src/models/AutomationSettings.js';

/** The enum Mongoose actually validates `every.unit` against. */
const blockUnitEnum = () =>
  AutomationSettings.schema.path('invoice').schema.path('every.unit').enumValues;

describe('RUN_AT_PATTERN', () => {
  it.each(['00:00', '09:00', '23:59'])('accepts %s', (time) => {
    expect(RUN_AT_PATTERN.test(time)).toBe(true);
  });

  it.each(['24:00', '9:00', '09:60', '0900', ''])('rejects %s', (time) => {
    expect(RUN_AT_PATTERN.test(time)).toBe(false);
  });
});

describe('WEEKDAYS', () => {
  it('lists the seven days the week unit accepts, lowercased', () => {
    expect(WEEKDAYS).toEqual([
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ]);
  });
});

describe('AUTOMATION_UNITS', () => {
  it('lists the five units the picker offers', () => {
    expect(AUTOMATION_UNITS).toEqual(['day', 'week', 'month', 'quarter', 'year']);
  });

  // The model's own copy is gone; it imports this list, so there is one
  // declaration and nothing left to drift against.
  it('is the enum the AutomationSettings schema validates against', () => {
    expect(blockUnitEnum()).toEqual(AUTOMATION_UNITS);
  });
});

describe('MONTHS_PER_UNIT', () => {
  it('maps only the units measured in whole months', () => {
    expect(MONTHS_PER_UNIT).toEqual({ month: 1, quarter: 3, year: 12 });
  });

  it('has no entry for day or week, which the arithmetic branches on', () => {
    // Both callers test `MONTHS_PER_UNIT[unit]` for truthiness to decide
    // whether a unit is month-based, so adding `day: 0` here would silently
    // keep working while `week: 0` would not.
    expect(MONTHS_PER_UNIT.day).toBeUndefined();
    expect(MONTHS_PER_UNIT.week).toBeUndefined();
  });
});

describe('MAX_EVERY_N', () => {
  it('is the ceiling both write-path validators apply to every.n', () => {
    expect(MAX_EVERY_N).toBe(365);
  });
});
