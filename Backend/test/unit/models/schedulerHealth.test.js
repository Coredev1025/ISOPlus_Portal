import { describe, it, expect } from 'vitest';
import SchedulerHealth, { SCHEDULER_HEALTH_KEY } from '../../../src/models/SchedulerHealth.js';

describe('SchedulerHealth model', () => {
  it('applies defaults for a minimally specified document', async () => {
    const doc = await SchedulerHealth.create({});

    expect(doc.key).toBe(SCHEDULER_HEALTH_KEY);
    expect(doc.lastTickAt).toBeNull();
    expect(doc.claimed).toBe(0);
    expect(doc.dispatched).toBe(0);
    expect(doc.failed).toBe(0);
    expect(doc.capped).toBe(false);
  });

  it('refuses a second document with the same key', async () => {
    await SchedulerHealth.create({ key: SCHEDULER_HEALTH_KEY });
    await SchedulerHealth.syncIndexes();

    await expect(SchedulerHealth.create({ key: SCHEDULER_HEALTH_KEY })).rejects.toThrow();
  });

  it('persists the last tick summary alongside the timestamp', async () => {
    const lastTickAt = new Date('2026-08-11T04:05:00.000Z');
    const saved = await SchedulerHealth.create({
      key: SCHEDULER_HEALTH_KEY,
      lastTickAt,
      claimed: 3,
      dispatched: 2,
      failed: 1,
      capped: true,
    });

    const found = await SchedulerHealth.findById(saved._id).lean();
    expect(found.lastTickAt.toISOString()).toBe('2026-08-11T04:05:00.000Z');
    expect(found.claimed).toBe(3);
    expect(found.dispatched).toBe(2);
    expect(found.failed).toBe(1);
    expect(found.capped).toBe(true);
  });
});
