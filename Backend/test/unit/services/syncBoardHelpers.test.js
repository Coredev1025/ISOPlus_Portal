import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server.js';

// syncBoardHelpers sits between the sync service and two external systems: the
// BullMQ queue and the ISO+ hooks API. Every function returns undefined or a
// plain object, so the behaviour worth pinning is *which* calls it makes and
// which it refuses to make — a dropped guard here cancels the wrong job or
// deletes a hook for a board that has none.

const queue = vi.hoisted(() => ({
  calls: [],
  impl: async () => null,
}));

vi.mock('../../../src/services/sync/queue.js', () => ({
  default: {
    getJob: async (jobId) => {
      queue.calls.push(jobId);
      return queue.impl(jobId);
    },
  },
}));

const {
  cancelPendingSyncJob,
  unregisterBoardHook,
  checkActiveQueueJob,
} = await import('../../../src/services/syncBoardHelpers.js');

const HOOK_URL = 'https://app.isoplus.online/api/v2/workspaces/:workspaceId/boards/:boardId/hooks/:hookId';

function recordHookDeletes({ status = 200, body = { deleted: true } } = {}) {
  const seen = [];
  server.use(
    http.delete(HOOK_URL, ({ request, params }) => {
      seen.push({
        url: request.url,
        authorization: request.headers.get('authorization'),
        params,
      });
      return HttpResponse.json(body, { status });
    })
  );
  return seen;
}

beforeEach(() => {
  queue.calls = [];
  queue.impl = async () => null;
});

describe('cancelPendingSyncJob', () => {
  it('does not query the queue at all when the board has no job id', async () => {
    await expect(cancelPendingSyncJob('board-1', null)).resolves.toBeUndefined();
    await cancelPendingSyncJob('board-1', undefined);
    await cancelPendingSyncJob('board-1', '');

    // Without the guard these become getJob(null) — a lookup for a job that
    // cannot exist, on every board that has never been synced.
    expect(queue.calls).toEqual([]);
  });

  it('removes the job it looked up, keyed by the id it was given', async () => {
    const removed = [];
    queue.impl = async (jobId) => ({ id: jobId, remove: async () => removed.push(jobId) });

    await cancelPendingSyncJob('board-1', 'job_42');

    expect(queue.calls).toEqual(['job_42']);
    expect(removed).toEqual(['job_42']);
  });

  it('is a no-op when the queue no longer holds the job', async () => {
    queue.impl = async () => null;

    await expect(cancelPendingSyncJob('board-1', 'job_gone')).resolves.toBeUndefined();
    expect(queue.calls).toEqual(['job_gone']);
  });

  it('swallows a queue lookup failure instead of failing the board update', async () => {
    queue.impl = async () => {
      throw new Error('Redis connection lost');
    };

    await expect(cancelPendingSyncJob('board-1', 'job_42')).resolves.toBeUndefined();
  });

  it('swallows a failure to remove the job', async () => {
    queue.impl = async () => ({
      remove: async () => {
        throw new Error('job is locked');
      },
    });

    await expect(cancelPendingSyncJob('board-1', 'job_42')).resolves.toBeUndefined();
  });
});

describe('unregisterBoardHook', () => {
  it('issues a DELETE to the board hook, with the caller authorization', async () => {
    const seen = recordHookDeletes();

    await unregisterBoardHook(
      { boardId: 'brd_9', workspaceId: '55369', hookId: 'hook_test_1' },
      'Bearer tok_abc',
      'Removing hook for board',
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(
      'https://app.isoplus.online/api/v2/workspaces/55369/boards/brd_9/hooks/hook_test_1'
    );
    expect(seen[0].authorization).toBe('Bearer tok_abc');
  });

  it.each([
    ['no hook id', { boardId: 'brd_9', workspaceId: '55369' }, 'Bearer tok'],
    ['no authorization', { boardId: 'brd_9', workspaceId: '55369', hookId: 'h1' }, ''],
    ['no workspace id', { boardId: 'brd_9', hookId: 'h1' }, 'Bearer tok'],
    ['no board at all', null, 'Bearer tok'],
  ])('sends nothing when there is %s', async (_label, board, authorization) => {
    const seen = recordHookDeletes();

    await expect(unregisterBoardHook(board, authorization, 'ctx')).resolves.toBeUndefined();

    expect(seen).toEqual([]);
  });

  it('resolves quietly when ISO+ rejects the delete', async () => {
    // The caller is mid-way through deleting a board; a failed hook removal
    // must not abort that, it is logged and left orphaned upstream.
    const seen = recordHookDeletes({ status: 500, body: { message: 'boom' } });

    await expect(
      unregisterBoardHook(
        { boardId: 'brd_9', workspaceId: '55369', hookId: 'hook_test_1' },
        'Bearer tok',
        'ctx',
      )
    ).resolves.toBeUndefined();

    expect(seen).toHaveLength(1);
  });

  it('resolves quietly when the workspace id is not a usable path segment', async () => {
    // sanitizeApiPathSegment rejects "../" style ids by throwing; this is the
    // path where no request can be built at all.
    const seen = recordHookDeletes();

    await expect(
      unregisterBoardHook(
        { boardId: 'brd_9', workspaceId: '../admin', hookId: 'hook_1' },
        'Bearer tok',
        'ctx',
      )
    ).resolves.toBeUndefined();

    expect(seen).toEqual([]);
  });
});

describe('checkActiveQueueJob', () => {
  const inProgress = ['board_validation', 'data_backlog_sync', 'manual_triggered_sync'];

  it.each(inProgress)('reports an active job for syncStatus %s', async (syncStatus) => {
    queue.impl = async () => ({ getState: async () => 'active' });

    const result = await checkActiveQueueJob('brd_9', 'job_7', syncStatus);

    expect(result).toEqual({
      success: false,
      alreadyRunning: true,
      message: 'A sync is already running for this board. Please wait for it to complete.',
      boardId: 'brd_9',
      syncStatus,
      jobId: 'job_7',
      jobState: 'active',
    });
  });

  it.each(['waiting', 'delayed'])('describes a %s job as queued, not running', async (jobState) => {
    queue.impl = async () => ({ getState: async () => jobState });

    const result = await checkActiveQueueJob('brd_9', 'job_7', 'data_backlog_sync');

    expect(result.message).toBe(
      'A sync is already queued for this board. Please wait for it to complete.'
    );
    expect(result.jobState).toBe(jobState);
    expect(result.alreadyRunning).toBe(true);
  });

  it('returns null without asking the queue when there is no job id', async () => {
    expect(await checkActiveQueueJob('brd_9', null, 'data_backlog_sync')).toBeNull();
    expect(queue.calls).toEqual([]);
  });

  it.each(['synced', 'sync_failed', 'not_synced', 'cancelled'])(
    'returns null without asking the queue for syncStatus %s',
    async (syncStatus) => {
      // A stale syncJobId survives on the board document after a sync ends. If
      // the status filter were dropped, every re-sync of a finished board would
      // be refused as "already running".
      queue.impl = async () => ({ getState: async () => 'active' });

      expect(await checkActiveQueueJob('brd_9', 'job_7', syncStatus)).toBeNull();
      expect(queue.calls).toEqual([]);
    }
  );

  it('returns null when the queue has already dropped the job', async () => {
    queue.impl = async () => null;

    expect(await checkActiveQueueJob('brd_9', 'job_7', 'board_validation')).toBeNull();
    expect(queue.calls).toEqual(['job_7']);
  });

  it.each(['completed', 'failed', 'unknown'])(
    'returns null for a job in state %s',
    async (jobState) => {
      queue.impl = async () => ({ getState: async () => jobState });

      expect(await checkActiveQueueJob('brd_9', 'job_7', 'manual_triggered_sync')).toBeNull();
    }
  );

  it('returns null when the queue lookup throws, so the sync is allowed to proceed', async () => {
    queue.impl = async () => {
      throw new Error('Redis connection lost');
    };

    expect(await checkActiveQueueJob('brd_9', 'job_7', 'board_validation')).toBeNull();
  });

  it('returns null when reading the job state throws', async () => {
    queue.impl = async () => ({
      getState: async () => {
        throw new Error('job data corrupt');
      },
    });

    expect(await checkActiveQueueJob('brd_9', 'job_7', 'board_validation')).toBeNull();
  });
});
