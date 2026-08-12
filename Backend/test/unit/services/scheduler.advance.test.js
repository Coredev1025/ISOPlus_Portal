import { describe, it, expect } from 'vitest';
import { advanceSchedule } from '../../../src/services/scheduler/advance.js';

const TZ = 'Australia/Sydney';

describe('advanceSchedule', () => {
  it('uses cron arithmetic for a cron job', () => {
    const next = advanceSchedule(
      { cron: '0 9 * * *', timezone: TZ, schedule: null },
      new Date('2026-08-12T00:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-08-12T23:00:00.000Z'); // 09:00 Sydney next day
  });

  it('uses picker arithmetic for a schedule job', () => {
    const next = advanceSchedule(
      {
        cron: null,
        timezone: TZ,
        schedule: {
          every: { n: 2, unit: 'week' },
          runOn: 'monday',
          runAt: '09:00',
          startDate: new Date('2026-08-03T00:00:00+10:00'),
        },
      },
      new Date('2026-08-12T00:00:00Z'),
    );
    expect(next.getTime()).toBeGreaterThan(new Date('2026-08-12T00:00:00Z').getTime());
  });

  it('throws when a job has neither', () => {
    expect(() => advanceSchedule({ cron: null, schedule: null, timezone: TZ }, new Date()))
      .toThrow(/exactly one/i);
  });
});
