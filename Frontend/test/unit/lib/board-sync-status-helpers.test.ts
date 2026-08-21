import { describe, it, expect } from 'vitest';
import {
  formatScheduleInstant,
  labelCurrentSync,
  labelInstant,
} from '@/lib/board-sync-status-helpers';

describe('board sync status copy', () => {
  it('says none yet when previous is missing', () => {
    expect(labelInstant(null, null, 'None yet')).toBe('None yet');
  });

  it('says Idle when current is missing', () => {
    expect(labelCurrentSync(null)).toBe('Idle');
  });

  it('says Not scheduled when upcoming is missing', () => {
    expect(labelInstant(null, null, 'Not scheduled')).toBe('Not scheduled');
  });

  it('formats an instant in en-AU', () => {
    expect(formatScheduleInstant('2026-08-18T16:00:00.000Z')).toMatch(/2026/);
  });
});
