import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { triggerManualSync } from '../../../src/services/sync.js';
import { registerSchedulerHandlers } from '../../../src/services/scheduler/handlers.js';
import {
  resolve,
  clearRegistry,
  AT_LEAST_ONCE,
} from '../../../src/services/scheduler/registry.js';

vi.mock('../../../src/services/sync.js', () => ({
  triggerManualSync: vi.fn(),
}));

describe('registerSchedulerHandlers', () => {
  const originalToken = process.env.PERSONAL_ACCESS_TOKEN;

  beforeEach(() => {
    clearRegistry();
    process.env.PERSONAL_ACCESS_TOKEN = 'test-token';
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalToken === undefined) {
      delete process.env.PERSONAL_ACCESS_TOKEN;
    } else {
      process.env.PERSONAL_ACCESS_TOKEN = originalToken;
    }
  });

  it('registers board_sync under AT_LEAST_ONCE', () => {
    registerSchedulerHandlers();

    const entry = resolve('board_sync');
    expect(typeof entry.handler).toBe('function');
    expect(entry.policy).toBe(AT_LEAST_ONCE);
  });

  it('throws when the board has sync disabled, so the schedule does not silently go quiet forever', async () => {
    triggerManualSync.mockResolvedValue({
      success: false,
      message: 'Sync is not enabled for this board',
      boardId: 'board-1',
    });
    registerSchedulerHandlers();
    const { handler } = resolve('board_sync');

    await expect(
      handler({ targetId: 'board-1', workspaceId: 'ws-1' }),
    ).rejects.toThrow(/board-1/);
  });

  it('resolves without throwing when a sync is already running for the board', async () => {
    triggerManualSync.mockResolvedValue({
      success: false,
      alreadyRunning: true,
      message: 'A manual sync is already running for this board. Please wait for it to complete.',
      boardId: 'board-1',
      syncStatus: 'manual_triggered_sync',
    });
    registerSchedulerHandlers();
    const { handler } = resolve('board_sync');

    await expect(
      handler({ targetId: 'board-1', workspaceId: 'ws-1' }),
    ).resolves.not.toThrow();
  });

  it('resolves without throwing on a successful dispatch', async () => {
    triggerManualSync.mockResolvedValue({
      success: true,
      message: 'Manual sync triggered successfully',
      boardId: 'board-1',
      syncStatus: 'manual_triggered_sync',
      jobId: 'job-1',
    });
    registerSchedulerHandlers();
    const { handler } = resolve('board_sync');

    await expect(
      handler({ targetId: 'board-1', workspaceId: 'ws-1' }),
    ).resolves.not.toThrow();
  });
});
