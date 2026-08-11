import { describe, it, expect } from 'vitest';
import { buildCron, describeCron } from '../../../src/services/scheduler/cadence.js';
import { isValidSchedule, minIntervalMinutes } from '../../../src/services/scheduler/nextRun.js';

const TZ = 'Australia/Sydney';
const NOW = new Date('2026-08-11T00:00:00Z');

describe('buildCron', () => {
  it('builds a daily cron', () => {
    expect(buildCron({ frequency: 'daily', hour: 9, minute: 30 })).toBe('30 9 * * *');
  });

  it('builds a weekly cron', () => {
    expect(buildCron({ frequency: 'weekly', dayOfWeek: 3, hour: 9, minute: 30 })).toBe(
      '30 9 * * 3',
    );
  });

  it('builds a monthly cron', () => {
    expect(buildCron({ frequency: 'monthly', dayOfMonth: 15, hour: 9, minute: 30 })).toBe(
      '30 9 15 * *',
    );
  });

  describe('validation', () => {
    it('rejects an unknown frequency', () => {
      expect(() => buildCron({ frequency: 'hourly', hour: 9, minute: 0 })).toThrow(
        /frequency must be one of 'daily', 'weekly', 'monthly'/,
      );
    });

    it('rejects a missing picker entirely', () => {
      expect(() => buildCron(undefined)).toThrow(/frequency must be one of/);
    });

    it('rejects an out-of-range hour', () => {
      expect(() => buildCron({ frequency: 'daily', hour: 24, minute: 0 })).toThrow(
        /hour must be an integer between 0 and 23/,
      );
    });

    it('rejects a negative hour', () => {
      expect(() => buildCron({ frequency: 'daily', hour: -1, minute: 0 })).toThrow(
        /hour must be an integer between 0 and 23/,
      );
    });

    it('rejects an out-of-range minute', () => {
      expect(() => buildCron({ frequency: 'daily', hour: 9, minute: 60 })).toThrow(
        /minute must be an integer between 0 and 59/,
      );
    });

    it('rejects a non-integer hour or minute', () => {
      expect(() => buildCron({ frequency: 'daily', hour: 9.5, minute: 0 })).toThrow(
        /hour must be an integer/,
      );
      expect(() => buildCron({ frequency: 'daily', hour: 9, minute: '30' })).toThrow(
        /minute must be an integer/,
      );
    });

    it('rejects a missing dayOfWeek for a weekly schedule', () => {
      expect(() => buildCron({ frequency: 'weekly', hour: 9, minute: 0 })).toThrow(
        /dayOfWeek must be an integer between 0 and 6/,
      );
    });

    it('rejects an out-of-range dayOfWeek', () => {
      expect(() => buildCron({ frequency: 'weekly', dayOfWeek: 7, hour: 9, minute: 0 })).toThrow(
        /dayOfWeek must be an integer between 0 and 6/,
      );
    });

    it('rejects a missing dayOfMonth for a monthly schedule', () => {
      expect(() => buildCron({ frequency: 'monthly', hour: 9, minute: 0 })).toThrow(
        /dayOfMonth must be an integer between 1 and 28/,
      );
    });

    it('rejects a dayOfWeek on a monthly schedule rather than silently ignoring it', () => {
      expect(() =>
        buildCron({ frequency: 'monthly', dayOfMonth: 15, dayOfWeek: 3, hour: 9, minute: 0 }),
      ).toThrow(/dayOfWeek is not valid for a monthly frequency/);
    });

    it('rejects a dayOfMonth on a weekly schedule rather than silently ignoring it', () => {
      expect(() =>
        buildCron({ frequency: 'weekly', dayOfWeek: 3, dayOfMonth: 15, hour: 9, minute: 0 }),
      ).toThrow(/dayOfMonth is not valid for a weekly frequency/);
    });

    it('rejects a dayOfWeek on a daily schedule', () => {
      expect(() => buildCron({ frequency: 'daily', dayOfWeek: 3, hour: 9, minute: 0 })).toThrow(
        /dayOfWeek is not valid for a daily frequency/,
      );
    });

    it('rejects a dayOfMonth on a daily schedule', () => {
      expect(() => buildCron({ frequency: 'daily', dayOfMonth: 15, hour: 9, minute: 0 })).toThrow(
        /dayOfMonth is not valid for a daily frequency/,
      );
    });

    it.each([29, 30, 31])(
      'rejects dayOfMonth %i, pointing at raw cron as the escape hatch',
      (dayOfMonth) => {
        expect(() => buildCron({ frequency: 'monthly', dayOfMonth, hour: 9, minute: 0 })).toThrow(
          /1 and 28.*raw cron/is,
        );
      },
    );

    it('accepts dayOfMonth 1 and 28, the boundaries of the allowed range', () => {
      expect(buildCron({ frequency: 'monthly', dayOfMonth: 1, hour: 0, minute: 0 })).toBe(
        '0 0 1 * *',
      );
      expect(buildCron({ frequency: 'monthly', dayOfMonth: 28, hour: 0, minute: 0 })).toBe(
        '0 0 28 * *',
      );
    });
  });
});

describe('describeCron', () => {
  it('describes a daily cron', () => {
    expect(describeCron('30 9 * * *')).toEqual({ frequency: 'daily', hour: 9, minute: 30 });
  });

  it('describes a weekly cron', () => {
    expect(describeCron('30 9 * * 3')).toEqual({
      frequency: 'weekly',
      hour: 9,
      minute: 30,
      dayOfWeek: 3,
    });
  });

  it('describes a monthly cron', () => {
    expect(describeCron('30 9 15 * *')).toEqual({
      frequency: 'monthly',
      hour: 9,
      minute: 30,
      dayOfMonth: 15,
    });
  });

  it('returns null for a step expression', () => {
    expect(describeCron('*/30 * * * *')).toBeNull();
  });

  it('returns null for a multi-value list', () => {
    expect(describeCron('0 2 * * 1,3,5')).toBeNull();
  });

  it('returns null for a range', () => {
    expect(describeCron('0 9-17 * * *')).toBeNull();
  });

  it('returns null for a month restriction', () => {
    expect(describeCron('0 9 1 6 *')).toBeNull();
  });

  it('returns null for a dayOfMonth outside the picker range (29-31), even though cron itself allows it', () => {
    expect(describeCron('0 9 29 * *')).toBeNull();
    expect(describeCron('0 9 30 * *')).toBeNull();
    expect(describeCron('0 9 31 * *')).toBeNull();
  });

  it('returns null for both dayOfMonth and dayOfWeek being restricted at once', () => {
    expect(describeCron('0 9 15 * 3')).toBeNull();
  });

  it('returns null for a malformed expression', () => {
    expect(describeCron('not-a-cron')).toBeNull();
    expect(describeCron('* * * *')).toBeNull();
    expect(describeCron('')).toBeNull();
  });

  it('returns null for a non-string input', () => {
    expect(describeCron(undefined)).toBeNull();
    expect(describeCron(null)).toBeNull();
    expect(describeCron(42)).toBeNull();
  });
});

describe('round trip: describeCron(buildCron(picker)) equals picker', () => {
  const cases = [
    { frequency: 'daily', hour: 0, minute: 0 },
    { frequency: 'daily', hour: 23, minute: 59 },
    { frequency: 'weekly', dayOfWeek: 0, hour: 6, minute: 15 },
    { frequency: 'weekly', dayOfWeek: 6, hour: 18, minute: 45 },
    { frequency: 'monthly', dayOfMonth: 1, hour: 2, minute: 0 },
    { frequency: 'monthly', dayOfMonth: 28, hour: 23, minute: 59 },
  ];

  it.each(cases)('round-trips $frequency', (picker) => {
    expect(describeCron(buildCron(picker))).toEqual(picker);
  });
});

describe('every buildCron output is a schedulable, sufficiently-spaced cron', () => {
  const pickers = [
    { frequency: 'daily', hour: 9, minute: 0 },
    { frequency: 'weekly', dayOfWeek: 1, hour: 9, minute: 0 },
    { frequency: 'monthly', dayOfMonth: 1, hour: 9, minute: 0 },
    { frequency: 'monthly', dayOfMonth: 28, hour: 9, minute: 0 },
  ];

  it.each(pickers)('is accepted by isValidSchedule: $frequency', (picker) => {
    expect(isValidSchedule(buildCron(picker), TZ)).toBe(true);
  });

  // Daily, weekly and monthly cadences are all >= 24 hours apart, so the
  // 60-minute AT_MOST_ONCE floor (intervalFloor.js) can never reject picker
  // output. Asserted directly against minIntervalMinutes, rather than
  // reasoned about, so the guarantee is re-checked automatically if someone
  // later adds a sub-daily frequency to the picker without revisiting the
  // floor.
  it.each(pickers)(
    'always satisfies the 60-minute AT_MOST_ONCE floor: $frequency',
    (picker) => {
      const minutes = minIntervalMinutes(buildCron(picker), TZ, NOW);
      expect(minutes).toBeGreaterThanOrEqual(60);
    },
  );
});
