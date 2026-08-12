import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { triggerManualSync } from '../../../src/services/sync.js';
import { isOfflineMode } from '../../../src/services/offlineIsoplus.js';
import { registerSchedulerHandlers } from '../../../src/services/scheduler/handlers.js';
import { resolve, clearRegistry } from '../../../src/services/scheduler/registry.js';
import { AT_LEAST_ONCE } from '../../../src/constants/scheduler.js';

vi.mock('../../../src/services/sync.js', () => ({
  triggerManualSync: vi.fn(),
}));

vi.mock('../../../src/services/offlineIsoplus.js', () => ({
  isOfflineMode: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  default: {},
}));

const { warn } = await import('../../../src/utils/logger.js');

describe('registerSchedulerHandlers', () => {
  const originalToken = process.env.PERSONAL_ACCESS_TOKEN;

  beforeEach(() => {
    clearRegistry();
    process.env.PERSONAL_ACCESS_TOKEN = 'test-token';
    // Default to online so the pre-existing dispatch tests below are
    // unaffected by the offline guard; the offline-specific tests override
    // this explicitly.
    isOfflineMode.mockReturnValue(false);
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

  it('calls triggerManualSync with the scheduler authorization and job identifiers when online', async () => {
    isOfflineMode.mockReturnValue(false);
    triggerManualSync.mockResolvedValue({
      success: true,
      message: 'Manual sync triggered successfully',
      boardId: 'board-1',
      syncStatus: 'manual_triggered_sync',
      jobId: 'job-1',
    });
    registerSchedulerHandlers();
    const { handler } = resolve('board_sync');

    await handler({ targetId: 'board-1', workspaceId: 'ws-1' });

    expect(triggerManualSync).toHaveBeenCalledWith('Bearer test-token', 'ws-1', 'board-1');
  });

  it('skips the sync and warns, without throwing, when the backend is in offline mode', async () => {
    // A skip must be a success: the handler is AT_LEAST_ONCE, so the schedule
    // only advances after the handler resolves. If a skip threw, the same row
    // would be retried on every tick forever.
    isOfflineMode.mockReturnValue(true);
    registerSchedulerHandlers();
    const { handler } = resolve('board_sync');

    await expect(
      handler({ targetId: 'board-1', workspaceId: 'ws-1' }),
    ).resolves.not.toThrow();

    expect(triggerManualSync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(/offline/i),
      expect.objectContaining({ kind: 'board_sync', targetId: 'board-1' }),
    );
  });
});
