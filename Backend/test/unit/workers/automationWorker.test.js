import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AUTOMATION_QUEUE_NAME } from '../../../src/services/automation/queue.js';
import { startAutomationWorker } from '../../../src/workers/automationWorker.js';
import AutomationSettings from '../../../src/models/AutomationSettings.js';
import Business from '../../../src/models/Business.js';
import Item from '../../../src/models/Item.js';
import PDFLink from '../../../src/models/PDFLink.js';
import { outboxKeyFor } from '../../../src/services/email/outbox.js';

const JOB = {
  data: {
    kind: 'invoice_automation',
    workspaceId: 'ws-1',
    boardId: 'board-a',
    slot: '2026-01-16T09:00:00.000Z',
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

  it('enqueues nothing of its own', async () => {
    startAutomationWorker();
    await registeredHandler()(JOB);

    expect(globalThis.__BULLMQ_BULK_JOBS__ ?? []).toHaveLength(0);
  });

  // The inert pin below this point was replaced deliberately — its own comment
  // said it was meant to fail when delivery work landed. The first slice of
  // Epic 5 part 4 is the offline outbox: the worker now composes the email its
  // settings block describes and writes it where a person can verify it.
  // Nothing is sent anywhere, in any mode.
  describe('offline outbox delivery', () => {
    const saved = {};
    let root;

    beforeEach(async () => {
      saved.ISOPLUS_OFFLINE = process.env.ISOPLUS_OFFLINE;
      saved.LOCAL_FILE_ROOT = process.env.LOCAL_FILE_ROOT;
      root = mkdtempSync(join(tmpdir(), 'worker-outbox-'));
      process.env.LOCAL_FILE_ROOT = root;
      await AutomationSettings.deleteMany({ workspaceId: 'ws-1' });
    });

    afterEach(async () => {
      process.env.ISOPLUS_OFFLINE = saved.ISOPLUS_OFFLINE;
      process.env.LOCAL_FILE_ROOT = saved.LOCAL_FILE_ROOT;
      rmSync(root, { recursive: true, force: true });
      await AutomationSettings.deleteMany({ workspaceId: 'ws-1' });
    });

    it('offline, enabled block: writes the composed email to the outbox', async () => {
      process.env.ISOPLUS_OFFLINE = '1';
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        invoice: { enabled: true, emailSubject: 'Invoice run', emailMessage: 'Attached.', replyTo: 'a@b.com' },
      });
      startAutomationWorker();

      await registeredHandler()(JOB);

      const path = join(root, outboxKeyFor(JOB.data));
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, 'utf8')).subject).toBe('Invoice run');
    });

    it('offline, block disabled or settings missing: writes nothing', async () => {
      process.env.ISOPLUS_OFFLINE = '1';
      startAutomationWorker();

      await registeredHandler()(JOB);

      expect(existsSync(join(root, 'outbox'))).toBe(false);
    });

    it('offline: generates an invoice PDF per billable item and lists it in the outbox email', async () => {
      process.env.ISOPLUS_OFFLINE = '1';
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        invoice: { enabled: true, emailSubject: 'Invoice run' },
      });
      await Business.deleteMany({ workspaceId: 'ws-1' });
      await Item.deleteMany({ workspaceId: 'ws-1' });
      await Business.create({
        workspaceId: 'ws-1', name: 'Worker Gen Biz', abn: '11 111 111 111',
        address: { street: '1 St', suburb: 'S', state: 'NSW', postcode: '2000', country: 'AU' },
        bankDetails: { accountName: 'A', bankName: 'B', bsb: '123456', accountNumber: '1234567' },
        documentNumbering: { invoice: { prefix: 'IN-', nextNumber: 900 }, quote: { prefix: 'QT-', nextNumber: 1 }, purchaseOrder: { prefix: 'PO-', nextNumber: 1 } },
      });
      await Item.create({
        workspaceId: 'ws-1', boardId: 'board-a', folderId: 'f', itemId: 'wk-bill-1',
        data: { 'Recipient of the Quote': 'W T', 'Quantity (Direct Support)': 1, 'Unit Price for Direct Support($)': 10, 'Unit (Direct Support)': 'Hour' },
      });
      startAutomationWorker();

      await registeredHandler()(JOB);

      const written = JSON.parse(readFileSync(join(root, outboxKeyFor(JOB.data)), 'utf8'));
      expect(written.attachments).toHaveLength(1);
      expect(written.attachments[0]).toContain('/api/local-files/');
      // and the artifact itself is a stored PDF
      const rel = decodeURIComponent(written.attachments[0].split('/api/local-files/')[1]);
      expect(readFileSync(join(root, rel)).subarray(0, 5).toString()).toBe('%PDF-');

      await Business.deleteMany({ workspaceId: 'ws-1' });
      await Item.deleteMany({ workspaceId: 'ws-1' });
      await PDFLink.deleteMany({ workspaceId: 'ws-1' });
    });

    // Online there is still no transport. The job must complete quietly —
    // a throw here would put every automation job into BullMQ retry against
    // a transport that does not exist.
    it('online: completes without writing or throwing', async () => {
      process.env.ISOPLUS_OFFLINE = '0';
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        invoice: { enabled: true, emailSubject: 'Invoice run' },
      });
      startAutomationWorker();

      await expect(registeredHandler()(JOB)).resolves.toBeUndefined();
      expect(existsSync(join(root, 'outbox'))).toBe(false);
    });
  });
});
