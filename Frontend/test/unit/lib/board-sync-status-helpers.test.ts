import { describe, it, expect } from 'vitest';
import {
  formatBoardSyncScheduleSummary,
  formatScheduleInstant,
  labelCurrentSync,
  labelInstant,
  labelPreviousSync,
  type BoardSyncSchedule,
} from '@/lib/board-sync-status-helpers';

const TZ = 'Australia/Sydney';

describe('board sync status copy', () => {
  it('says none yet when previous is missing', () => {
    expect(labelInstant(null, null, 'None yet')).toBe('None yet');
    expect(labelPreviousSync(null, TZ)).toBe('None yet');
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

  it('labels previous Success and Failed', () => {
    const at = '2026-08-26T09:11:00.000Z';
    expect(labelPreviousSync({ at, status: 'completed' }, TZ)).toMatch(/\(Success\)$/);
    expect(labelPreviousSync({ at, status: 'failed' }, TZ)).toMatch(/\(Failed\)$/);
  });
});

describe('formatBoardSyncScheduleSummary', () => {
  const previousAt = '2026-08-26T09:11:00.000Z';
  const nextAt = '2026-08-27T09:00:00.000Z';

  it('example 1: Previous Success + Next scheduled run', () => {
    const schedule: BoardSyncSchedule = {
      timezone: TZ,
      previous: { at: previousAt, status: 'completed' },
      current: null,
      upcoming: { at: nextAt },
    };
    const line = formatBoardSyncScheduleSummary(schedule);
    expect(line).toMatch(/^Sync schedule: Previous .+ \(Success\), Next scheduled run .+$/);
  });

  it('example 2: Previous Failed + Current In progress', () => {
    const schedule: BoardSyncSchedule = {
      timezone: TZ,
      previous: { at: previousAt, status: 'failed' },
      current: { state: 'active', syncType: 'scheduled_sync' },
      upcoming: { at: nextAt },
    };
    const line = formatBoardSyncScheduleSummary(schedule);
    expect(line).toMatch(/^Sync schedule: Previous .+ \(Failed\), Current \(In progress\)$/);
  });

  it('example 3: Previous Failed + Next scheduled run when idle', () => {
    const schedule: BoardSyncSchedule = {
      timezone: TZ,
      previous: { at: previousAt, status: 'failed' },
      current: null,
      upcoming: { at: nextAt },
    };
    const line = formatBoardSyncScheduleSummary(schedule);
    expect(line).toMatch(/^Sync schedule: Previous .+ \(Failed\), Next scheduled run .+$/);
  });

  it('returns null when schedule has nothing to show', () => {
    expect(
      formatBoardSyncScheduleSummary({
        timezone: TZ,
        previous: null,
        current: null,
        upcoming: null,
      }),
    ).toBeNull();
    expect(formatBoardSyncScheduleSummary(null)).toBeNull();
  });
});
