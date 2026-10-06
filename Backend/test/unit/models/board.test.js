import { describe, it, expect } from 'vitest';
import Board from '../../../src/models/Board.js';

describe('Board model', () => {
  it('requires boardId and name', async () => {
    await expect(Board.create({})).rejects.toThrow();
  });

  it('creates a board with defaults', async () => {
    const board = await Board.create({ boardId: 'b-001', name: 'Operations' });
    expect(board.boardId).toBe('b-001');
    expect(board.label).toBe('No Label');
    expect(board.syncData).toBe(false);
    expect(board.syncStatus).toBe('disabled');
    expect(board.syncStats.foldersProcessed).toBe(0);
    expect(board.validationErrors).toEqual([]);
  });

  it('rejects an invalid syncStatus enum value', async () => {
    await expect(
      Board.create({ boardId: 'b-002', name: 'Bad', syncStatus: 'not-a-real-status' })
    ).rejects.toThrow();
  });

  it('accepts every valid syncStatus enum value', async () => {
    const validStatuses = [
      'disabled', 'sync_enabled', 'board_validation', 'board_valid', 'board_invalid',
      'data_backlog_sync', 'realtime_sync', 'manual_triggered_sync', 'scheduled_sync', 'sync_stopped',
      'sync_cancelled', 'failed',
    ];
    for (const status of validStatuses) {
      const board = await Board.create({ boardId: `b-${status}`, name: status, syncStatus: status });
      expect(board.syncStatus).toBe(status);
    }
  });
});
