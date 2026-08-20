import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Board from '../../../src/models/Board.js';
import AutomationSettings from '../../../src/models/AutomationSettings.js';
import { registerSchedulerHandlers, runBoardSyncSweep } from '../../../src/services/scheduler/handlers.js';
import { resolve, clearRegistry } from '../../../src/services/scheduler/registry.js';
import { BOARD_SYNC_KIND } from '../../../src/constants/scheduler.js';
import { KIND_INVOICE, KIND_STATEMENT } from '../../../src/constants/automation.js';
import { SCHEDULED_SYNC_JOB_TYPE } from '../../../src/constants/sync.js';
import { recordedBulkJobs, resetRecordedJobs } from '../../helpers/queue.js';
import { isOfflineMode } from '../../../src/services/offlineIsoplus.js';

vi.mock('../../../src/services/offlineIsoplus.js', () => ({
  isOfflineMode: vi.fn(() => false),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  default: {},
}));

const { warn } = await import('../../../src/utils/logger.js');

describe('board_sync sweep handler', () => {
  const originalToken = process.env.PERSONAL_ACCESS_TOKEN;

  beforeEach(() => {
    clearRegistry();
    resetRecordedJobs();
    process.env.PERSONAL_ACCESS_TOKEN = 'test-token';
    // Default to online so the pre-existing dispatch tests below are
    // unaffected by the offline guard; the offline-specific tests override
    // this explicitly.
    isOfflineMode.mockReturnValue(false);
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.PERSONAL_ACCESS_TOKEN;
    else process.env.PERSONAL_ACCESS_TOKEN = originalToken;
  });

  it('does not register board_sync on the EventBridge tick registry', () => {
    registerSchedulerHandlers();
    expect(() => resolve(BOARD_SYNC_KIND)).toThrow(/not registered/);
  });

  it('enqueues one scheduled_sync job per sync-enabled board for the claimed slot', async () => {
    await Board.create([
      { boardId: 'on-1', name: 'A', workspaceId: 'ws-1', syncData: true, syncStatus: 'realtime_sync' },
      { boardId: 'off-1', name: 'B', workspaceId: 'ws-1', syncData: false },
      { boardId: 'on-2', name: 'C', workspaceId: 'ws-2', syncData: true, syncStatus: 'realtime_sync' },
    ]);
    const slot = new Date('2026-08-11T16:00:00Z');

    await runBoardSyncSweep({
      targetId: 'portal',
      workspaceId: null,
      scheduledFor: slot,
      timezone: 'Australia/Sydney',
    });

    const jobs = recordedBulkJobs().filter((j) => j.name === SCHEDULED_SYNC_JOB_TYPE);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.data.boardId).sort()).toEqual(['on-1', 'on-2']);
    expect(jobs[0].data.jobType).toBe(SCHEDULED_SYNC_JOB_TYPE);
    expect(jobs[0].data.authorization).toBe('Bearer test-token');

    const on1 = await Board.findOne({ boardId: 'on-1' }).lean();
    expect(on1.syncStatus).toBe(SCHEDULED_SYNC_JOB_TYPE);
    expect(on1.syncJobId).toBe(jobs.find((j) => j.data.boardId === 'on-1').opts.jobId);
  });

  it('stamps syncJobId for first-time boards without overwriting backlog status', async () => {
    await Board.create({
      boardId: 'backlog-1',
      name: 'D',
      workspaceId: 'ws-1',
      syncData: true,
      syncStatus: 'data_backlog_sync',
    });

    await runBoardSyncSweep({
      scheduledFor: new Date('2026-08-11T16:00:00Z'),
      timezone: 'Australia/Sydney',
    });

    const stored = await Board.findOne({ boardId: 'backlog-1' }).lean();
    expect(stored.syncStatus).toBe('data_backlog_sync');
    expect(stored.syncJobId).toMatch(/^sched:backlog-1:/);
  });

  it('resolves without enqueueing when no board has sync enabled', async () => {
    await Board.create({ boardId: 'off-1', name: 'B', workspaceId: 'ws-1', syncData: false });
    await runBoardSyncSweep({
      scheduledFor: new Date('2026-08-11T16:00:00Z'),
      timezone: 'Australia/Sydney',
    });
    expect(recordedBulkJobs()).toEqual([]);
  });

  it('skips without throwing in offline mode', async () => {
    isOfflineMode.mockReturnValue(true);
    await Board.create({ boardId: 'on-1', name: 'A', workspaceId: 'ws-1', syncData: true });
    await expect(runBoardSyncSweep({
      scheduledFor: new Date('2026-08-11T16:00:00Z'),
      timezone: 'Australia/Sydney',
    })).resolves.toBeUndefined();
    expect(recordedBulkJobs()).toEqual([]);
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
  });

  afterEach(async () => {
    if (savedFlag === undefined) {
      delete process.env.AUTOMATION_ENABLED;
    } else {
      process.env.AUTOMATION_ENABLED = savedFlag;
    }
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
