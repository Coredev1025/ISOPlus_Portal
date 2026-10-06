import { describe, it, expect } from 'vitest';
import {
  boardSyncScheduleSummaryParts,
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

  it('formats an instant in en-AU with uppercase meridiem', () => {
    const formatted = formatScheduleInstant('2026-08-26T11:44:00.000Z', TZ);
    expect(formatted).toMatch(/2026/);
    expect(formatted).toMatch(/\b(AM|PM)\b/);
    expect(formatted).not.toMatch(/\b(am|pm)\b/);
  });

  it('labels previous Success and Failed for the status panel', () => {
    const at = '2026-08-26T09:11:00.000Z';
    expect(labelPreviousSync({ at, status: 'completed' }, TZ)).toMatch(/\(Success\)$/);
    expect(labelPreviousSync({ at, status: 'failed' }, TZ)).toMatch(/\(Failed\)$/);
  });
});

describe('formatBoardSyncScheduleSummary', () => {
  const previousAt = '2026-08-26T11:44:00.000Z';
  const nextAt = '2026-08-27T08:00:00.000Z';

  it('example 1: Previous successful + Next scheduled run', () => {
    const schedule: BoardSyncSchedule = {
      timezone: TZ,
      previous: { at: previousAt, status: 'completed' },
      current: null,
      upcoming: { at: nextAt },
    };
    const line = formatBoardSyncScheduleSummary(schedule);
    expect(line).toBe(
      'Sync schedule: Previous run: 26 Aug 2026, 9:44 PM (successful). Next scheduled run: 27 Aug 2026, 6:00 PM.',
    );
  });

  it('example 2: Previous failed + Current In progress', () => {
    const schedule: BoardSyncSchedule = {
      timezone: TZ,
      previous: { at: previousAt, status: 'failed' },
      current: { state: 'active', syncType: 'scheduled_sync' },
      upcoming: { at: nextAt },
    };
    const line = formatBoardSyncScheduleSummary(schedule);
    expect(line).toMatch(
      /^Sync schedule: Previous run: .+ \(failed\)\. Current \(In progress\)\.$/,
    );
  });

  it('example 3: Previous failed + Next scheduled run when idle', () => {
    const schedule: BoardSyncSchedule = {
      timezone: TZ,
      previous: { at: previousAt, status: 'failed' },
      current: null,
      upcoming: { at: nextAt },
    };
    const line = formatBoardSyncScheduleSummary(schedule);
    expect(line).toMatch(
      /^Sync schedule: Previous run: .+ \(failed\)\. Next scheduled run: .+\.$/,
    );
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

describe('boardSyncScheduleSummaryParts', () => {
  const previousAt = '2026-08-26T11:44:00.000Z';
  const nextAt = '2026-08-27T08:00:00.000Z';

  it('marks Sync schedule label and instants as bold', () => {
    const schedule: BoardSyncSchedule = {
      timezone: TZ,
      previous: { at: previousAt, status: 'completed' },
      current: null,
      upcoming: { at: nextAt },
    };
    const parts = boardSyncScheduleSummaryParts(schedule);

    expect(parts).not.toBeNull();
    const bold = parts!.filter((part) => part.bold).map((part) => part.text);
    expect(bold[0]).toBe('Sync schedule:');
    expect(bold).toContain('26 Aug 2026, 9:44 PM');
    expect(bold).toContain('27 Aug 2026, 6:00 PM');
    expect(parts!.map((part) => part.text).join('')).toBe(
      formatBoardSyncScheduleSummary(schedule),
    );
  });
});
