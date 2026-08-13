import { describe, it, expect, beforeEach, vi } from 'vitest';

// A local mock, overriding the global one in test/setup.js, because this suite
// asserts on the Worker's *constructor arguments* — the queue name it listens
// on and the handler it registers — which the global WorkerMock discards.
const workerCalls = [];
vi.mock('bullmq', () => {
  class QueueMock {
    constructor() {}
    on() {}
    // Records into the same place the global mock in test/setup.js does, so
    // the "generates nothing and sends nothing" assertion below can actually
    // observe work. A local mock that swallowed the call would make that
    // assertion pass no matter what the worker did.
    addBulk(jobs = []) {
      globalThis.__BULLMQ_BULK_JOBS__.push(...jobs);
      return jobs.map((_, index) => ({ id: `job_bulk_${index}` }));
    }
  }
  class WorkerMock {
    constructor(name, handler, opts) {
      workerCalls.push({ name, handler, opts });
      this.name = name;
    }
    on() {}
  }
  return { Queue: QueueMock, Worker: WorkerMock };
});

import { AUTOMATION_QUEUE_NAME } from '../../../src/services/automation/queue.js';
import { startAutomationWorker } from '../../../src/workers/automationWorker.js';

const JOB = {
  data: {
    kind: 'invoice_automation',
    workspaceId: 'ws-1',
    boardId: 'board-a',
    periodKey: '20260116-0900',
  },
};

/** The handler the worker registered, as BullMQ would call it. */
function registeredHandler() {
  return workerCalls.at(-1).handler;
}

describe('startAutomationWorker', () => {
  beforeEach(() => {
    workerCalls.length = 0;
  });

  it('listens on the automation queue name', () => {
    startAutomationWorker();

    expect(workerCalls).toHaveLength(1);
    // Compared against the exported constant, not a literal. The constant
    // carries the Redis Cluster hash tag ('{automation}'), and a Worker
    // listening on the untagged name silently processes nothing while the
    // queue grows — the failure this assertion exists to catch.
    expect(workerCalls[0].name).toBe(AUTOMATION_QUEUE_NAME);
  });

  it('builds its own Redis connection rather than sharing the queue connection', () => {
    startAutomationWorker();

    expect(workerCalls[0].opts.connection).toBeDefined();
  });

  it('completes a job rather than leaving it to retry', async () => {
    startAutomationWorker();

    await expect(registeredHandler()(JOB)).resolves.toBeUndefined();
  });

  it('is inert: generates nothing and sends nothing', async () => {
    startAutomationWorker();
    await registeredHandler()(JOB);

    // The worker's documented contract while Epic 5 parts 3-4 are unbuilt. It
    // drains the queue so jobs do not accumulate against a consumer that was
    // never meant to act on them, and does no work of its own.
    //
    // This assertion is meant to fail when PDF generation and SES delivery
    // land — that is the point. It makes replacing the stub a deliberate edit
    // against a test rather than a silent change nobody reviews.
    expect(globalThis.__BULLMQ_BULK_JOBS__ ?? []).toHaveLength(0);
  });
});
