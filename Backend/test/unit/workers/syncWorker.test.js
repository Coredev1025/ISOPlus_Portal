import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server.js';
import Board from '../../../src/models/Board.js';
import Item from '../../../src/models/Item.js';
import SyncExecution from '../../../src/models/SyncExecution.js';

/**
 * src/workers/syncWorker.js does not export its job processor — it hands it
 * straight to `new Worker(...)`. This file therefore replaces the bullmq mock
 * from test/setup.js with one that records the processor, so the three job
 * types can be driven directly with a hand-built job object rather than by
 * running a real queue.
 *
 * Everything else is real: MongoDB (in memory) and the ISO+ HTTP calls through
 * MSW. The assertions are about the SyncExecution and Item documents the worker
 * writes and the Board state it leaves behind.
 */

const bull = vi.hoisted(() => ({
  workers: [],
  state: {
    added: [],
    counts: { waiting: 0, active: 0, failed: 0 },
    failedJobs: [],
    seq: 0,
  },
}));

vi.mock('bullmq', () => {
  class Queue {
    constructor(name) {
      this.name = name;
    }
    on() {}
    async add(name, data, opts) {
      bull.state.seq += 1;
      const id = opts?.jobId || `job-${bull.state.seq}`;
      bull.state.added.push({ name, data, opts, id });
      return { id };
    }
    async getWaitingCount() {
      return bull.state.counts.waiting;
    }
    async getActiveCount() {
      return bull.state.counts.active;
    }
    async getFailedCount() {
      return bull.state.counts.failed;
    }
    async getFailed() {
      return bull.state.failedJobs;
    }
    async getJob() {
      return null;
    }
  }
  class Worker {
    constructor(name, processor, opts) {
      bull.workers.push({ name, processor, opts });
    }
    on() {}
  }
  return { Queue, Worker };
});

const { checkAndRetryFailedJobs } = await import('../../../src/workers/syncWorker.js');
const processJob = bull.workers[0].processor;

const API = 'https://app.isoplus.online/api/v2';

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

function makeJob(data, id = 'job-under-test') {
  return { id, data, updateProgress: async () => {} };
}

/** ISO+ returns one board (the one being synced) and the given item pages. */
function stubBacklogUpstream({ workspaceId, boardId, pages }) {
  server.use(
    http.get(`${API}/workspaces/${workspaceId}/boards`, () =>
      HttpResponse.json({
        data: [
          {
            id: boardId,
            name: 'Synced Board',
            color: 'blue',
            description: 'from ISO+',
            og_image: 'og.png',
          },
        ],
        has_more: false,
        after: null,
      })
    ),
    http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/items/`, ({ request }) => {
      const after = new URL(request.url).searchParams.get('after');
      const index = after ? Number(after) : 0;
      const page = pages[index] || [];
      const hasMore = index + 1 < pages.length;
      return HttpResponse.json({
        data: page,
        has_more: hasMore,
        after: hasMore ? String(index + 1) : null,
      });
    })
  );
}

const isoPlusItem = (id, title) => ({
  id,
  folder_id: 'folder-1',
  values: [{ data: title, attribute: { id: 'a1', name: 'Title', type: 'text' } }],
});

beforeEach(() => {
  bull.state.added = [];
  bull.state.counts = { waiting: 0, active: 0, failed: 0 };
  bull.state.failedJobs = [];
});

describe('the worker registration itself', () => {
  it('subscribes to the board-sync queue with a concurrency of one', () => {
    expect(bull.workers).toHaveLength(1);
    expect(bull.workers[0].name).toBe('board-sync');
    expect(bull.workers[0].opts.concurrency).toBe(1);
    expect(bull.workers[0].opts.limiter).toEqual({ max: 10, duration: 1000 });
  });
});

describe('processJob dispatch', () => {
  it('rejects a job type it does not know', async () => {
    await expect(processJob(makeJob({ jobType: 'nonsense' }))).rejects.toThrow(
      'Unknown job type: nonsense'
    );
  });

  it('rejects a job with no jobType at all', async () => {
    await expect(processJob(makeJob({}))).rejects.toThrow('Unknown job type: undefined');
  });
});

describe('board_validation jobs', () => {
  it('marks the board valid and queues the backlog sync', async () => {
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Jobs', workspaceId: 'w1', syncStatus: 'sync_enabled' });

    const result = await processJob(
      makeJob({
        jobType: 'board_validation',
        authorization: 'Bearer t',
        workspaceId: 'w1',
        boardId,
        label: 'Default',
      })
    );

    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.syncStatus).toBe('board_valid');
    expect(stored.validationErrors).toEqual([]);
    expect(stored.lastSyncError).toBeNull();

    const queued = bull.state.added.at(-1);
    expect(queued.name).toBe('backlog_sync');
    expect(queued.data).toMatchObject({
      jobType: 'data_backlog_sync',
      authorization: 'Bearer t',
      workspaceId: 'w1',
      boardId,
    });
    expect(queued.opts.priority).toBe(3);

    expect(result).toMatchObject({ success: true, nextStep: 'data_backlog_sync' });
    expect(stored.syncJobId).toBe(result.backlogJobId);
  });

  it('records the validation errors and rethrows when the board is missing folders', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'NDIS Board', workspaceId, syncStatus: 'sync_enabled' });
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/folders/`, () =>
        HttpResponse.json({ data: [], has_more: false, after: null })
      )
    );

    await expect(
      processJob(
        makeJob({
          jobType: 'board_validation',
          authorization: 'Bearer t',
          workspaceId,
          boardId,
          label: 'NDIS',
        })
      )
    ).rejects.toThrow(
      'Board validation failed: Missing required folder: Participants, Missing required folder: Service Plans'
    );

    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.syncStatus).toBe('board_invalid');
    expect(stored.validationErrors).toEqual([
      'Missing required folder: Participants',
      'Missing required folder: Service Plans',
    ]);
    expect(stored.lastSyncError).toBe(
      'Board validation failed: Missing required folder: Participants, Missing required folder: Service Plans'
    );
  });

  it('does not queue a backlog job when validation fails', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'NDIS Board', workspaceId, syncStatus: 'sync_enabled' });
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/folders/`, () =>
        HttpResponse.json({ data: [], has_more: false, after: null })
      )
    );

    await expect(
      processJob(
        makeJob({
          jobType: 'board_validation',
          authorization: 'Bearer t',
          workspaceId,
          boardId,
          label: 'NDIS',
        })
      )
    ).rejects.toThrow();

    expect(bull.state.added).toEqual([]);
  });

  it('claims the job by writing its id onto the board before validating', async () => {
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Jobs', workspaceId: 'w1' });

    await processJob(
      makeJob(
        {
          jobType: 'board_validation',
          authorization: 'Bearer t',
          workspaceId: 'w1',
          boardId,
          label: 'Default',
        },
        'validation-job-1'
      )
    );

    // The backlog job id replaces it once validation succeeds, so assert on the
    // queued backlog job rather than the intermediate write.
    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.syncJobId).toBe(bull.state.added.at(-1).id);
  });
});

describe('data_backlog_sync jobs', () => {
  it('writes every item page, records the counts and finishes in realtime_sync', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Old Name', workspaceId, syncStatus: 'board_valid' });
    stubBacklogUpstream({
      workspaceId,
      boardId,
      pages: [[isoPlusItem('item-1', 'One'), isoPlusItem('item-2', 'Two')], [isoPlusItem('item-3', 'Three')]],
    });

    const result = await processJob(
      makeJob({
        jobType: 'data_backlog_sync',
        authorization: 'Bearer t',
        workspaceId,
        boardId,
      })
    );

    expect(result.success).toBe(true);
    expect(result.nextStep).toBe('realtime_sync');
    expect(result.stats).toMatchObject({
      foldersProcessed: 1,
      itemsProcessed: 3,
      itemsInserted: 3,
      itemsUpdated: 0,
      itemsDeleted: 0,
    });

    const items = await Item.find({ boardId }).sort({ itemId: 1 }).lean();
    expect(items.map((i) => i.itemId)).toEqual(['item-1', 'item-2', 'item-3']);
    expect(items[0].workspaceId).toBe(workspaceId);
    expect(items[0].folderId).toBe('folder-1');
    expect(items[0].data.Title).toBe('One');
    expect(items.every((i) => i.syncGUID === result.syncGUID)).toBe(true);

    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.syncStatus).toBe('realtime_sync');
    expect(stored.lastSyncError).toBeNull();
    expect(stored.currentSyncGUID).toBe(result.syncGUID);
    expect(stored.name).toBe('Synced Board');
    expect(stored.syncStats.itemsSynced).toBe(3);
    expect(stored.syncStats.itemsCreated).toBe(3);
    expect(stored.syncStats.retryCount).toBe(0);
  });

  it('records a completed SyncExecution with the same counters', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Board', workspaceId });
    stubBacklogUpstream({ workspaceId, boardId, pages: [[isoPlusItem('item-1', 'One')]] });

    const result = await processJob(
      makeJob({ jobType: 'data_backlog_sync', authorization: 'Bearer t', workspaceId, boardId })
    );

    const execution = await SyncExecution.findOne({ syncGUID: result.syncGUID }).lean();
    expect(execution.status).toBe('completed');
    expect(execution.boardId).toBe(boardId);
    expect(execution.workspaceId).toBe(workspaceId);
    expect(execution.syncType).toBe('data_backlog_sync');
    expect(execution.triggeredBy).toBe('system');
    expect(execution.counters.itemsProcessed).toBe(1);
    expect(execution.counters.itemsInserted).toBe(1);
    expect(execution.counters.itemsDeleted).toBe(0);
    expect(execution.endTime).not.toBeNull();
  });

  it('deletes items left over from a previous sync of the same board', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Board', workspaceId });
    await Item.create({
      workspaceId,
      boardId,
      folderId: 'folder-1',
      itemId: 'stale-item',
      syncGUID: 'guid-from-a-previous-run',
      data: {},
    });
    stubBacklogUpstream({ workspaceId, boardId, pages: [[isoPlusItem('item-1', 'One')]] });

    const result = await processJob(
      makeJob({ jobType: 'data_backlog_sync', authorization: 'Bearer t', workspaceId, boardId })
    );

    expect(result.stats.itemsDeleted).toBe(1);
    expect(await Item.findOne({ itemId: 'stale-item' }).lean()).toBeNull();
    expect(await Item.findOne({ itemId: 'item-1' }).lean()).not.toBeNull();
  });

  it('leaves items belonging to other boards alone', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    const otherBoardId = nextId('board');
    await Board.create({ boardId, name: 'Board', workspaceId });
    await Item.create({
      workspaceId,
      boardId: otherBoardId,
      folderId: 'folder-1',
      itemId: 'other-board-item',
      syncGUID: 'unrelated',
      data: {},
    });
    stubBacklogUpstream({ workspaceId, boardId, pages: [[isoPlusItem('item-1', 'One')]] });

    await processJob(
      makeJob({ jobType: 'data_backlog_sync', authorization: 'Bearer t', workspaceId, boardId })
    );

    expect(await Item.findOne({ itemId: 'other-board-item' }).lean()).not.toBeNull();
  });

  it('updates an item that already exists rather than duplicating it', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Board', workspaceId });
    await Item.create({
      workspaceId,
      boardId,
      folderId: 'folder-1',
      itemId: 'item-1',
      syncGUID: 'old-guid',
      data: { Title: 'stale value' },
    });
    stubBacklogUpstream({ workspaceId, boardId, pages: [[isoPlusItem('item-1', 'fresh value')]] });

    const result = await processJob(
      makeJob({ jobType: 'data_backlog_sync', authorization: 'Bearer t', workspaceId, boardId })
    );

    expect(result.stats.itemsProcessed).toBe(1);
    expect(result.stats.itemsInserted).toBe(0);
    expect(result.stats.itemsUpdated).toBe(1);
    expect(await Item.countDocuments({ itemId: 'item-1' })).toBe(1);
    const stored = await Item.findOne({ itemId: 'item-1' }).lean();
    expect(stored.data.Title).toBe('fresh value');
  });

  it('re-registers the ISO+ hook once the sync completes', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Board', workspaceId });
    stubBacklogUpstream({ workspaceId, boardId, pages: [[isoPlusItem('item-1', 'One')]] });

    await processJob(
      makeJob({ jobType: 'data_backlog_sync', authorization: 'Bearer t', workspaceId, boardId })
    );

    // Values come from the MSW hook stub in test/msw/handlers.js.
    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.hookId).toBe('hook_test_1');
    expect(stored.hookSecret).toBe('secret_test');
  });

  it('fails the board and the sync execution when ISO+ will not list the boards', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    await Board.create({
      boardId,
      name: 'Board',
      workspaceId,
      syncStats: { retryCount: 1 },
    });
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      )
    );

    await expect(
      processJob(
        makeJob({ jobType: 'data_backlog_sync', authorization: 'Bearer t', workspaceId, boardId })
      )
    ).rejects.toThrow('Failed to fetch board data from ISO+');

    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.syncStatus).toBe('failed');
    expect(stored.lastSyncError).toBe('Failed to fetch board data from ISO+');
    expect(stored.syncStats.retryCount).toBe(2);

    const execution = await SyncExecution.findOne({ boardId }).lean();
    expect(execution.status).toBe('failed');
    expect(execution.error.message).toBe('Failed to fetch board data from ISO+');
  });

  it('fails when the workspace does not contain the board being synced', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Board', workspaceId });
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards`, () =>
        HttpResponse.json({ data: [{ id: 'some-other-board' }], has_more: false, after: null })
      )
    );

    await expect(
      processJob(
        makeJob({ jobType: 'data_backlog_sync', authorization: 'Bearer t', workspaceId, boardId })
      )
    ).rejects.toThrow('Board not found in ISO+');

    const execution = await SyncExecution.findOne({ boardId }).lean();
    expect(execution.status).toBe('failed');
    expect(execution.error.message).toBe('Board not found in ISO+');
  });
});

describe('manual_triggered_sync jobs', () => {
  it('runs the backlog sync and records the manual sync type on the execution', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Board', workspaceId, syncStatus: 'realtime_sync' });
    stubBacklogUpstream({ workspaceId, boardId, pages: [[isoPlusItem('item-1', 'One')]] });

    const result = await processJob(
      makeJob({
        jobType: 'manual_triggered_sync',
        authorization: 'Bearer t',
        workspaceId,
        boardId,
      })
    );

    expect(result.success).toBe(true);
    expect(result.nextStep).toBe('realtime_sync');

    const execution = await SyncExecution.findOne({ syncGUID: result.syncGUID }).lean();
    expect(execution.syncType).toBe('manual_triggered_sync');
    expect(execution.status).toBe('completed');

    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.syncStatus).toBe('realtime_sync');
  });
});

describe('scheduled_sync jobs', () => {
  it('runs the catch-up path and records scheduled_sync on the execution', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Board', workspaceId, syncStatus: 'realtime_sync' });
    stubBacklogUpstream({ workspaceId, boardId, pages: [[isoPlusItem('item-1', 'One')]] });

    const result = await processJob(
      makeJob({
        jobType: 'scheduled_sync',
        authorization: 'Bearer t',
        workspaceId,
        boardId,
      })
    );

    expect(result.success).toBe(true);
    expect(result.nextStep).toBe('realtime_sync');

    const execution = await SyncExecution.findOne({ syncGUID: result.syncGUID }).lean();
    expect(execution.syncType).toBe('scheduled_sync');
    expect(execution.status).toBe('completed');

    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.syncStatus).toBe('realtime_sync');
  });
});

describe('checkAndRetryFailedJobs', () => {
  const makeFailedJob = (overrides = {}) => {
    const job = {
      id: overrides.id || 'failed-1',
      name: overrides.name || 'backlog_sync',
      data: overrides.data || { jobType: 'data_backlog_sync', boardId: 'b1' },
      opts: overrides.opts || { priority: 3 },
      removed: false,
      async remove() {
        this.removed = true;
      },
    };
    return job;
  };

  it('does nothing while jobs are still waiting', async () => {
    bull.state.counts = { waiting: 1, active: 0, failed: 2 };
    bull.state.failedJobs = [makeFailedJob()];

    await checkAndRetryFailedJobs();

    expect(bull.state.added).toEqual([]);
    expect(bull.state.failedJobs[0].removed).toBe(false);
  });

  it('does nothing while a job is active', async () => {
    bull.state.counts = { waiting: 0, active: 1, failed: 2 };
    bull.state.failedJobs = [makeFailedJob()];

    await checkAndRetryFailedJobs();

    expect(bull.state.added).toEqual([]);
  });

  it('does nothing when there are no failed jobs', async () => {
    bull.state.counts = { waiting: 0, active: 0, failed: 0 };

    await checkAndRetryFailedJobs();

    expect(bull.state.added).toEqual([]);
  });

  it('removes the failed job and re-queues it with an incremented retry count', async () => {
    const failed = makeFailedJob({
      data: { jobType: 'data_backlog_sync', boardId: 'b1', workspaceId: 'w1' },
    });
    bull.state.counts = { waiting: 0, active: 0, failed: 1 };
    bull.state.failedJobs = [failed];

    await checkAndRetryFailedJobs();

    expect(failed.removed).toBe(true);
    expect(bull.state.added).toHaveLength(1);
    const [retry] = bull.state.added;
    expect(retry.name).toBe('backlog_sync');
    expect(retry.data).toEqual({
      jobType: 'data_backlog_sync',
      boardId: 'b1',
      workspaceId: 'w1',
      retryCount: 1,
    });
    expect(retry.opts).toMatchObject({
      priority: 3,
      attempts: 1,
      backoff: { type: 'exponential', delay: 5000 },
    });
    expect(retry.opts.jobId).toMatch(/^failed-1-retry-\d+$/);
  });

  it('counts up from the retry count already on the job', async () => {
    bull.state.counts = { waiting: 0, active: 0, failed: 1 };
    bull.state.failedJobs = [
      makeFailedJob({ data: { jobType: 'data_backlog_sync', retryCount: 2 } }),
    ];

    await checkAndRetryFailedJobs();

    expect(bull.state.added[0].data.retryCount).toBe(3);
  });

  it('gives up on a job that has already been retried three times', async () => {
    const failed = makeFailedJob({ data: { jobType: 'data_backlog_sync', retryCount: 3 } });
    bull.state.counts = { waiting: 0, active: 0, failed: 1 };
    bull.state.failedJobs = [failed];

    await checkAndRetryFailedJobs();

    expect(bull.state.added).toEqual([]);
    expect(failed.removed).toBe(false);
  });

  it.each([
    ['board_validation', 'board_validation'],
    ['data_backlog_sync', 'backlog_sync'],
    ['manual_triggered_sync', 'manual_sync'],
    ['scheduled_sync', 'scheduled_sync'],
  ])('maps the %s job type to the %s queue name', async (jobType, expectedName) => {
    bull.state.counts = { waiting: 0, active: 0, failed: 1 };
    bull.state.failedJobs = [makeFailedJob({ name: 'whatever', data: { jobType } })];

    await checkAndRetryFailedJobs();

    expect(bull.state.added[0].name).toBe(expectedName);
  });

  it('falls back to the original job name for an unrecognised job type', async () => {
    bull.state.counts = { waiting: 0, active: 0, failed: 1 };
    bull.state.failedJobs = [
      makeFailedJob({ name: 'some-custom-name', data: { jobType: 'something-else' } }),
    ];

    await checkAndRetryFailedJobs();

    expect(bull.state.added[0].name).toBe('some-custom-name');
  });

  it('retries the healthy jobs even when one of them cannot be removed', async () => {
    const broken = makeFailedJob({ id: 'broken', data: { jobType: 'data_backlog_sync' } });
    broken.remove = async () => {
      throw new Error('redis unavailable');
    };
    const healthy = makeFailedJob({ id: 'healthy', data: { jobType: 'board_validation' } });
    bull.state.counts = { waiting: 0, active: 0, failed: 2 };
    bull.state.failedJobs = [broken, healthy];

    await checkAndRetryFailedJobs();

    expect(bull.state.added).toHaveLength(1);
    expect(bull.state.added[0].name).toBe('board_validation');
    expect(healthy.removed).toBe(true);
  });
});
