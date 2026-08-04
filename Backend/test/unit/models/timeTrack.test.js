import { describe, it, expect } from 'vitest';
import TimeTrack from '../../../src/models/TimeTrack.js';

describe('TimeTrack model', () => {
  it('requires workspaceId, boardId, itemId, Task and User', async () => {
    await expect(TimeTrack.create({})).rejects.toThrow();
  });

  it('creates with defaults', async () => {
    const row = await TimeTrack.create({
      workspaceId: 'ws',
      boardId: 'b',
      itemId: 'i',
      Task: 'Visit',
      User: 'u@x.com',
    });
    expect(row.source).toBe('portal');
    expect(row.isoPlusSynced).toBe(false);
  });
});
