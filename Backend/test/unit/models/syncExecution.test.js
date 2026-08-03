import { describe, it, expect } from 'vitest';
import SyncExecution from '../../../src/models/SyncExecution.js';

describe('SyncExecution model', () => {
  it('requires syncGUID, boardId, workspaceId and syncType', async () => {
    await expect(SyncExecution.create({})).rejects.toThrow();
  });

  it('creates with default status started', async () => {
    const row = await SyncExecution.create({
      syncGUID: 'guid-1',
      boardId: 'b1',
      workspaceId: 'ws',
      syncType: 'data_backlog_sync',
    });
    expect(row.status).toBe('started');
    expect(row.triggeredBy).toBe('system');
  });

  it('rejects invalid enums', async () => {
    await expect(
      SyncExecution.create({
        syncGUID: 'guid-2',
        boardId: 'b1',
        workspaceId: 'ws',
        syncType: 'nope',
      })
    ).rejects.toThrow();
  });
});
