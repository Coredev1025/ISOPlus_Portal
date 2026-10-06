import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

import { createApp } from '../../src/app.js';
import AutomationSettings from '../../src/models/AutomationSettings.js';
import Board from '../../src/models/Board.js';
import Business from '../../src/models/Business.js';
import ScheduledJob from '../../src/models/ScheduledJob.js';
import { KIND_INVOICE, KIND_STATEMENT } from '../../src/constants/automation.js';
import { registerSchedulerHandlers } from '../../src/services/scheduler/handlers.js';
import { clearRegistry, resolve } from '../../src/services/scheduler/registry.js';
import { AT_LEAST_ONCE } from '../../src/constants/scheduler.js';
import { authenticatedAgent } from '../helpers/auth.js';
import {
  recordedBulkJobsOfKind,
  recordedJobIds,
  resetRecordedJobs,
} from '../helpers/queue.js';

/**
 * The product path, end to end across both HTTP boundaries: a client saves
 * automation settings, the scheduler ticks, and per-board jobs land on the
 * automation queue.
 *
 * The two existing integration suites each stop at one side of this. The
 * settings suite asserts the ScheduledJob row and goes no further; the
 * scheduler suite clears the registry and registers a fake handler, so the
 * real automation handlers are never reached through the route. Everything
 * between — handler registration at boot, the fan-out, and the idempotency
 * key that stands between a retry and a duplicate invoice — was only ever
 * exercised by unit tests calling the functions directly.
 */

const WS = 'ws-pipeline-1';
const BOARDS = ['board-a', 'board-b', 'board-c'];
const SCHEDULER_KEY = 'test-scheduler-key';

// A slot in the past, so the tick's real `new Date()` claims it. Fixed rather
// than relative because the period key is derived from this instant and the
// assertions below name the key literally.
const DUE = new Date('2026-01-15T22:00:00Z');

// DUE in Australia/Sydney, the timezone a Business with no headOfficeTimezone
// falls back to. January is AEDT (UTC+11), so 22:00Z is 09:00 the following
// day — which is why the key reads 16 January and not 15.
const DUE_PERIOD_KEY = '20260116-0900';

const MONTHLY_INVOICE = {
  enabled: true,
  every: { n: 1, unit: 'month' },
  runOn: 15,
  runAt: '09:00',
  sendMethod: 'isoplus',
  recipient: 'billing_contact',
};

const MONTHLY_STATEMENT = {
  enabled: true,
  every: { n: 1, unit: 'month' },
  runOn: 15,
  runAt: '09:00',
  sendMethod: 'isoplus',
  recipient: 'billing_contact',
};

describe('automation pipeline: settings → tick → queue', () => {
  const originalSchedulerApiKey = process.env.SCHEDULER_API_KEY;
  // AUTOMATION_ENABLED defaults OFF; this suite is about the pipeline running,
  // so it opens the gate. The gate itself: scheduler.handlers.test.js.
  const originalAutomationEnabled = process.env.AUTOMATION_ENABLED;
  let app;
  let agent;

  /** Backdate the saved schedule so the next tick claims it. */
  async function makeDue(kind) {
    await ScheduledJob.updateOne({ kind, targetId: WS }, { $set: { nextRunAt: DUE } });
  }

  async function tick() {
    return request(app).post('/api/scheduler/tick').set('Authorization', SCHEDULER_KEY);
  }

  beforeEach(async () => {
    resetRecordedJobs();

    process.env.SCHEDULER_API_KEY = SCHEDULER_KEY;
    process.env.AUTOMATION_ENABLED = 'true';
    // The settings route 403s without the per-workspace feature flag.
    await Business.create({
      workspaceId: WS,
      name: 'Pipeline Test Co',
      featureToggles: { invoiceStatementAutomation: true },
    });

    // The boot path itself, not registerAutomationHandlers directly. A
    // regression that drops automation from this function leaves schedules
    // firing into an unresolvable kind, and every test below would still pass
    // if they registered the handlers themselves.
    clearRegistry();
    registerSchedulerHandlers();

    await Board.collection.insertMany(
      BOARDS.map((boardId) => ({ boardId, workspaceId: WS, name: boardId })),
    );

    app = createApp();
    ({ agent } = await authenticatedAgent(app));
  });

  afterEach(() => {
    if (originalSchedulerApiKey === undefined) {
      delete process.env.SCHEDULER_API_KEY;
    } else {
      process.env.SCHEDULER_API_KEY = originalSchedulerApiKey;
    }
    if (originalAutomationEnabled === undefined) {
      delete process.env.AUTOMATION_ENABLED;
    } else {
      process.env.AUTOMATION_ENABLED = originalAutomationEnabled;
    }
    clearRegistry();
  });

  it('registers both automation kinds under at-least-once from the boot path', () => {
    expect(resolve(KIND_INVOICE).policy).toBe(AT_LEAST_ONCE);
    expect(resolve(KIND_STATEMENT).policy).toBe(AT_LEAST_ONCE);
  });

  it('fans out one job per board when a saved schedule comes due', async () => {
    const saved = await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE });
    expect(saved.status).toBe(200);

    await makeDue(KIND_INVOICE);

    const res = await tick();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ claimed: 1, dispatched: 1, failed: 0 });

    const enqueued = recordedBulkJobsOfKind(KIND_INVOICE);
    expect(enqueued).toHaveLength(BOARDS.length);
    expect(enqueued.map((job) => job.data.boardId).sort()).toEqual([...BOARDS].sort());

    for (const job of enqueued) {
      expect(job.data).toMatchObject({
        kind: KIND_INVOICE,
        workspaceId: WS,
        periodKey: DUE_PERIOD_KEY,
        timezone: 'Australia/Sydney',
        schedule: { every: { n: 1, unit: 'month' }, runOn: 15 },
      });
      expect(job.opts.jobId).toBe(`inv:${job.data.boardId}:${DUE_PERIOD_KEY}`);
    }
  });

  it('produces identical jobIds when the same slot is dispatched twice', async () => {
    await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE });

    await makeDue(KIND_INVOICE);
    await tick();
    const first = recordedJobIds().sort();

    // The crash-and-retry case. A successful at-least-once dispatch advanced
    // nextRunAt; rewinding it replays the same slot, which is what a tick
    // that died between enqueue and recordSuccess would do on its next run.
    resetRecordedJobs();
    await makeDue(KIND_INVOICE);
    await tick();
    const second = recordedJobIds().sort();

    // Equal ids are the whole guarantee: BullMQ collapses the repeat into the
    // job already queued. Different ids here would double-bill every board.
    expect(second).toEqual(first);
    expect(first).toHaveLength(BOARDS.length);

    // Equal to each other is not enough on its own. The two ticks run within
    // the same minute, and the period key has minute resolution — so a
    // fan-out that keyed on the current time instead of the claimed slot
    // would still produce two matching sets here and pass. Pinning the ids to
    // the slot, months in the past, is what makes this assertion bite: a
    // now-derived key cannot equal a January one in any later month.
    expect(first).toEqual(BOARDS.map((boardId) => `inv:${boardId}:${DUE_PERIOD_KEY}`).sort());
  });

  it('keeps invoice and statement on the same slot as separate jobs', async () => {
    await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE, statement: MONTHLY_STATEMENT });

    await makeDue(KIND_INVOICE);
    await makeDue(KIND_STATEMENT);

    const res = await tick();
    expect(res.body).toMatchObject({ claimed: 2, dispatched: 2, failed: 0 });

    expect(recordedBulkJobsOfKind(KIND_INVOICE)).toHaveLength(BOARDS.length);
    expect(recordedBulkJobsOfKind(KIND_STATEMENT)).toHaveLength(BOARDS.length);

    // The 'inv'/'stmt' prefixes are what stop one deduping the other away.
    expect(new Set(recordedJobIds()).size).toBe(BOARDS.length * 2);
  });

  it('enqueues nothing once the block is disabled', async () => {
    await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE });
    await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: { ...MONTHLY_INVOICE, enabled: false } });

    // Force the disabled row to be due anyway. The tick's own filter should
    // skip it; if it ever did claim it, the handler's disabled-block guard is
    // the second line of defence and must also enqueue nothing.
    await makeDue(KIND_INVOICE);

    const res = await tick();
    expect(res.status).toBe(200);
    expect(recordedBulkJobsOfKind(KIND_INVOICE)).toHaveLength(0);
  });

  it('ticks green and enqueues nothing for a workspace with no boards', async () => {
    await Board.deleteMany({});

    await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE });
    await makeDue(KIND_INVOICE);

    const res = await tick();

    // Success, not failure. A configured-but-idle workspace must not climb
    // consecutiveFailures — a later epic alerts on that field.
    expect(res.body).toMatchObject({ dispatched: 1, failed: 0 });
    expect(recordedBulkJobsOfKind(KIND_INVOICE)).toHaveLength(0);

    const job = await ScheduledJob.findOne({ kind: KIND_INVOICE, targetId: WS });
    expect(job.consecutiveFailures).toBe(0);
    expect(job.lastError).toBeNull();
  });

  it('advances the schedule past the dispatched slot', async () => {
    await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE });
    await makeDue(KIND_INVOICE);

    await tick();

    const job = await ScheduledJob.findOne({ kind: KIND_INVOICE, targetId: WS });
    expect(job.lastRunAt).not.toBeNull();
    expect(job.nextRunAt.getTime()).toBeGreaterThan(DUE.getTime());

    // A second tick must not re-claim the slot just dispatched.
    resetRecordedJobs();
    const res = await tick();
    expect(res.body.claimed).toBe(0);
    expect(recordedJobIds()).toHaveLength(0);
  });
});
