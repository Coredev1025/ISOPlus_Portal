import { describe, it, expect, beforeEach } from 'vitest';

import AutomationRun from '../../../src/models/AutomationRun.js';
import {
  recordQueuedRuns,
  markRunSkipped,
  markRunSucceeded,
  markRunFailed,
} from '../../../src/services/automation/runs.js';
import {
  RUN_QUEUED,
  RUN_SKIPPED,
  RUN_SUCCEEDED,
  RUN_FAILED,
  TRIGGER_SCHEDULE,
  TRIGGER_MANUAL,
  SKIP_DELIVERY_NOT_IMPLEMENTED,
} from '../../../src/constants/systemHealth.js';

const spec = (boardId) => ({
  name: 'invoice_automation',
  data: {
    kind: 'invoice_automation',
    workspaceId: 'ws-1',
    boardId,
    periodKey: '20260116-0900',
  },
  opts: { jobId: `inv:${boardId}:20260116-0900` },
});

describe('recordQueuedRuns', () => {
  beforeEach(async () => {
    await AutomationRun.deleteMany({});
    await AutomationRun.init();
  });

  it('writes one queued row per spec', async () => {
    const written = await recordQueuedRuns({
      specs: [spec('board-a'), spec('board-b')],
      trigger: TRIGGER_SCHEDULE,
    });

    expect(written).toBe(2);
    const rows = await AutomationRun.find({}).sort({ boardId: 1 }).lean();
    expect(rows.map((r) => r.boardId)).toEqual(['board-a', 'board-b']);
    expect(rows[0].status).toBe(RUN_QUEUED);
    expect(rows[0].jobId).toBe('inv:board-a:20260116-0900');
  });

  it('is idempotent: a redispatch of the same slot does not duplicate rows', async () => {
    await recordQueuedRuns({ specs: [spec('board-a')], trigger: TRIGGER_SCHEDULE });
    await recordQueuedRuns({ specs: [spec('board-a')], trigger: TRIGGER_SCHEDULE });

    expect(await AutomationRun.countDocuments({})).toBe(1);
  });

  it('does not resurrect a finished run when the same slot is redispatched', async () => {
    await recordQueuedRuns({ specs: [spec('board-a')], trigger: TRIGGER_SCHEDULE });
    await markRunSucceeded({ jobId: 'inv:board-a:20260116-0900', recipient: 'a@b.com' });

    await recordQueuedRuns({ specs: [spec('board-a')], trigger: TRIGGER_SCHEDULE });

    const row = await AutomationRun.findOne({}).lean();
    expect(row.status).toBe(RUN_SUCCEEDED);
    expect(row.recipient).toBe('a@b.com');
  });

  it('records the trigger it was given', async () => {
    await recordQueuedRuns({ specs: [spec('board-a')], trigger: TRIGGER_MANUAL });
    const row = await AutomationRun.findOne({}).lean();
    expect(row.trigger).toBe(TRIGGER_MANUAL);
  });

  it('writes nothing, and does not throw, for an empty fan-out', async () => {
    expect(await recordQueuedRuns({ specs: [], trigger: TRIGGER_SCHEDULE })).toBe(0);
    expect(await AutomationRun.countDocuments({})).toBe(0);
  });
});

describe('closing a run', () => {
  beforeEach(async () => {
    await AutomationRun.deleteMany({});
    await recordQueuedRuns({ specs: [spec('board-a')], trigger: TRIGGER_SCHEDULE });
  });

  const jobId = 'inv:board-a:20260116-0900';

  it('marks skipped with a reason and no duration', async () => {
    await markRunSkipped({ jobId, skipReason: SKIP_DELIVERY_NOT_IMPLEMENTED });

    const row = await AutomationRun.findOne({ jobId }).lean();
    expect(row.status).toBe(RUN_SKIPPED);
    expect(row.skipReason).toBe(SKIP_DELIVERY_NOT_IMPLEMENTED);
    expect(row.finishedAt).toBeInstanceOf(Date);
    // Nothing ran, so there is no duration to report.
    expect(row.durationMs).toBeNull();
  });

  it('marks succeeded with a recipient and a measured duration', async () => {
    await markRunSucceeded({ jobId, recipient: 'billing@client.com' });

    const row = await AutomationRun.findOne({ jobId }).lean();
    expect(row.status).toBe(RUN_SUCCEEDED);
    expect(row.recipient).toBe('billing@client.com');
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(row.error).toBeNull();
  });

  it('marks failed with the error text', async () => {
    await markRunFailed({ jobId, error: 'Xero rejected the invoice' });

    const row = await AutomationRun.findOne({ jobId }).lean();
    expect(row.status).toBe(RUN_FAILED);
    expect(row.error).toBe('Xero rejected the invoice');
  });

  it('ignores a jobId that has no row rather than throwing', async () => {
    await expect(markRunSucceeded({ jobId: 'inv:ghost:1', recipient: null })).resolves.toBeUndefined();
  });
});
