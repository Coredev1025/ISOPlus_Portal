import { describe, it, expect, vi, beforeEach } from 'vitest';

const addBulk = vi.fn();
vi.mock('../../../src/services/automation/queue.js', () => ({
  AUTOMATION_QUEUE_NAME: 'automation',
  getAutomationQueue: () => ({ addBulk }),
}));

import Board from '../../../src/models/Board.js';
import AutomationSettings from '../../../src/models/AutomationSettings.js';
import ScheduledJob from '../../../src/models/ScheduledJob.js';
import {
  runAutomationKind,
  registerAutomationHandlers,
} from '../../../src/services/scheduler/handlers.js';
import { KIND_INVOICE, KIND_STATEMENT } from '../../../src/services/automation/fanOut.js';
import {
  resolve,
  clearRegistry,
  AT_LEAST_ONCE,
} from '../../../src/services/scheduler/registry.js';
import { runTick } from '../../../src/services/scheduler/tick.js';

const job = {
  targetId: 'ws-1',
  workspaceId: 'ws-1',
  timezone: 'Australia/Sydney',
  nextRunAt: new Date('2026-08-11T23:00:00Z'),
};

describe('runAutomationKind', () => {
  beforeEach(async () => {
    addBulk.mockReset();
    clearRegistry();
    await Board.deleteMany({});
    await AutomationSettings.deleteMany({});
  });

  it('enqueues one job per board', async () => {
    await Board.collection.insertMany([
      { boardId: 'b1', workspaceId: 'ws-1' },
      { boardId: 'b2', workspaceId: 'ws-1' },
    ]);
    await AutomationSettings.create({ workspaceId: 'ws-1', invoice: { enabled: true } });

    await runAutomationKind(KIND_INVOICE, job);

    expect(addBulk).toHaveBeenCalledTimes(1);
    expect(addBulk.mock.calls[0][0]).toHaveLength(2);
  });

  it('succeeds and enqueues nothing when the workspace has no boards', async () => {
    await AutomationSettings.create({ workspaceId: 'ws-1', invoice: { enabled: true } });
    await expect(runAutomationKind(KIND_INVOICE, job)).resolves.toBeUndefined();
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('no-ops without throwing when settings are missing', async () => {
    await Board.collection.insertOne({ boardId: 'b1', workspaceId: 'ws-1' });
    await expect(runAutomationKind(KIND_INVOICE, job)).resolves.toBeUndefined();
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('no-ops when the block is disabled', async () => {
    await Board.collection.insertOne({ boardId: 'b1', workspaceId: 'ws-1' });
    await AutomationSettings.create({ workspaceId: 'ws-1', invoice: { enabled: false } });
    await expect(runAutomationKind(KIND_INVOICE, job)).resolves.toBeUndefined();
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('produces identical jobIds when the same slot is dispatched twice', async () => {
    await Board.collection.insertOne({ boardId: 'b1', workspaceId: 'ws-1' });
    await AutomationSettings.create({ workspaceId: 'ws-1', invoice: { enabled: true } });

    await Promise.all([runAutomationKind(KIND_INVOICE, job), runAutomationKind(KIND_INVOICE, job)]);

    const [firstCall, secondCall] = addBulk.mock.calls;
    expect(secondCall[0][0].opts.jobId).toBe(firstCall[0][0].opts.jobId);
  });

  it('refuses to fan out without a slot rather than keying the period on the current time', async () => {
    // automationPeriodKey formats whatever it is given; Intl.formatToParts
    // (undefined) silently formats *now*, which would mint a fresh jobId on
    // every retry and duplicate-bill every board that already succeeded.
    await Board.collection.insertOne({ boardId: 'b1', workspaceId: 'ws-1' });
    await AutomationSettings.create({ workspaceId: 'ws-1', invoice: { enabled: true } });

    await expect(
      runAutomationKind(KIND_INVOICE, { ...job, nextRunAt: undefined }),
    ).rejects.toThrow(/slot/i);
    expect(addBulk).not.toHaveBeenCalled();
  });
});

describe('registerAutomationHandlers', () => {
  beforeEach(async () => {
    addBulk.mockReset();
    clearRegistry();
    await Board.deleteMany({});
    await AutomationSettings.deleteMany({});
    await ScheduledJob.deleteMany({});
  });

  it('registers both kinds under AT_LEAST_ONCE', () => {
    registerAutomationHandlers();

    for (const kind of [KIND_INVOICE, KIND_STATEMENT]) {
      const entry = resolve(kind);
      expect(typeof entry.handler).toBe('function');
      expect(entry.policy).toBe(AT_LEAST_ONCE);
    }
  });

  it('keys the fan-out on the slot the tick claimed, read in the schedule timezone', async () => {
    // The whole idempotency design rests on the period key coming from the
    // claimed slot and the job's own timezone. If the tick does not hand both
    // to the handler, the key falls back to the current time in the server's
    // zone and every retry re-bills.
    registerAutomationHandlers();
    await Board.collection.insertOne({ boardId: 'b1', workspaceId: 'ws-1' });
    await AutomationSettings.create({ workspaceId: 'ws-1', invoice: { enabled: true } });
    await ScheduledJob.create({
      kind: KIND_INVOICE,
      targetId: 'ws-1',
      workspaceId: 'ws-1',
      cron: null,
      schedule: {
        every: { n: 1, unit: 'month' },
        runOn: 11,
        runAt: '14:00',
        startDate: new Date('2026-08-11T00:00:00+10:00'),
      },
      timezone: 'Australia/Sydney',
      nextRunAt: new Date('2026-08-11T04:00:00Z'),
    });

    await runTick({ now: new Date('2026-08-11T04:05:00Z') });

    // 2026-08-11T04:00Z is 14:00 on the 11th in Sydney — not 04:00 (UTC) and
    // not 14:05 (now).
    expect(addBulk).toHaveBeenCalledTimes(1);
    expect(addBulk.mock.calls[0][0][0].opts.jobId).toBe('inv:b1:20260811-1400');
  });
});
