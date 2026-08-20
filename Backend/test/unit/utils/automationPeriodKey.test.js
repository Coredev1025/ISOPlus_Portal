import { describe, it, expect } from 'vitest';
import { automationPeriodKey } from '../../../src/utils/automationPeriodKey.js';

const TZ = 'Australia/Sydney';

describe('automationPeriodKey', () => {
  it('formats the slot in the schedule timezone', () => {
    const slot = new Date('2026-08-11T23:00:00Z'); // 09:00 on the 12th in Sydney
    expect(automationPeriodKey({ slot, timezone: TZ })).toBe('20260812-0900');
  });

  it('is stable — the same slot always yields the same key', () => {
    // Deliberately use a historical slot far from now. This ensures the
    // function derives the key from the slot argument, never from Date.now().
    // An implementation reading the clock would produce a wildly different key
    // on each call and fail. Both calls happen within one minute, so calling
    // twice with equivalent slots would pass even if the implementation ignored
    // the slot parameter — and that is exactly the bug this test exists to catch.
    const slot = new Date('2019-07-20T13:45:00Z'); // 23:45 on 20 July 2019 in Sydney
    expect(automationPeriodKey({ slot, timezone: TZ })).toBe('20190720-2345');
    const second = automationPeriodKey({ slot: new Date(slot.getTime()), timezone: TZ });
    expect(second).toBe('20190720-2345');
  });

  it('distinguishes two slots on the same day', () => {
    const morning = automationPeriodKey({ slot: new Date('2026-08-11T23:00:00Z'), timezone: TZ });
    const evening = automationPeriodKey({ slot: new Date('2026-08-12T09:00:00Z'), timezone: TZ });
    expect(morning).toBe('20260812-0900');
    expect(evening).toBe('20260812-1900');
    expect(morning).not.toBe(evening);
  });

  it('does not collide across timezones for the same instant', () => {
    const slot = new Date('2026-08-11T23:00:00Z');
    const sydney = automationPeriodKey({ slot, timezone: TZ });
    const perth = automationPeriodKey({ slot, timezone: 'Australia/Perth' });
    expect(sydney).toBe('20260812-0900');
    expect(perth).toBe('20260812-0700');
    expect(sydney).not.toBe(perth);
  });

  it('yields one key per slot across a DST boundary', () => {
    // Sydney leaves DST on 2026-04-05; 02:00 occurs twice in local terms.
    const before = automationPeriodKey({ slot: new Date('2026-04-04T15:00:00Z'), timezone: TZ });
    const after = automationPeriodKey({ slot: new Date('2026-04-05T16:00:00Z'), timezone: TZ });
    expect(before).toBe('20260405-0200');
    expect(after).toBe('20260406-0200');
    expect(before).not.toBe(after);
  });

  it('renders midnight as 0000, not 2400', () => {
    // Slot that falls at midnight in the local timezone. On this engine
    // (Node.js with h23 hourCycle), this tests the output contract via the h23
    // code path; on engines with h24 it would exercise the normalisation guard.
    // Either way, the output must end in -0000, never -2400.
    const slot = new Date('2019-12-31T13:00:00Z'); // 00:00 (midnight) on 1 Jan 2020 in Sydney (UTC+11)
    expect(automationPeriodKey({ slot, timezone: TZ })).toBe('20200101-0000');
  });
});
