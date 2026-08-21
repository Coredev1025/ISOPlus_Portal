import { describe, it, expect } from 'vitest';
import {
  BOARD_SYNC_CRON_DEFAULT,
  BOARD_SYNC_KIND,
} from '../../../src/constants/scheduler.js';
import { SCHEDULED_SYNC_JOB_TYPE } from '../../../src/constants/sync.js';
import {
  buildScheduledSyncSpecs,
  buildScheduledSyncBoardWrites,
  isEligibleSyncBoard,
  resolveBoardSyncCron,
  scheduledSyncPeriodKey,
} from '../../../src/utils/boardSyncSweepHelpers.js';

const TZ = 'Australia/Sydney';
const slot = new Date('2026-08-11T16:00:00Z'); // 02:00 on the 12th, Sydney

describe('resolveBoardSyncCron', () => {
  it('defaults to daily 02:00 when the env var is blank', () => {
    expect(BOARD_SYNC_CRON_DEFAULT).toBe('0 2 * * *');
    expect(resolveBoardSyncCron({})).toBe('0 2 * * *');
    expect(resolveBoardSyncCron({ BOARD_SYNC_CRON: '   ' })).toBe('0 2 * * *');
  });

  it('uses a trimmed BOARD_SYNC_CRON when set', () => {
    expect(resolveBoardSyncCron({ BOARD_SYNC_CRON: '  0 4 * * *  ' })).toBe('0 4 * * *');
  });
});

describe('isEligibleSyncBoard', () => {
  it('accepts a sync-enabled board with ids', () => {
    expect(isEligibleSyncBoard({
      syncData: true, boardId: 'b1', workspaceId: 'ws-1',
    })).toBe(true);
  });

  it('rejects boards that are not syncing or missing ids', () => {
    expect(isEligibleSyncBoard({ syncData: false, boardId: 'b1', workspaceId: 'ws-1' })).toBe(false);
    expect(isEligibleSyncBoard({ syncData: true, boardId: '', workspaceId: 'ws-1' })).toBe(false);
    expect(isEligibleSyncBoard({ syncData: true, boardId: 'b1', workspaceId: null })).toBe(false);
  });
});

describe('buildScheduledSyncSpecs', () => {
  it('emits one scheduled_sync job per eligible board and skips the rest', () => {
    const specs = buildScheduledSyncSpecs({
      boards: [
        { syncData: true, boardId: 'b1', workspaceId: 'ws-1' },
        { syncData: false, boardId: 'b2', workspaceId: 'ws-1' },
        { syncData: true, boardId: 'b3', workspaceId: 'ws-2' },
      ],
      slot,
      timezone: TZ,
      authorization: 'Bearer t',
    });

    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({
      name: SCHEDULED_SYNC_JOB_TYPE,
      data: {
        jobType: SCHEDULED_SYNC_JOB_TYPE,
        authorization: 'Bearer t',
        workspaceId: 'ws-1',
        boardId: 'b1',
      },
    });
    expect(specs[0].opts.jobId).toBe('sched:b1:20260812-0200');
    // BullMQ: lower number = higher priority (0 highest). Manual Resync uses 2
    // (services/sync.js); the sweep must be numerically greater so it yields.
    const MANUAL_RESYNC_PRIORITY = 2;
    expect(specs[0].opts.priority).toBeGreaterThan(MANUAL_RESYNC_PRIORITY);
    expect(specs[0].opts.priority).toBe(10);
    expect(specs[1].opts.jobId).toBe('sched:b3:20260812-0200');
  });

  it('is stable for the same claimed slot', () => {
    const args = {
      boards: [{ syncData: true, boardId: 'b1', workspaceId: 'ws-1' }],
      slot,
      timezone: TZ,
      authorization: 'Bearer t',
    };
    expect(buildScheduledSyncSpecs(args)[0].opts.jobId).toBe(
      buildScheduledSyncSpecs({ ...args, slot: new Date(slot) })[0].opts.jobId,
    );
  });

  it('does not mutate the boards argument', () => {
    const boards = [{ syncData: true, boardId: 'b1', workspaceId: 'ws-1' }];
    buildScheduledSyncSpecs({ boards, slot, timezone: TZ, authorization: 'Bearer t' });
    expect(boards).toEqual([{ syncData: true, boardId: 'b1', workspaceId: 'ws-1' }]);
  });
});

describe('scheduledSyncPeriodKey', () => {
  it('is identical for wall clocks in the same cron minute', () => {
    const a = scheduledSyncPeriodKey({
      slot: new Date('2026-08-11T16:00:01Z'),
      timezone: TZ,
    });
    const b = scheduledSyncPeriodKey({
      slot: new Date('2026-08-11T16:00:59Z'),
      timezone: TZ,
    });
    expect(a).toBe(b);
    expect(a).toBe('20260812-0200');
  });
});

describe('buildScheduledSyncBoardWrites', () => {
  it('emits one pipeline update per board that stamps job id and conditionally flips status', () => {
    const specs = buildScheduledSyncSpecs({
      boards: [
        { syncData: true, boardId: 'live', workspaceId: 'ws-1' },
        { syncData: true, boardId: 'backlog', workspaceId: 'ws-1' },
      ],
      slot,
      timezone: TZ,
      authorization: 'Bearer t',
    });
    const writes = buildScheduledSyncBoardWrites(specs);
    expect(writes).toHaveLength(2);
    expect(writes[0].updateOne.filter).toEqual({ boardId: 'live' });
    expect(writes[0].updateOne.update).toEqual([{
      $set: {
        syncJobId: 'sched:live:20260812-0200',
        syncStatus: {
          $cond: [
            { $in: ['$syncStatus', expect.any(Array)] },
            SCHEDULED_SYNC_JOB_TYPE,
            '$syncStatus',
          ],
        },
      },
    }]);
  });
});

describe('portal identifiers', () => {
  it('uses the existing kind for the portal-wide sweep', () => {
    expect(BOARD_SYNC_KIND).toBe('board_sync');
  });
});
