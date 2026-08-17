import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { triggerManualSync } from '../../../src/services/sync.js';
import { isOfflineMode } from '../../../src/services/offlineIsoplus.js';
import { registerSchedulerHandlers } from '../../../src/services/scheduler/handlers.js';
import { resolve, clearRegistry } from '../../../src/services/scheduler/registry.js';
import { AT_LEAST_ONCE } from '../../../src/constants/scheduler.js';
import { KIND_INVOICE, KIND_STATEMENT } from '../../../src/constants/automation.js';
import AutomationSettings from '../../../src/models/AutomationSettings.js';
import Board from '../../../src/models/Board.js';

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

// The kill switch for the whole automation pipeline.
//
// Without it, the day this branch merges any customer who ticks the Finance
// Settings toggle starts generating real PDFs, consuming real invoice numbers
// and writing real S3 objects for mail that cannot be sent — SES delivery is
// still Epic 5 part 4. The gate sits on the scheduler handler rather than the
// worker because that is the earliest honest point: nothing is enqueued at all,
// so nothing is generated, nothing is delivered, and no job record is created
// whose retained jobId would later dedupe the first real run away.
describe('AUTOMATION_ENABLED gate', () => {
  const SLOT = new Date('2026-08-11T23:00:00Z');
  const savedFlag = process.env.AUTOMATION_ENABLED;

  async function seedEnabledWorkspace() {
    await AutomationSettings.create({
      workspaceId: 'ws-gate',
      invoice: { enabled: true },
      statement: { enabled: true },
    });
    await Board.create({ workspaceId: 'ws-gate', boardId: 'b-gate', name: 'Gate Board' });
  }

  function dispatch(kind) {
    registerSchedulerHandlers();
    return resolve(kind).handler({
      targetId: 'ws-gate',
      workspaceId: 'ws-gate',
      timezone: 'Australia/Sydney',
      scheduledFor: SLOT,
    });
  }

  beforeEach(async () => {
    clearRegistry();
    vi.clearAllMocks();
    isOfflineMode.mockReturnValue(false);
    delete process.env.AUTOMATION_ENABLED;
    await Promise.all([
      AutomationSettings.deleteMany({ workspaceId: 'ws-gate' }),
      Board.deleteMany({ workspaceId: 'ws-gate' }),
    ]);
  });

  afterEach(async () => {
    if (savedFlag === undefined) {
      delete process.env.AUTOMATION_ENABLED;
    } else {
      process.env.AUTOMATION_ENABLED = savedFlag;
    }
    await Promise.all([
      AutomationSettings.deleteMany({ workspaceId: 'ws-gate' }),
      Board.deleteMany({ workspaceId: 'ws-gate' }),
    ]);
  });

  it('defaults OFF: an absent flag enqueues nothing even with settings enabled', async () => {
    await seedEnabledWorkspace();

    await expect(dispatch(KIND_INVOICE)).resolves.toBeUndefined();

    expect(globalThis.__BULLMQ_BULK_JOBS__).toHaveLength(0);
  });

  it('says so at warn rather than skipping silently', async () => {
    await seedEnabledWorkspace();

    await dispatch(KIND_STATEMENT);

    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(/disabled/i),
      expect.objectContaining({ kind: KIND_STATEMENT, targetId: 'ws-gate' }),
    );
  });

  it.each(['false', '0', 'no', 'off', '', 'yes-please'])(
    'treats %j as off — only a clear truthy value opens the gate',
    async (value) => {
      process.env.AUTOMATION_ENABLED = value;
      await seedEnabledWorkspace();

      await dispatch(KIND_INVOICE);

      expect(globalThis.__BULLMQ_BULK_JOBS__).toHaveLength(0);
    },
  );

  it.each(['true', '1', 'TRUE'])('fans out when the flag is %j', async (value) => {
    process.env.AUTOMATION_ENABLED = value;
    await seedEnabledWorkspace();

    await dispatch(KIND_INVOICE);

    expect(globalThis.__BULLMQ_BULK_JOBS__).toHaveLength(1);
    expect(globalThis.__BULLMQ_BULK_JOBS__[0].data).toMatchObject({
      kind: KIND_INVOICE, workspaceId: 'ws-gate', boardId: 'b-gate',
    });
  });
});
