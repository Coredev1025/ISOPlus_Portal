import { describe, it, expect } from 'vitest';
import SchedulerHealth from '../../../src/models/SchedulerHealth.js';
import { SCHEDULER_HEALTH_KEY } from '../../../src/constants/scheduler.js';

describe('SchedulerHealth model', () => {
  it('applies defaults for a minimally specified document', async () => {
    const doc = await SchedulerHealth.create({});

    expect(doc.key).toBe(SCHEDULER_HEALTH_KEY);
    expect(doc.lastTickAt).toBeNull();
  });

  it('refuses a second document with the same key', async () => {
    await SchedulerHealth.create({ key: SCHEDULER_HEALTH_KEY });
    // init(), not syncIndexes(): syncIndexes diffs against listIndexes, which
    // already shows autoIndex's in-flight build of this same index — so under
    // load it returns before the build commits and the duplicate insert
    // succeeds, failing this test only in a full-suite run. init() awaits the
    // schema's own index builds. scheduledJob.test.js carries the same note
    // for the same reason.
    await SchedulerHealth.init();

    await expect(SchedulerHealth.create({ key: SCHEDULER_HEALTH_KEY })).rejects.toThrow();
  });

  it('persists the tick timestamp', async () => {
    const lastTickAt = new Date('2026-08-11T04:05:00.000Z');
    const saved = await SchedulerHealth.create({ key: SCHEDULER_HEALTH_KEY, lastTickAt });

    const found = await SchedulerHealth.findById(saved._id).lean();
    expect(found.lastTickAt.toISOString()).toBe('2026-08-11T04:05:00.000Z');
  });
});
