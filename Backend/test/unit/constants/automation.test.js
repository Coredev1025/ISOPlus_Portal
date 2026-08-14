// Backend/test/unit/constants/automation.test.js
import { describe, it, expect } from 'vitest';

import { RUN_AT_PATTERN, WEEKDAYS } from '../../../src/constants/automation.js';

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
