import { describe, it, expect, vi, beforeEach } from 'vitest';

// The sync service talks to BullMQ/Redis and registers ISO+ webhooks; that is the
// external edge. Board and AuditTrail stay real against the in-memory Mongo.
vi.mock('../../../src/services/sync.js', () => ({
  enableBoardSync: vi.fn(),
  disableBoardSync: vi.fn(),
}));

import { enableBoardSync, disableBoardSync } from '../../../src/services/sync.js';
import Board from '../../../src/models/Board.js';
import AuditTrail from '../../../src/models/AuditTrail.js';
import {
  handleBoardSyncEnable,
  handleBoardSyncDisable,
  revertBoardSyncFlag,
  parseSyncToggle,
} from '../../../src/utils/boardSyncActions.js';

/** Minimal request as the board route sees it after authenticateToken. */
function fakeReq() {
  return {
    session: { Authorization: 'Bearer isoplus-token' },
    user: { email: 'ops@hillsgrade.example', id: 'usr_1', role: 'support_admin' },
    method: 'PUT',
    originalUrl: '/api/board',
    headers: {},
    ip: '10.0.0.4',
  };
}

describe('parseSyncToggle', () => {
  it('reads the previous state off the stored board', () => {
    expect(parseSyncToggle({}, { syncData: true }).wasSyncEnabled).toBe(true);
    expect(parseSyncToggle({}, { syncData: false }).wasSyncEnabled).toBe(false);
  });

  it('treats an absent board or absent syncData as previously disabled', () => {
    expect(parseSyncToggle({}, null).wasSyncEnabled).toBe(false);
    expect(parseSyncToggle({}, undefined).wasSyncEnabled).toBe(false);
    expect(parseSyncToggle({}, {}).wasSyncEnabled).toBe(false);
  });

  it('accepts boolean true and the string "true" from the request body', () => {
    expect(parseSyncToggle({ syncData: true }, null).willSyncBeEnabled).toBe(true);
    expect(parseSyncToggle({ syncData: 'true' }, null).willSyncBeEnabled).toBe(true);
  });

  it('rejects other truthy values and a missing syncData', () => {
    expect(parseSyncToggle({ syncData: 'TRUE' }, null).willSyncBeEnabled).toBe(false);
    expect(parseSyncToggle({ syncData: 1 }, null).willSyncBeEnabled).toBe(false);
    expect(parseSyncToggle({ syncData: 'false' }, null).willSyncBeEnabled).toBe(false);
    expect(parseSyncToggle({}, null).willSyncBeEnabled).toBe(false);
  });

  it('reports both halves of an enable transition', () => {
    expect(parseSyncToggle({ syncData: 'true' }, { syncData: false })).toEqual({
      wasSyncEnabled: false,
      willSyncBeEnabled: true,
    });
  });
});

describe('revertBoardSyncFlag', () => {
  it('clears syncData on the matching board only', async () => {
    await Board.create([
      { boardId: 'brd_100', name: 'Invoices', workspaceId: 'ws_1', syncData: true },
      { boardId: 'brd_200', name: 'Quotes', workspaceId: 'ws_1', syncData: true },
    ]);

    await revertBoardSyncFlag('brd_100');

    expect((await Board.findOne({ boardId: 'brd_100' }).lean()).syncData).toBe(false);
    expect((await Board.findOne({ boardId: 'brd_200' }).lean()).syncData).toBe(true);
  });

  it('coerces a numeric board id to a string before matching', async () => {
    await Board.create({ boardId: '4471', name: 'Timesheets', workspaceId: 'ws_1', syncData: true });

    await revertBoardSyncFlag(4471);

    expect((await Board.findOne({ boardId: '4471' }).lean()).syncData).toBe(false);
  });

  it('is a no-op when no board matches', async () => {
    await Board.create({ boardId: 'brd_100', name: 'Invoices', workspaceId: 'ws_1', syncData: true });

    await revertBoardSyncFlag('brd_999');

    expect((await Board.findOne({ boardId: 'brd_100' }).lean()).syncData).toBe(true);
    expect(await Board.countDocuments()).toBe(1);
  });
});

describe('handleBoardSyncEnable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queues the sync job with the session authorization and returns its result', async () => {
    const syncResult = {
      success: true,
      message: 'Board sync enabled and validation job queued',
      jobId: 'job_test_1',
      boardId: 'brd_100',
      syncStatus: 'sync_enabled',
    };
    enableBoardSync.mockResolvedValue(syncResult);

    const req = fakeReq();
    const result = await handleBoardSyncEnable({ req, workspaceId: 'ws_1', boardId: 'brd_100' });

    expect(enableBoardSync).toHaveBeenCalledWith('Bearer isoplus-token', 'ws_1', 'brd_100');
    expect(result).toEqual({ syncResult });
  });

  it('writes an audit trail entry naming the queued job on success', async () => {
    enableBoardSync.mockResolvedValue({ success: true, jobId: 'job_test_1' });

    await handleBoardSyncEnable({ req: fakeReq(), workspaceId: 'ws_1', boardId: 'brd_100' });

    const entries = await AuditTrail.find({}).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('Enabled Board Sync');
    expect(entries[0].detail).toBe(
      'Board sync enabled and validation job queued (Job ID: job_test_1)',
    );
    expect(entries[0].workspaceId).toBe('ws_1');
    expect(entries[0].boardId).toBe('brd_100');
    expect(entries[0].category).toBe('Sync');
    expect(entries[0].entityType).toBe('Board');
    expect(entries[0].entityId).toBe('brd_100');
    expect(entries[0].success).toBe(true);
  });

  it('records no audit trail entry when the queue rejects the job', async () => {
    const syncResult = {
      success: false,
      message: 'Sync already enabled for this board (current status: realtime_sync)',
      boardId: 'brd_100',
      syncStatus: 'realtime_sync',
    };
    enableBoardSync.mockResolvedValue(syncResult);

    const result = await handleBoardSyncEnable({ req: fakeReq(), workspaceId: 'ws_1', boardId: 'brd_100' });

    expect(result).toEqual({ syncResult });
    expect(await AuditTrail.countDocuments()).toBe(0);
  });

  it('lets a thrown sync error escape to the caller', async () => {
    enableBoardSync.mockRejectedValue(new Error('Redis connection refused'));

    await expect(
      handleBoardSyncEnable({ req: fakeReq(), workspaceId: 'ws_1', boardId: 'brd_100' }),
    ).rejects.toThrow('Redis connection refused');
    expect(await AuditTrail.countDocuments()).toBe(0);
  });
});

describe('handleBoardSyncDisable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables sync by board id alone and returns the service result', async () => {
    const syncResult = { success: true, message: 'Sync disabled', boardId: 'brd_100' };
    disableBoardSync.mockResolvedValue(syncResult);

    const result = await handleBoardSyncDisable({ req: fakeReq(), workspaceId: 'ws_1', boardId: 'brd_100' });

    expect(disableBoardSync).toHaveBeenCalledWith('brd_100');
    expect(result).toEqual({ syncResult });
  });

  it('writes an audit trail entry on success', async () => {
    disableBoardSync.mockResolvedValue({ success: true });

    await handleBoardSyncDisable({ req: fakeReq(), workspaceId: 'ws_1', boardId: 'brd_100' });

    const entries = await AuditTrail.find({}).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('Disabled Board Sync');
    expect(entries[0].detail).toBe('Board sync disabled and pending jobs cancelled');
    expect(entries[0].category).toBe('Sync');
    expect(entries[0].entityId).toBe('brd_100');
    expect(entries[0].success).toBe(true);
  });

  it('swallows a thrown sync error, returning it instead of rethrowing', async () => {
    const failure = new Error('Queue unavailable');
    disableBoardSync.mockRejectedValue(failure);

    const result = await handleBoardSyncDisable({ req: fakeReq(), workspaceId: 'ws_1', boardId: 'brd_100' });

    expect(result).toEqual({ syncResult: null, error: failure });
    expect(await AuditTrail.countDocuments()).toBe(0);
  });
});
