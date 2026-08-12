import { describe, it, expect } from 'vitest';
import { automationPeriodKey } from '../../../src/utils/automationPeriodKey.js';

const TZ = 'Australia/Sydney';

describe('automationPeriodKey', () => {
  it('formats the slot in the schedule timezone', () => {
    const slot = new Date('2026-08-11T23:00:00Z'); // 09:00 on the 12th in Sydney
    expect(automationPeriodKey({ slot, timezone: TZ })).toBe('20260812-0900');
  });

  it('is stable — the same slot always yields the same key', () => {
    const slot = new Date('2026-08-11T23:00:00Z');
    const first = automationPeriodKey({ slot, timezone: TZ });
    const second = automationPeriodKey({ slot: new Date(slot.getTime()), timezone: TZ });
    expect(second).toBe(first);
  });

  it('distinguishes two slots on the same day', () => {
    const morning = automationPeriodKey({ slot: new Date('2026-08-11T23:00:00Z'), timezone: TZ });
    const evening = automationPeriodKey({ slot: new Date('2026-08-12T09:00:00Z'), timezone: TZ });
    expect(morning).not.toBe(evening);
  });

  it('does not collide across timezones for the same instant', () => {
    const slot = new Date('2026-08-11T23:00:00Z');
    const sydney = automationPeriodKey({ slot, timezone: TZ });
    const perth = automationPeriodKey({ slot, timezone: 'Australia/Perth' });
    expect(sydney).not.toBe(perth);
  });

  it('yields one key per slot across a DST boundary', () => {
    // Sydney leaves DST on 2026-04-05; 02:00 occurs twice in local terms.
    const before = automationPeriodKey({ slot: new Date('2026-04-04T15:00:00Z'), timezone: TZ });
    const after = automationPeriodKey({ slot: new Date('2026-04-05T16:00:00Z'), timezone: TZ });
    expect(before).not.toBe(after);
  });
});
