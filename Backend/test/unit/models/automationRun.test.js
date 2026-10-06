import { describe, it, expect } from 'vitest';

import AutomationRun from '../../../src/models/AutomationRun.js';
import {
  RUN_QUEUED,
  RUN_SKIPPED,
  TRIGGER_SCHEDULE,
  SKIP_SETTINGS_DISABLED,
} from '../../../src/constants/systemHealth.js';

const base = {
  workspaceId: 'ws-1',
  boardId: 'board-a',
  kind: 'invoice_automation',
  periodKey: '20260116-0900',
  jobId: 'inv:board-a:20260116-0900',
};

describe('AutomationRun', () => {
  it('defaults a new row to queued, scheduled, with no outcome yet', async () => {
    const run = await AutomationRun.create(base);

    expect(run.status).toBe(RUN_QUEUED);
    expect(run.trigger).toBe(TRIGGER_SCHEDULE);
    // Null, not 0: a skipped or queued run that rendered "0ms" would read as
    // an instant success.
    expect(run.durationMs).toBeNull();
    expect(run.finishedAt).toBeNull();
    expect(run.recipient).toBeNull();
    expect(run.startedAt).toBeInstanceOf(Date);
  });

  it('rejects a status outside the enum', async () => {
    await expect(AutomationRun.create({ ...base, status: 'nearly' })).rejects.toThrow(/status/);
  });

  it('rejects a trigger outside the enum', async () => {
    await expect(AutomationRun.create({ ...base, trigger: 'cron' })).rejects.toThrow(/trigger/);
  });

  it('requires the fields every query filters on', async () => {
    for (const field of ['workspaceId', 'boardId', 'kind', 'periodKey', 'jobId']) {
      const missing = { ...base };
      delete missing[field];
      await expect(AutomationRun.create(missing)).rejects.toThrow(new RegExp(field));
    }
  });

  it('refuses a second row for the same jobId', async () => {
    await AutomationRun.create(base);
    await AutomationRun.init(); // ensure the unique index is built before asserting on it
    await expect(AutomationRun.create(base)).rejects.toThrow(/E11000|duplicate/i);
  });

  it('carries a skip reason', async () => {
    const run = await AutomationRun.create({
      ...base,
      status: RUN_SKIPPED,
      skipReason: SKIP_SETTINGS_DISABLED,
    });
    expect(run.skipReason).toBe(SKIP_SETTINGS_DISABLED);
  });

  it('declares a bare startedAt index, so the overview query is not a collection scan', () => {
    // The overview's `AutomationRun.find({ startedAt: { $gte: from } })` has no
    // status predicate, so neither compound index below can serve it.
    const indexSpecs = AutomationRun.schema.indexes().map(([spec]) => spec);
    expect(indexSpecs).toContainEqual({ startedAt: -1 });
    expect(indexSpecs).toContainEqual({ workspaceId: 1, startedAt: -1 });
    expect(indexSpecs).toContainEqual({ status: 1, startedAt: -1 });
  });
});
