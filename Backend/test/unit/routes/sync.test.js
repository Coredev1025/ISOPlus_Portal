import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app.js';
import { authenticatedAgent } from '../../helpers/auth.js';
import Board from '../../../src/models/Board.js';
import SyncExecution from '../../../src/models/SyncExecution.js';

/**
 * src/routes/sync.js drives src/services/sync.js. These tests go through the
 * real app with a real (in-memory) Mongo, so every assertion is about the
 * documents the service actually writes and the status code the router picks —
 * not about the BullMQ mock. Where a value can only come from the queue stub
 * (job ids) it is deliberately not asserted.
 *
 * Note on roles: POST /api/auth/login signs every credentials session with
 * role: 'support_admin' regardless of the stored user's role
 * (src/routes/auth.js), so an isoplus_user 403 cannot be reached this way.
 * Every route here is behind authenticateToken only, with no further role gate.
 */

const app = createApp();

/** Unique ids per test keep the 5-minute board-rule and ISO+ response caches out of the way. */
let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

describe('sync routes require authentication', () => {
  const posts = [
    '/api/sync/board/enable',
    '/api/sync/board/disable',
    '/api/sync/board/manual',
    '/api/sync/board/retry',
    '/api/sync/board/cancel',
    '/api/sync/workspace/enable',
  ];

  it.each(posts)('rejects an unauthenticated POST %s with 401', async (path) => {
    const res = await request(app).post(path).send({ workspaceId: 'w1', boardId: 'b1' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Authentication required' });
  });

  it.each([
    '/api/sync/board/status/b1',
    '/api/sync/workspace/status/w1',
    '/api/sync/queue/analysis',
  ])('rejects an unauthenticated GET %s with 401', async (path) => {
    const res = await request(app).get(path);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Authentication required' });
  });
});

describe('POST /api/sync/board/enable', () => {
  it('rejects a body with no ids and echoes back what it received', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent.post('/api/sync/board/enable').send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      message: 'workspaceId and boardId are required and must be valid non-empty strings',
      received: { workspaceId: null, boardId: null },
    });
  });

  it('rejects a boardId containing a path traversal character', async () => {
    // sanitizeApiPathSegment refuses '.', '/', '\\' and '%'.
    const { agent } = await authenticatedAgent(app);

    const res = await agent
      .post('/api/sync/board/enable')
      .send({ workspaceId: 'w1', boardId: '../etc/passwd' });

    expect(res.status).toBe(400);
    expect(res.body.received).toEqual({ workspaceId: 'w1', boardId: '../etc/passwd' });
  });

  it('upserts the board, records the ISO+ hook and answers 202', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    const workspaceId = nextId('ws');

    const res = await agent.post('/api/sync/board/enable').send({ workspaceId, boardId });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('Sync enabled. Board validation in progress.');
    expect(res.body.syncStatus).toBe('sync_enabled');

    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.workspaceId).toBe(workspaceId);
    expect(stored.syncData).toBe(true);
    expect(stored.syncStatus).toBe('sync_enabled');
    // Values come from the MSW ISO+ hook stub in test/msw/handlers.js.
    expect(stored.hookId).toBe('hook_test_1');
    expect(stored.hookSecret).toBe('secret_test');
  });

  it('answers 409 without re-queueing when sync is already enabled', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Test Board', workspaceId: 'w1', syncStatus: 'realtime_sync', syncData: true });

    const res = await agent
      .post('/api/sync/board/enable')
      .send({ workspaceId: 'w1', boardId });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      success: false,
      message: 'Sync already enabled for this board (current status: realtime_sync)',
      boardId,
      syncStatus: 'realtime_sync',
    });
  });

  it('treats a disabled board as re-enableable', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Test Board', workspaceId: 'w1', syncStatus: 'disabled' });

    const res = await agent
      .post('/api/sync/board/enable')
      .send({ workspaceId: 'w1', boardId });

    expect(res.status).toBe(202);
  });
});

describe('POST /api/sync/board/disable', () => {
  it('rejects a missing boardId', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent.post('/api/sync/board/disable').send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      message: 'boardId is required and must be a valid non-empty string',
    });
  });

  it('answers 500, not 404, for a board that does not exist', async () => {
    // disableBoardSync throws 'Board not found' but this route has no
    // not-found branch, unlike /board/manual. Documents current behaviour.
    const { agent } = await authenticatedAgent(app);

    const res = await agent
      .post('/api/sync/board/disable')
      .send({ boardId: nextId('missing') });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: 'Failed to disable sync', error: 'Board not found' });
  });

  it('clears the sync flags and the stored hook', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    await Board.create({
      boardId,
      name: 'Test Board',
      workspaceId: 'w1',
      syncData: true,
      syncStatus: 'realtime_sync',
      hookId: 'hook_test_1',
      hookSecret: 'secret_test',
    });

    const res = await agent.post('/api/sync/board/disable').send({ boardId });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Sync disabled successfully',
      boardId,
    });

    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.syncData).toBe(false);
    expect(stored.syncStatus).toBe('sync_stopped');
    expect(stored.hookId).toBeNull();
    expect(stored.hookSecret).toBeNull();
  });
});

describe('POST /api/sync/board/manual', () => {
  it('rejects the literal strings "undefined" and "null"', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent
      .post('/api/sync/board/manual')
      .send({ workspaceId: 'undefined', boardId: 'null' });

    expect(res.status).toBe(400);
    expect(res.body.received).toEqual({ workspaceId: 'undefined', boardId: 'null' });
  });

  it('rejects a whitespace-only boardId', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent
      .post('/api/sync/board/manual')
      .send({ workspaceId: 'w1', boardId: '   ' });

    expect(res.status).toBe(400);
  });

  it('answers 404 when the board does not exist anywhere', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('missing');

    const res = await agent
      .post('/api/sync/board/manual')
      .send({ workspaceId: 'w1', boardId });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      message: 'Board not found',
      error: `Board not found: ${boardId}`,
    });
  });

  it('names the other workspace when the board exists but is in a different one', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Test Board', workspaceId: 'other-ws', syncData: true });

    const res = await agent
      .post('/api/sync/board/manual')
      .send({ workspaceId: 'w1', boardId });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe(
      `Board not found in workspace w1. Board exists in workspace other-ws`
    );
  });

  it('answers 409 when sync has not been enabled for the board', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Test Board', workspaceId: 'w1', syncData: false });

    const res = await agent
      .post('/api/sync/board/manual')
      .send({ workspaceId: 'w1', boardId });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      success: false,
      message: 'Sync is not enabled for this board',
      boardId,
    });
  });

  it('answers 409 when a sync execution for the board is still running', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Test Board', workspaceId: 'w1', syncData: true, syncStatus: 'realtime_sync' });
    await SyncExecution.create({
      syncGUID: nextId('guid'),
      boardId,
      workspaceId: 'w1',
      syncType: 'manual_triggered_sync',
      status: 'in-progress',
      startTime: new Date(),
    });

    const res = await agent
      .post('/api/sync/board/manual')
      .send({ workspaceId: 'w1', boardId });

    expect(res.status).toBe(409);
    expect(res.body.alreadyRunning).toBe(true);
    expect(res.body.message).toBe(
      'A manual sync is already running for this board. Please wait for it to complete.'
    );
  });

  it('queues the sync and moves the board to manual_triggered_sync', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    await Board.create({
      boardId,
      name: 'Test Board',
      workspaceId: 'w1',
      syncData: true,
      syncStatus: 'realtime_sync',
      lastSyncError: 'previous failure',
    });

    const res = await agent
      .post('/api/sync/board/manual')
      .send({ workspaceId: 'w1', boardId: ` ${boardId} ` });

    expect(res.status).toBe(202);
    expect(res.body.message).toBe('Manual sync triggered successfully');

    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.syncStatus).toBe('manual_triggered_sync');
    expect(stored.lastSyncError).toBeNull();
  });

  it('times out a stale running execution instead of blocking the new sync', async () => {
    // SyncExecution.hasRunningSync auto-times-out anything started more than
    // 20 minutes ago before deciding.
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    const syncGUID = nextId('guid');
    await Board.create({ boardId, name: 'Test Board', workspaceId: 'w1', syncData: true, syncStatus: 'realtime_sync' });
    await SyncExecution.create({
      syncGUID,
      boardId,
      workspaceId: 'w1',
      syncType: 'data_backlog_sync',
      status: 'in-progress',
      startTime: new Date(Date.now() - 21 * 60 * 1000),
    });

    const res = await agent
      .post('/api/sync/board/manual')
      .send({ workspaceId: 'w1', boardId });

    expect(res.status).toBe(202);
    const stale = await SyncExecution.findOne({ syncGUID }).lean();
    expect(stale.status).toBe('timeout');
  });
});

describe('POST /api/sync/board/retry', () => {
  it('rejects missing ids', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent.post('/api/sync/board/retry').send({ workspaceId: 'w1' });

    expect(res.status).toBe(400);
    expect(res.body.received).toEqual({ workspaceId: 'w1', boardId: null });
  });

  it('answers 404 for an unknown board', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent
      .post('/api/sync/board/retry')
      .send({ workspaceId: 'w1', boardId: nextId('missing') });

    expect(res.status).toBe(404);
  });

  it('refuses to retry a board whose sync is not enabled', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Test Board', workspaceId: 'w1', syncData: false, syncStatus: 'failed' });

    const res = await agent
      .post('/api/sync/board/retry')
      .send({ workspaceId: 'w1', boardId });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      success: false,
      message: 'Sync is not enabled for this board. Enable sync first.',
      boardId,
    });
  });

  it('refuses to retry from a status that is already running', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Test Board', workspaceId: 'w1', syncData: true, syncStatus: 'realtime_sync' });

    const res = await agent
      .post('/api/sync/board/retry')
      .send({ workspaceId: 'w1', boardId });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Cannot retry from current status: realtime_sync');
  });

  it('re-validates a failed board and counts the retry', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    await Board.create({
      boardId,
      name: 'Test Board',
      workspaceId: 'w1',
      syncData: true,
      syncStatus: 'failed',
      lastSyncError: 'boom',
      validationErrors: ['Missing required folder: Jobs'],
      syncStats: { retryCount: 2 },
    });

    const res = await agent
      .post('/api/sync/board/retry')
      .send({ workspaceId: 'w1', boardId });

    expect(res.status).toBe(202);
    expect(res.body.message).toBe('Retrying board validation');
    expect(res.body.retryCount).toBe(3);

    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.syncStatus).toBe('sync_enabled');
    expect(stored.lastSyncError).toBeNull();
    expect(stored.validationErrors).toEqual([]);
    expect(stored.syncStats.retryCount).toBe(3);
  });

  it('restarts a cancelled board from validation', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Test Board', workspaceId: 'w1', syncData: true, syncStatus: 'sync_cancelled' });

    const res = await agent
      .post('/api/sync/board/retry')
      .send({ workspaceId: 'w1', boardId });

    expect(res.status).toBe(202);
    expect(res.body.message).toBe('Restarting sync from validation');
    expect(res.body.retryCount).toBe(1);
  });
});

describe('POST /api/sync/board/cancel', () => {
  it('rejects a missing boardId', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent.post('/api/sync/board/cancel').send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'boardId is required' });
  });

  it('answers 500 for an unknown board', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent
      .post('/api/sync/board/cancel')
      .send({ boardId: nextId('missing') });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: 'Failed to cancel sync', error: 'Board not found' });
  });

  it('records the cancellation reason on the board', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    await Board.create({
      boardId,
      name: 'Test Board',
      workspaceId: 'w1',
      syncData: true,
      syncStatus: 'data_backlog_sync',
      hookId: 'hook_test_1',
    });

    const res = await agent.post('/api/sync/board/cancel').send({ boardId });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Sync cancelled successfully',
      boardId,
      syncStatus: 'sync_cancelled',
    });

    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.syncStatus).toBe('sync_cancelled');
    expect(stored.lastSyncError).toBe('Sync cancelled by user');
    expect(stored.hookId).toBeNull();
    // syncData is deliberately left untouched by cancel, unlike disable.
    expect(stored.syncData).toBe(true);
  });
});

describe('POST /api/sync/workspace/enable', () => {
  it('rejects a missing workspaceId', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent.post('/api/sync/workspace/enable').send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'workspaceId is required' });
  });

  it('answers 202 with a zero count when no board is in an enableable state', async () => {
    const { agent } = await authenticatedAgent(app);
    await Board.create({
      boardId: nextId('board'),
      name: 'Test Board',
      workspaceId: 'w1',
      syncStatus: 'realtime_sync',
    });

    const res = await agent.post('/api/sync/workspace/enable').send({ workspaceId: 'w1' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      success: true,
      message: 'No boards available to sync',
      enabledBoards: 0,
      boards: [],
    });
  });

  it('enables every eligible board and reports the counts', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    await Board.create({ boardId, workspaceId: 'w1', name: 'Jobs', syncStatus: 'sync_stopped' });

    const res = await agent.post('/api/sync/workspace/enable').send({ workspaceId: 'w1' });

    expect(res.status).toBe(202);
    expect(res.body.enabledBoards).toBe(1);
    expect(res.body.totalBoards).toBe(1);
    expect(res.body.boards[0]).toMatchObject({ boardId, boardName: 'Jobs', enabled: true });

    const stored = await Board.findOne({ boardId }).lean();
    expect(stored.syncStatus).toBe('sync_enabled');
  });

  it('also enables boards belonging to other workspaces and re-homes them', async () => {
    // enableWorkspaceSync queries Board by syncStatus only — workspaceId is
    // never part of the filter — and enableBoardSync then $sets workspaceId to
    // the requested one. Reported as a bug; pinned here as current behaviour.
    const { agent } = await authenticatedAgent(app);
    const foreignBoardId = nextId('board');
    await Board.create({
      boardId: foreignBoardId,
      name: 'Test Board',
      workspaceId: 'someone-elses-workspace',
      syncStatus: 'sync_stopped',
    });

    const res = await agent.post('/api/sync/workspace/enable').send({ workspaceId: 'w1' });

    expect(res.status).toBe(202);
    expect(res.body.boards.map((b) => b.boardId)).toContain(foreignBoardId);

    const stored = await Board.findOne({ boardId: foreignBoardId }).lean();
    expect(stored.workspaceId).toBe('w1');
  });
});

describe('GET /api/sync/board/status/:boardId', () => {
  it('answers 404 for an unknown board', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent.get(`/api/sync/board/status/${nextId('missing')}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Board not found' });
  });

  it('returns the stored sync state', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    await Board.create({
      boardId,
      workspaceId: 'w1',
      name: 'Jobs',
      syncData: true,
      syncStatus: 'realtime_sync',
      lastSyncError: null,
      validationErrors: [],
      syncStats: { itemsSynced: 7, retryCount: 0 },
    });

    const res = await agent.get(`/api/sync/board/status/${boardId}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      boardId,
      boardName: 'Jobs',
      syncData: true,
      syncStatus: 'realtime_sync',
      validationErrors: [],
    });
    expect(res.body.syncStats.itemsSynced).toBe(7);
    expect(res.body.jobStatus).toBeNull();
    expect(res.body.syncExecution).toBeNull();
  });

  it('includes the in-flight sync execution when the board points at one', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    const syncGUID = nextId('guid');
    await Board.create({
      boardId,
      name: 'Test Board',
      workspaceId: 'w1',
      syncData: true,
      syncStatus: 'data_backlog_sync',
      currentSyncGUID: syncGUID,
    });
    await SyncExecution.create({
      syncGUID,
      boardId,
      workspaceId: 'w1',
      syncType: 'data_backlog_sync',
      status: 'in-progress',
    });

    const res = await agent.get(`/api/sync/board/status/${boardId}`);

    expect(res.status).toBe(200);
    expect(res.body.syncExecution.syncGUID).toBe(syncGUID);
    expect(res.body.syncExecution.status).toBe('in-progress');
  });
});

describe('GET /api/sync/workspace/status/:workspaceId', () => {
  it('reports only the boards in that workspace that have syncData set', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const syncing = nextId('board');
    await Board.create({ boardId: syncing, workspaceId, name: 'Jobs', syncData: true, syncStatus: 'realtime_sync' });
    await Board.create({ boardId: nextId('board'), name: 'Test Board', workspaceId, syncData: false });
    await Board.create({ boardId: nextId('board'), name: 'Test Board', workspaceId: nextId('other'), syncData: true });

    const res = await agent.get(`/api/sync/workspace/status/${workspaceId}`);

    expect(res.status).toBe(200);
    expect(res.body.workspaceId).toBe(workspaceId);
    expect(res.body.totalBoards).toBe(1);
    expect(res.body.boards).toHaveLength(1);
    expect(res.body.boards[0].boardId).toBe(syncing);
  });

  it('returns an empty board list for a workspace with nothing syncing', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent.get(`/api/sync/workspace/status/${nextId('ws')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalBoards).toBe(0);
    expect(res.body.boards).toEqual([]);
  });
});
