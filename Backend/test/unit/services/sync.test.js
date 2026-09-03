import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server.js';
import Board from '../../../src/models/Board.js';
import { BOARD_SYNC_CRON_DEFAULT } from '../../../src/constants/scheduler.js';
import {
  enableBoardSync,
  disableBoardSync,
  cancelBoardSync,
  startBacklogSync,
  enableWorkspaceSync,
  getBoardSyncStatus,
} from '../../../src/services/sync.js';
import { computeNextRun } from '../../../src/services/scheduler/nextRun.js';
import { DEFAULT_TIMEZONE } from '../../../src/constants/scheduler.js';

/**
 * src/services/sync.js. test/unit/routes/sync.test.js already drives most of
 * this through HTTP; these tests cover what the router cannot reach — the
 * functions with no route (startBacklogSync), the errors the service throws for
 * the router to translate, and the ISO+ hook calls it makes on the way.
 *
 * Job ids come from the BullMQ stub in test/setup.js, so they are never
 * asserted for their value — only that the service stores whatever the queue
 * handed back.
 */

const API = 'https://app.isoplus.online/api/v2';

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

const seedBoard = async (overrides = {}) => {
  const boardId = overrides.boardId || nextId('board');
  await Board.create({ boardId, name: 'Master Plan', workspaceId: 'w1', ...overrides });
  return boardId;
};

describe('enableBoardSync', () => {
  it('rejects ids that cannot be used as ISO+ path segments', async () => {
    await expect(enableBoardSync('auth', 'w1', '../etc')).rejects.toThrow(
      'Invalid boardId: path traversal sequences are not allowed.'
    );
    await expect(enableBoardSync('auth', null, 'b1')).rejects.toThrow(
      'Invalid workspaceId: expected a non-empty string.'
    );
  });

  it('creates the board when none exists yet', async () => {
    const boardId = nextId('board');
    const workspaceId = nextId('ws');

    const result = await enableBoardSync('Bearer t', workspaceId, boardId);

    expect(result.success).toBe(true);
    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.workspaceId).toBe(workspaceId);
    expect(stored.syncData).toBe(true);
    expect(stored.syncStatus).toBe('sync_enabled');
  });

  it('clears the previous failure before queueing the validation', async () => {
    const boardId = await seedBoard({
      syncStatus: 'failed',
      lastSyncError: 'previous run blew up',
      validationErrors: ['Missing required folder: Jobs'],
    });

    const result = await enableBoardSync('Bearer t', 'w1', boardId);

    expect(result.success).toBe(true);
    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.lastSyncError).toBeNull();
    expect(stored.validationErrors).toEqual([]);
  });

  it.each([
    'sync_enabled',
    'board_validation',
    'board_valid',
    'data_backlog_sync',
    'realtime_sync',
    'manual_triggered_sync',
    'scheduled_sync',
  ])('refuses to re-enable a board already in %s', async (syncStatus) => {
    const boardId = await seedBoard({ syncStatus });

    const result = await enableBoardSync('Bearer t', 'w1', boardId);

    expect(result).toEqual({
      success: false,
      message: `Sync already enabled for this board (current status: ${syncStatus})`,
      boardId,
      syncStatus,
    });
  });

  it('still enables sync when the ISO+ hook registration fails', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    server.use(
      http.post(`${API}/workspaces/${workspaceId}/boards/${boardId}/hooks`, () =>
        HttpResponse.json({ message: 'hook rejected' }, { status: 422 })
      )
    );

    const result = await enableBoardSync('Bearer t', workspaceId, boardId);

    expect(result.success).toBe(true);
    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.syncStatus).toBe('sync_enabled');
    expect(stored.hookId).toBeNull();
  });
});

describe('disableBoardSync', () => {
  it('rejects an unknown board so the caller can decide the status code', async () => {
    await expect(disableBoardSync(nextId('missing'))).rejects.toThrow('Board not found');
  });

  it('clears the hook locally but never deletes it from ISO+', async () => {
    // disableBoardSync loads the board with .select('syncJobId hookId
    // workspaceId'), so board.boardId is undefined by the time
    // unregisterBoardHook builds the ISO+ URL; sanitizeApiPathSegment rejects
    // it and the failure is swallowed as a warning. The hook is therefore left
    // live in ISO+ while the local record forgets it. Reported as a bug;
    // pinned here as current behaviour.
    const workspaceId = nextId('ws');
    const boardId = await seedBoard({ workspaceId, hookId: 'hook-77', syncData: true });
    const deleted = [];
    server.use(
      http.delete(
        `${API}/workspaces/${workspaceId}/boards/${boardId}/hooks/:hookId`,
        ({ params }) => {
          deleted.push(params.hookId);
          return HttpResponse.json({ deleted: true });
        }
      )
    );

    const result = await disableBoardSync(boardId, 'Bearer t');

    expect(result.success).toBe(true);
    expect(deleted).toEqual([]);
    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.hookId).toBeNull();
    expect(stored.hookSecret).toBeNull();
  });

  it('does not call ISO+ at all when the board has no hook', async () => {
    const workspaceId = nextId('ws');
    const boardId = await seedBoard({ workspaceId, syncData: true });
    let called = false;
    server.use(
      http.delete(`${API}/workspaces/${workspaceId}/boards/${boardId}/hooks/:hookId`, () => {
        called = true;
        return HttpResponse.json({ deleted: true });
      })
    );

    await disableBoardSync(boardId);

    expect(called).toBe(false);
  });
});

describe('cancelBoardSync', () => {
  it('rejects an unknown board', async () => {
    await expect(cancelBoardSync(nextId('missing'))).rejects.toThrow('Board not found');
  });

  it('coerces a non-string boardId before querying', async () => {
    const boardId = '90210';
    await seedBoard({ boardId, syncData: true });

    const result = await cancelBoardSync(90210);

    expect(result).toEqual({
      success: true,
      message: 'Sync cancelled successfully',
      boardId: 90210,
      syncStatus: 'sync_cancelled',
    });
    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.syncStatus).toBe('sync_cancelled');
    expect(stored.lastSyncError).toBe('Sync cancelled by user');
  });
});

describe('startBacklogSync', () => {
  it('queues a backlog job and records its id on the board', async () => {
    const boardId = await seedBoard({ syncData: true, syncStatus: 'board_valid' });

    const result = await startBacklogSync('Bearer t', 'w1', boardId);

    expect(result.success).toBe(true);
    expect(result.jobId).toBeTruthy();
    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.syncJobId).toBe(result.jobId);
  });

  it('does not create a board that does not exist', async () => {
    const boardId = nextId('missing');

    const result = await startBacklogSync('Bearer t', 'w1', boardId);

    expect(result.success).toBe(true);
    expect(await Board.findOne({ boardId }).lean()).toBeNull();
  });
});

describe('enableWorkspaceSync', () => {
  it('reports nothing to do when no board is in an enableable state', async () => {
    await seedBoard({ syncStatus: 'realtime_sync' });

    const result = await enableWorkspaceSync('Bearer t', 'w1');

    expect(result).toEqual({
      success: true,
      message: 'No boards available to sync',
      enabledBoards: 0,
      boards: [],
    });
  });

  it.each(['disabled', 'sync_stopped', 'sync_cancelled', 'failed'])(
    'picks up a board in %s',
    async (syncStatus) => {
      const boardId = await seedBoard({ syncStatus });

      const result = await enableWorkspaceSync('Bearer t', 'w1');

      expect(result.boards.map((b) => b.boardId)).toEqual([boardId]);
      expect(result.enabledBoards).toBe(1);
    }
  );

  it('records a per-board failure without abandoning the rest of the workspace', async () => {
    // A boardId that sanitizeApiPathSegment refuses makes enableBoardSync throw
    // for that board only.
    await seedBoard({ boardId: 'bad/board', name: 'Broken', syncStatus: 'failed' });
    const goodBoardId = await seedBoard({ name: 'Working', syncStatus: 'failed' });

    const result = await enableWorkspaceSync('Bearer t', 'w1');

    expect(result.success).toBe(true);
    expect(result.totalBoards).toBe(2);
    expect(result.enabledBoards).toBe(1);

    const failed = result.boards.find((b) => b.boardId === 'bad/board');
    expect(failed).toEqual({
      boardId: 'bad/board',
      boardName: 'Broken',
      enabled: false,
      error: 'Invalid boardId: path traversal sequences are not allowed.',
    });
    expect(result.boards.find((b) => b.boardId === goodBoardId).enabled).toBe(true);
  });
});

describe('getBoardSyncStatus', () => {
  it('rejects an unknown board', async () => {
    await expect(getBoardSyncStatus(nextId('missing'))).rejects.toThrow('Board not found');
  });

  it('returns the stored state with no job or execution attached', async () => {
    const boardId = await seedBoard({
      syncData: true,
      syncStatus: 'realtime_sync',
      syncStats: { itemsSynced: 12 },
    });

    const status = await getBoardSyncStatus(boardId);

    expect(status).toMatchObject({
      boardId,
      boardName: 'Master Plan',
      syncData: true,
      syncStatus: 'realtime_sync',
      jobStatus: null,
      syncExecution: null,
    });
    expect(status.syncStats.itemsSynced).toBe(12);
  });

  it('attaches the portal next run on schedule.upcoming from the cron', async () => {
    const savedCron = process.env.BOARD_SYNC_CRON;
    const savedEnabled = process.env.BOARD_SYNC_ENABLED;
    delete process.env.BOARD_SYNC_CRON;
    delete process.env.BOARD_SYNC_ENABLED;
    try {
      const boardId = await seedBoard({
        syncData: true,
        syncStatus: 'realtime_sync',
      });
      const before = new Date();

      const status = await getBoardSyncStatus(boardId);
      const expected = computeNextRun(BOARD_SYNC_CRON_DEFAULT, DEFAULT_TIMEZONE, before);

      expect(status.schedule.cron).toBe(BOARD_SYNC_CRON_DEFAULT);
      expect(status.schedule.timezone).toBe(DEFAULT_TIMEZONE);
      expect(status.schedule.upcoming.at.toISOString()).toBe(expected.toISOString());
      expect(status.schedule.current).toBeNull();
    } finally {
      if (savedCron === undefined) delete process.env.BOARD_SYNC_CRON;
      else process.env.BOARD_SYNC_CRON = savedCron;
      if (savedEnabled === undefined) delete process.env.BOARD_SYNC_ENABLED;
      else process.env.BOARD_SYNC_ENABLED = savedEnabled;
    }
  });
});
