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
      this.events = [];
      workerCalls.push({ name, handler, opts, worker: this });
      this.name = name;
    }
    on(event) {
      this.events.push(event);
      return this;
    }
  }
  return { Queue: QueueMock, Worker: WorkerMock };
});

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AUTOMATION_QUEUE_NAME } from '../../../src/services/automation/queue.js';
import { startAutomationWorker } from '../../../src/workers/automationWorker.js';
import AutomationSettings from '../../../src/models/AutomationSettings.js';
import Board from '../../../src/models/Board.js';
import Business from '../../../src/models/Business.js';
import Item from '../../../src/models/Item.js';
import InvoiceNumber from '../../../src/models/InvoiceNumber.js';
import PDFLink from '../../../src/models/PDFLink.js';
import { outboxKeyFor } from '../../../src/services/email/outbox.js';

import * as logger from '../../../src/utils/logger.js';
import * as generateDocuments from '../../../src/services/automation/generateDocuments.js';
import * as outbox from '../../../src/services/email/outbox.js';
import * as pushXero from '../../../src/services/automation/pushDraftInvoicesToXero.js';

const JOB = {
  data: {
    kind: 'invoice_automation',
    workspaceId: 'ws-1',
    boardId: 'board-a',
    slot: '2026-01-16T09:00:00.000Z',
    periodKey: '20260116-0900',
    timezone: 'Australia/Sydney',
    schedule: { every: { n: 1, unit: 'month' } },
  },
};

const WORKER_MASTER = 'mp-wk-1';
const WORKER_SP = '11111111-cccc-4111-8111-111111111111';
const WORKER_PP = '22222222-cccc-4111-8111-222222222222';
const WORKER_CAT = '66666666-cccc-4111-8111-666666666666';

async function seedWorkerNdisBoard() {
  await cleanupWorkerNdisBoard();
  await Business.create({
    workspaceId: 'ws-1', name: 'Worker Gen Biz', abn: '11 111 111 111',
    address: { street: '1 St', suburb: 'S', state: 'NSW', postcode: '2000', country: 'AU' },
    bankDetails: { accountName: 'A', bankName: 'B', bsb: '123456', accountNumber: '1234567' },
    documentNumbering: { invoice: { prefix: 'IN-', nextNumber: 900 }, quote: { prefix: 'QT-', nextNumber: 1 }, purchaseOrder: { prefix: 'PO-', nextNumber: 1 } },
  });
  await Board.create({
    workspaceId: 'ws-1', boardId: 'board-a', name: 'NDIS Board', label: 'Care Management - NDIS',
  });
  await Item.create({
    workspaceId: 'ws-1', boardId: 'cat-board', folderId: 'f-cat', itemId: WORKER_CAT,
    data: { 'Support Item Number': '01_011_0107_1_1', 'Support Item Name': 'Assistance' },
  });
  await Item.create({
    workspaceId: 'ws-1', boardId: 'cat-board', folderId: 'f-cat', itemId: WORKER_SP,
    data: {
      'Direct Support Item Number': [{ id: WORKER_CAT, name: 'Assistance' }],
      'Unit (Direct Support)': 'Hour(H)',
      'Agreed Unit Price for Direct Support ($)': '70.00',
    },
  });
  await Item.create({
    workspaceId: 'ws-1', boardId: 'cat-board', folderId: 'f-cat', itemId: WORKER_PP,
    data: { 'Full Name/Preferred Name': 'Samuel Rivers', 'NDIS Number': '430123456' },
  });
  await Item.create({
    workspaceId: 'ws-1', boardId: 'board-a', folderId: 'f-master', itemId: WORKER_MASTER,
    data: {
      'Timesheet Approval': 'Approved',
      'Job Status': 'Completed',
      'Payment Status': 'Unpaid',
      'Service Plan': [{ id: WORKER_SP }],
      'Participant Profile': [{ id: WORKER_PP }],
      'Scheduled Shift Start Date & Time': '2025-12-16T21:00:00.000Z',
      'Actual Shift Start Date and Time': '2025-12-16T22:00:00.000Z',
      'Actual Shift End Date and Time': '2025-12-17T00:30:00.000Z',
      'Actual Shift Duration(Hr.)': '2.5',
      'Direct Support Value($) - Time Based Support': '175.00',
    },
  });
}

async function cleanupWorkerNdisBoard() {
  await Promise.all([
    Business.deleteMany({ workspaceId: 'ws-1' }),
    Board.deleteMany({ boardId: 'board-a' }),
    Item.deleteMany({ workspaceId: 'ws-1' }),
    InvoiceNumber.deleteMany({ workspaceId: 'ws-1' }),
    PDFLink.deleteMany({ workspaceId: 'ws-1' }),
  ]);
}

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

  // A BullMQ Worker with no 'error' listener re-emits its connection's errors
  // as an unhandled EventEmitter 'error', which terminates the Node process.
  // The worker is started from src/index.js inside the API process, so a Redis
  // blip would take the API down with it. syncWorker.js registers these
  // deliberately; this is the same idiom.
  it('registers error and failure listeners so a Redis blip cannot kill the API process', () => {
    startAutomationWorker();

    expect(workerCalls[0].worker.events).toContain('error');
    expect(workerCalls[0].worker.events).toContain('failed');
  });

  // BullMQ's default is 1, but leaving it implicit means nobody chose it.
  // syncWorker.js states its 2; this states its 1, and the reason lives in a
  // comment beside it.
  it('sets its concurrency explicitly rather than inheriting the BullMQ default', () => {
    startAutomationWorker();

    expect(workerCalls[0].opts.concurrency).toBe(1);
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
      saved.EMAIL_FROM = process.env.EMAIL_FROM;
      root = mkdtempSync(join(tmpdir(), 'worker-outbox-'));
      process.env.LOCAL_FILE_ROOT = root;
      await AutomationSettings.deleteMany({ workspaceId: 'ws-1' });
    });

    afterEach(async () => {
      process.env.ISOPLUS_OFFLINE = saved.ISOPLUS_OFFLINE;
      process.env.LOCAL_FILE_ROOT = saved.LOCAL_FILE_ROOT;
      if (saved.EMAIL_FROM === undefined) delete process.env.EMAIL_FROM;
      else process.env.EMAIL_FROM = saved.EMAIL_FROM;
      rmSync(root, { recursive: true, force: true });
      await AutomationSettings.deleteMany({ workspaceId: 'ws-1' });
      await cleanupWorkerNdisBoard();
    });

    // The board is seeded now because messages are composed per participant:
    // a run with nothing to bill has no participant to address and therefore
    // composes nothing at all. That is the subject of its own test below.
    it('offline, enabled block: writes the composed email to the outbox', async () => {
      process.env.ISOPLUS_OFFLINE = '1';
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        invoice: { enabled: true, emailSubject: 'Invoice run', emailMessage: 'Attached.', replyTo: 'a@b.com' },
      });
      await seedWorkerNdisBoard();
      startAutomationWorker();

      await registeredHandler()(JOB);

      const path = join(root, outboxKeyFor({ ...JOB.data, recipientKey: 'Samuel Rivers' }));
      expect(existsSync(path)).toBe(true);
      const written = JSON.parse(readFileSync(path, 'utf8'));
      expect(written.subject).toBe('Invoice run');
      expect(written.replyTo).toBe('a@b.com');

      await cleanupWorkerNdisBoard();
    });

    it('offline, block disabled or settings missing: writes nothing', async () => {
      process.env.ISOPLUS_OFFLINE = '1';
      startAutomationWorker();

      await registeredHandler()(JOB);

      expect(existsSync(join(root, 'outbox'))).toBe(false);
    });

    it('offline: generates an Invoice Generator PDF and lists it in the outbox email', async () => {
      process.env.ISOPLUS_OFFLINE = '1';
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        invoice: { enabled: true, emailSubject: 'Invoice run' },
      });
      await seedWorkerNdisBoard();
      startAutomationWorker();

      await registeredHandler()(JOB);

      const written = JSON.parse(readFileSync(
        join(root, outboxKeyFor({ ...JOB.data, recipientKey: 'Samuel Rivers' })), 'utf8',
      ));
      expect(written.attachments).toHaveLength(1);
      expect(written.attachments[0]).toContain('/api/local-files/');
      expect(written.attachments[0]).toContain('NDIS-invoices/');
      expect(written.attachments[0]).not.toContain('/auto/');
      const rel = decodeURIComponent(written.attachments[0].split('/api/local-files/')[1]);
      expect(readFileSync(join(root, rel)).subarray(0, 5).toString()).toBe('%PDF-');
      expect(await InvoiceNumber.findOne({ workspaceId: 'ws-1', itemId: WORKER_MASTER, type: 'PDF' })).toBeTruthy();

      await cleanupWorkerNdisBoard();
    });

    // Also the pin for "nothing to bill composes nothing". Messages are grouped
    // by participant, so a board that generated no documents has no group and
    // no email — where the whole-board group used to compose one carrying zero
    // attachments, which is a message no client should receive.
    it('offline: a quote-shaped item without an approved timesheet is not billed, and no empty email is composed', async () => {
      process.env.ISOPLUS_OFFLINE = '1';
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        invoice: { enabled: true, emailSubject: 'Invoice run' },
      });
      await Business.deleteMany({ workspaceId: 'ws-1' });
      await Board.deleteMany({ boardId: 'board-a' });
      await Item.deleteMany({ workspaceId: 'ws-1' });
      await Business.create({
        workspaceId: 'ws-1', name: 'Worker Gen Biz', abn: '11 111 111 111',
        address: { street: '1 St', suburb: 'S', state: 'NSW', postcode: '2000', country: 'AU' },
        bankDetails: { accountName: 'A', bankName: 'B', bsb: '123456', accountNumber: '1234567' },
        documentNumbering: { invoice: { prefix: 'IN-', nextNumber: 900 }, quote: { prefix: 'QT-', nextNumber: 1 }, purchaseOrder: { prefix: 'PO-', nextNumber: 1 } },
      });
      await Board.create({
        workspaceId: 'ws-1', boardId: 'board-a', name: 'NDIS Board', label: 'Care Management - NDIS',
      });
      await Item.create({
        workspaceId: 'ws-1', boardId: 'board-a', folderId: 'f', itemId: 'wk-bill-1',
        data: { 'Recipient of the Quote': 'W T', 'Quantity (Direct Support)': 1, 'Unit Price for Direct Support($)': 10, 'Unit (Direct Support)': 'Hour' },
      });
      startAutomationWorker();

      await registeredHandler()(JOB);

      expect(existsSync(join(root, 'outbox'))).toBe(false);
      expect(await InvoiceNumber.countDocuments({ workspaceId: 'ws-1' })).toBe(0);

      await cleanupWorkerNdisBoard();
    });

    // Driven by the real generator, not a mocked return value. The version this
    // replaces mocked generateInvoicesForBoard into returning a `participant`
    // field and then asserted that {{client_name}} substituted — proving only
    // that the mock said what the assertion wanted. If the real generator ever
    // stops carrying participant, this test is the one that notices.
    it('offline: substitutes dynamic fields into subject and message; unknown tokens survive', async () => {
      process.env.ISOPLUS_OFFLINE = '1';
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        invoice: {
          enabled: true,
          emailSubject: 'Invoices {{invoice_number}} for {{ client_name }} — {{business_name}} {{statement_number}}',
          emailMessage: 'Dear {{client_name}}, invoices {{invoice_number}} attached. {{mystery_token}}',
        },
      });
      await seedWorkerNdisBoard();
      startAutomationWorker();

      await registeredHandler()(JOB);

      const written = JSON.parse(readFileSync(
        join(root, outboxKeyFor({ ...JOB.data, recipientKey: 'Samuel Rivers' })), 'utf8',
      ));
      // {{statement_number}} has no data-model backing, and {{mystery_token}}
      // is unknown — both must survive verbatim, never become 'undefined'.
      expect(written.subject).toBe(
        'Invoices IN-900 (ISO+™) for Samuel Rivers — Worker Gen Biz {{statement_number}}',
      );
      expect(written.body).toBe(
        'Dear Samuel Rivers, invoices IN-900 (ISO+™) attached. {{mystery_token}}',
      );
      // The outbox attachments contract is unchanged: an array of pdfUrl strings.
      expect(written.attachments).toHaveLength(1);
      expect(written.attachments[0]).toContain('NDIS-invoices/');

      await cleanupWorkerNdisBoard();
    });

    // emailMessage is rich-text HTML from the Finance Settings automation tab
    // and is emailed as HTML. A participant name is ISO+ board data, so it must
    // be escaped on the way in. The subject is plain text and must not be.
    it('offline: escapes substituted values in the HTML body but not in the subject', async () => {
      process.env.ISOPLUS_OFFLINE = '1';
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        statement: {
          enabled: true,
          emailSubject: 'Statement for {{client_name}}',
          emailMessage: '<p>Dear {{client_name}}, your statement is attached.</p>',
        },
      });
      await cleanupWorkerNdisBoard();
      await Business.create({
        workspaceId: 'ws-1', name: 'Worker Stmt Biz', abn: '11 111 111 111',
        address: { street: '1 St', suburb: 'S', state: 'NSW', postcode: '2000', country: 'AU' },
        bankDetails: { accountName: 'A', bankName: 'B', bsb: '123456', accountNumber: '1234567' },
        documentNumbering: { invoice: { prefix: 'IN-', nextNumber: 1 }, quote: { prefix: 'QT-', nextNumber: 1 }, purchaseOrder: { prefix: 'PO-', nextNumber: 1 } },
      });
      await Board.create({
        workspaceId: 'ws-1', boardId: 'board-a', name: 'CM Board', label: 'Care Management',
      });
      await Item.create({
        workspaceId: 'ws-1', boardId: 'board-a', folderId: 'f-p', itemId: 'p-amp',
        data: { 'Full Name/Preferred Name': 'Tom & <b>Jerry</b>' },
      });
      startAutomationWorker();

      const statementJob = { data: { ...JOB.data, kind: 'statement_automation' } };
      await registeredHandler()(statementJob);

      const written = JSON.parse(readFileSync(
        join(root, outboxKeyFor({ ...statementJob.data, recipientKey: 'Tom & <b>Jerry</b>' })), 'utf8',
      ));
      expect(written.body).toBe('<p>Dear Tom &amp; &lt;b&gt;Jerry&lt;/b&gt;, your statement is attached.</p>');
      expect(written.subject).toBe('Statement for Tom & <b>Jerry</b>');

      await cleanupWorkerNdisBoard();
    });

    // {{statement_number}} used to render literally in a customer's inbox: the
    // email spec offered the field and nothing allocated one. Statements now
    // claim from Business.documentNumbering.statement, the counter the model
    // has declared unused since it was added.
    it('offline: substitutes {{statement_number}} for a statement run', async () => {
      process.env.ISOPLUS_OFFLINE = '1';
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        statement: {
          enabled: true,
          emailSubject: 'Statement {{statement_number}} for {{client_name}}',
          emailMessage: 'Statement {{statement_number}} attached. {{mystery_token}}',
        },
      });
      await cleanupWorkerNdisBoard();
      await Business.create({
        workspaceId: 'ws-1', name: 'Worker Stmt Biz', abn: '11 111 111 111',
        address: { street: '1 St', suburb: 'S', state: 'NSW', postcode: '2000', country: 'AU' },
        bankDetails: { accountName: 'A', bankName: 'B', bsb: '123456', accountNumber: '1234567' },
        documentNumbering: {
          invoice: { prefix: 'IN-', nextNumber: 1 },
          quote: { prefix: 'QT-', nextNumber: 1 },
          purchaseOrder: { prefix: 'PO-', nextNumber: 1 },
          statement: { prefix: 'STM-', nextNumber: 500 },
        },
      });
      await Board.create({
        workspaceId: 'ws-1', boardId: 'board-a', name: 'CM Board', label: 'Care Management',
      });
      await Item.create({
        workspaceId: 'ws-1', boardId: 'board-a', folderId: 'f-p', itemId: 'p-1',
        data: { 'Full Name/Preferred Name': 'Alex Rivers' },
      });
      startAutomationWorker();

      const statementJob = { data: { ...JOB.data, kind: 'statement_automation' } };
      await registeredHandler()(statementJob);

      const written = JSON.parse(readFileSync(
        join(root, outboxKeyFor({ ...statementJob.data, recipientKey: 'Alex Rivers' })), 'utf8',
      ));
      expect(written.subject).toBe('Statement STM-500 for Alex Rivers');
      // Still only substituted for a value the run produced: an unknown token
      // survives verbatim rather than rendering 'undefined'.
      expect(written.body).toBe('Statement STM-500 attached. {{mystery_token}}');

      await cleanupWorkerNdisBoard();
    });

    // AutomationSettings.recipient allows 'client_participant'. Flattening every
    // participant's statement into one attachments array and sending one message
    // per board means the first real per-participant delivery mails every
    // participant everyone else's statement. Fix the shape while it is cheap:
    // one composed message per participant, carrying only that participant's
    // PDF and only that participant's {{client_name}}.
    it('offline: composes one message per participant when the recipient is the participant', async () => {
      process.env.ISOPLUS_OFFLINE = '1';
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        statement: {
          enabled: true,
          recipient: 'client_participant',
          emailSubject: 'Statement for {{client_name}}',
        },
      });
      await cleanupWorkerNdisBoard();
      await Business.create({
        workspaceId: 'ws-1', name: 'Worker Stmt Biz', abn: '11 111 111 111',
        address: { street: '1 St', suburb: 'S', state: 'NSW', postcode: '2000', country: 'AU' },
        bankDetails: { accountName: 'A', bankName: 'B', bsb: '123456', accountNumber: '1234567' },
        documentNumbering: { invoice: { prefix: 'IN-', nextNumber: 1 }, quote: { prefix: 'QT-', nextNumber: 1 }, purchaseOrder: { prefix: 'PO-', nextNumber: 1 } },
      });
      await Board.create({
        workspaceId: 'ws-1', boardId: 'board-a', name: 'CM Board', label: 'Care Management',
      });
      await Item.create({
        workspaceId: 'ws-1', boardId: 'board-a', folderId: 'f-p', itemId: 'p-1',
        data: { 'Full Name/Preferred Name': 'Alex Rivers' },
      });
      await Item.create({
        workspaceId: 'ws-1', boardId: 'board-a', folderId: 'f-p', itemId: 'p-2',
        data: { 'Full Name/Preferred Name': 'Sam Lee' },
      });
      // Spied rather than read back off disk: outboxKeyFor() has no recipient
      // component yet, so two per-participant previews would land on one path.
      // That is a required follow-up in services/email/outbox.js, which this
      // agent does not own — see the report.
      const spy = vi.spyOn(outbox, 'deliverEmail');
      startAutomationWorker();

      const statementJob = { data: { ...JOB.data, kind: 'statement_automation' } };
      await registeredHandler()(statementJob);

      expect(spy).toHaveBeenCalledTimes(2);
      const bySubject = Object.fromEntries(
        spy.mock.calls.map(([msg]) => [msg.block.emailSubject, msg.attachments]),
      );
      expect(Object.keys(bySubject).sort()).toEqual([
        'Statement for Alex Rivers', 'Statement for Sam Lee',
      ]);
      expect(bySubject['Statement for Alex Rivers']).toHaveLength(1);
      expect(bySubject['Statement for Sam Lee']).toHaveLength(1);
      expect(bySubject['Statement for Alex Rivers'][0])
        .not.toBe(bySubject['Statement for Sam Lee'][0]);

      spy.mockRestore();
      await cleanupWorkerNdisBoard();
    });

    // This test used to pin the opposite — one message per board — and the
    // expectation was the part that was wrong.
    //
    // 'billing_contact' chooses WHICH address on a participant's profile
    // receives their documents (Billing Email, falling back to their own Email
    // only when no Billing Contact is named); it does not mean one shared
    // mailbox for the board. There is no board-level or workspace-level billing
    // contact in the data model to send that message to — selectBillingAddress
    // reads off a participant profile, and Business.email is the provider's own
    // address. So the whole-board group had no name to resolve, resolveRecipient
    // answered no_participant_name every time, and the DEFAULT recipient could
    // never send anything.
    //
    // Grouping per participant is also the only shape that is safe if it did
    // resolve: one message carrying every participant's invoices, addressed to
    // one of them, is a cross-client data leak.
    it('offline: composes one message per participant for the billing contact too', async () => {
      process.env.ISOPLUS_OFFLINE = '1';
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        statement: { enabled: true, recipient: 'billing_contact', emailSubject: 'Statements' },
      });
      await cleanupWorkerNdisBoard();
      await Business.create({
        workspaceId: 'ws-1', name: 'Worker Stmt Biz', abn: '11 111 111 111',
        address: { street: '1 St', suburb: 'S', state: 'NSW', postcode: '2000', country: 'AU' },
        bankDetails: { accountName: 'A', bankName: 'B', bsb: '123456', accountNumber: '1234567' },
        documentNumbering: { invoice: { prefix: 'IN-', nextNumber: 1 }, quote: { prefix: 'QT-', nextNumber: 1 }, purchaseOrder: { prefix: 'PO-', nextNumber: 1 } },
      });
      await Board.create({
        workspaceId: 'ws-1', boardId: 'board-a', name: 'CM Board', label: 'Care Management',
      });
      await Item.create({
        workspaceId: 'ws-1', boardId: 'board-a', folderId: 'f-p', itemId: 'p-1',
        data: { 'Full Name/Preferred Name': 'Alex Rivers' },
      });
      await Item.create({
        workspaceId: 'ws-1', boardId: 'board-a', folderId: 'f-p', itemId: 'p-2',
        data: { 'Full Name/Preferred Name': 'Sam Lee' },
      });
      const spy = vi.spyOn(outbox, 'deliverEmail');
      startAutomationWorker();

      await registeredHandler()({ data: { ...JOB.data, kind: 'statement_automation' } });

      expect(spy).toHaveBeenCalledTimes(2);
      // recipientKey is the name sesBackend resolves the Billing Email from,
      // so it has to be the participant rather than null.
      const byRecipient = Object.fromEntries(
        spy.mock.calls.map(([msg]) => [msg.recipientKey, msg.attachments]),
      );
      expect(Object.keys(byRecipient).sort()).toEqual(['Alex Rivers', 'Sam Lee']);
      expect(byRecipient['Alex Rivers']).toHaveLength(1);
      expect(byRecipient['Sam Lee']).toHaveLength(1);
      expect(byRecipient['Alex Rivers'][0]).not.toBe(byRecipient['Sam Lee'][0]);

      spy.mockRestore();
      await cleanupWorkerNdisBoard();
    });

    it('offline: statement jobs attach Monthly Statement PDFs on Care Management boards', async () => {
      process.env.ISOPLUS_OFFLINE = '1';
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        statement: { enabled: true, emailSubject: 'Statement for {{client_name}} — {{business_name}}' },
      });
      await cleanupWorkerNdisBoard();
      await Business.create({
        workspaceId: 'ws-1', name: 'Worker Stmt Biz', abn: '11 111 111 111',
        address: { street: '1 St', suburb: 'S', state: 'NSW', postcode: '2000', country: 'AU' },
        bankDetails: { accountName: 'A', bankName: 'B', bsb: '123456', accountNumber: '1234567' },
        documentNumbering: { invoice: { prefix: 'IN-', nextNumber: 1 }, quote: { prefix: 'QT-', nextNumber: 1 }, purchaseOrder: { prefix: 'PO-', nextNumber: 1 } },
      });
      await Board.create({
        workspaceId: 'ws-1', boardId: 'board-a', name: 'CM Board', label: 'Care Management',
      });
      await Item.create({
        workspaceId: 'ws-1', boardId: 'board-a', folderId: 'f-p', itemId: 'p-1',
        data: { 'Full Name/Preferred Name': 'Alex Rivers' },
      });
      startAutomationWorker();

      const statementJob = { data: { ...JOB.data, kind: 'statement_automation' } };
      await registeredHandler()(statementJob);

      const written = JSON.parse(readFileSync(
        join(root, outboxKeyFor({ ...statementJob.data, recipientKey: 'Alex Rivers' })), 'utf8',
      ));
      expect(written.attachments).toHaveLength(1);
      expect(written.attachments[0]).toContain('monthly-statements/');
      // Statement runs derive {{client_name}} from the participants generated.
      expect(written.subject).toBe('Statement for Alex Rivers — Worker Stmt Biz');

      await cleanupWorkerNdisBoard();
    });

    // Order of operations, and the reason this test inverted.
    //
    // Generation is irreversible: it consumes invoice numbers off
    // Business.documentNumbering, writes S3 objects and creates PDFLink rows
    // keyed on periodKey. Delivery is the point of the run. Generating first
    // and discovering afterwards that there is no transport burns numbers for
    // PDFs nobody receives — and worse, the PDFLink rows it left behind make
    // the re-run after SES lands return those same stale documents instead of
    // regenerating. So deliverability is checked BEFORE anything is generated.
    it('online with no transport: generates nothing rather than generating and discarding', async () => {
      process.env.ISOPLUS_OFFLINE = '0';
      // "No transport" must be this test's doing, not the ambient env's:
      // a developer .env with EMAIL_FROM set would otherwise flip it online.
      delete process.env.EMAIL_FROM;
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        invoice: { enabled: true, emailSubject: 'Invoice run' },
      });
      const spy = vi.spyOn(generateDocuments, 'generateInvoicesForBoard');
      startAutomationWorker();

      // Resolves rather than throws: nothing irreversible happened, and three
      // BullMQ retries per board would only repeat the same warn.
      await expect(registeredHandler()(JOB)).resolves.toBeUndefined();

      expect(spy).not.toHaveBeenCalled();
      expect(existsSync(join(root, 'outbox'))).toBe(false);
      spy.mockRestore();
    });

    // The transport check above stops a run with nowhere to send. This one
    // covers the DEFAULT recipient end to end, because that is the path a pilot
    // takes and it was the path that did nothing at all.
    //
    // Two shapes have been wrong here in turn. First, deliveryGroups gave
    // 'billing_contact' one whole-board group with participant null, so
    // resolveRecipient answered no_participant_name, SES recorded the refusal
    // rather than throwing it, and the job resolved as a success having burnt
    // invoice numbers. Then a pre-generation recipient preflight was added to
    // stop that, and — because the group still had no name — it turned the
    // default path into a guaranteed silent no-op: generated nothing, billed
    // nobody, schedule advanced.
    //
    // The grouping was the bug both times. With one group per participant the
    // name is real, so the run generates and hands one message per participant
    // to the backend.
    // Online here means "the SES backend is the active one", so the generators
    // are stubbed: rendering a real PDF online would need a live S3 bucket, and
    // what this test is about is the shape of what reaches the backend. The
    // generators' own output is covered against the real renderer by the
    // offline tests above and by automation.generateDocuments.test.js.
    it('online: the billing-contact default generates and delivers per participant', async () => {
      process.env.ISOPLUS_OFFLINE = '0';
      process.env.EMAIL_FROM = 'billing@dev.isoplus.online';
      process.env.AWS_ACCESS_KEY_ID = 'test-key';
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
      process.env.AWS_REGION = 'ap-southeast-2';
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        invoice: {
          enabled: true,
          recipient: 'billing_contact',
          emailSubject: 'Invoice {{invoice_number}} for {{client_name}}',
        },
      });
      const genSpy = vi.spyOn(generateDocuments, 'generateInvoicesForBoard').mockResolvedValue([
        { itemId: 'i-1', invoiceNumber: 'IN-900', participant: 'Samuel Rivers', pdfUrl: 'https://b.s3.ap-southeast-2.amazonaws.com/out/1.pdf?X-Amz-Signature=x' },
        { itemId: 'i-2', invoiceNumber: 'IN-901', participant: 'Dana Cole', pdfUrl: 'https://b.s3.ap-southeast-2.amazonaws.com/out/2.pdf?X-Amz-Signature=y' },
      ]);
      // Stubbed so the assertion is about what the worker hands over, not about
      // SES: the real backend would try to resolve an address and send.
      const deliverSpy = vi.spyOn(outbox, 'deliverEmail')
        .mockResolvedValue({ delivered: true, backend: 'ses', messageId: 'm-1' });
      startAutomationWorker();

      await expect(registeredHandler()(JOB)).resolves.toBeUndefined();

      expect(genSpy).toHaveBeenCalled();
      // Two participants, two messages — not one message carrying both
      // participants' invoices, which is what the whole-board group would have
      // composed and what makes that shape a cross-client leak.
      expect(deliverSpy).toHaveBeenCalledTimes(2);
      const byRecipient = Object.fromEntries(
        deliverSpy.mock.calls.map(([msg]) => [msg.recipientKey, msg.attachments]),
      );
      expect(Object.keys(byRecipient).sort()).toEqual(['Dana Cole', 'Samuel Rivers']);
      expect(byRecipient['Samuel Rivers']).toEqual(['https://b.s3.ap-southeast-2.amazonaws.com/out/1.pdf?X-Amz-Signature=x']);
      expect(byRecipient['Dana Cole']).toEqual(['https://b.s3.ap-southeast-2.amazonaws.com/out/2.pdf?X-Amz-Signature=y']);
      // And each subject carries only its own participant's name and number,
      // which is the other half of what the whole-board group got wrong.
      expect(deliverSpy.mock.calls.map(([msg]) => msg.block.emailSubject).sort()).toEqual([
        'Invoice IN-900 for Samuel Rivers',
        'Invoice IN-901 for Dana Cole',
      ].sort());

      genSpy.mockRestore();
      deliverSpy.mockRestore();
      await cleanupWorkerNdisBoard();
    });

    // The residual risk the preflight was reaching for, stated honestly.
    //
    // A participant whose profile carries no address cannot be discovered
    // before generation — their name comes out of the generator. So the
    // documents exist and SES refuses that one message. Nothing is lost: the
    // PDFLink rows carry the slot's periodKey, so the next run hands back the
    // same documents instead of minting new numbers, and the status panel keeps
    // showing them as 'generated' rather than 'sent' until someone fixes the
    // profile. It is reported at error, not warn — it needs a human.
    it('online with a participant who has no address: reports it and does not throw', async () => {
      process.env.ISOPLUS_OFFLINE = '0';
      process.env.EMAIL_FROM = 'billing@dev.isoplus.online';
      process.env.AWS_ACCESS_KEY_ID = 'test-key';
      process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
      process.env.AWS_REGION = 'ap-southeast-2';
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        invoice: { enabled: true, recipient: 'billing_contact', emailSubject: 'Invoice run' },
      });
      const genSpy = vi.spyOn(generateDocuments, 'generateInvoicesForBoard').mockResolvedValue([
        { itemId: 'i-1', invoiceNumber: 'IN-900', participant: 'Samuel Rivers', pdfUrl: 'https://b.s3.ap-southeast-2.amazonaws.com/out/1.pdf' },
      ]);
      const deliverSpy = vi.spyOn(outbox, 'deliverEmail')
        .mockResolvedValue({ delivered: false, backend: 'ses', reason: 'no_address_on_profile' });
      const errorSpy = vi.spyOn(logger, 'error');
      startAutomationWorker();

      // Resolves rather than throws: a BullMQ retry cannot fix a profile, and
      // it would re-send to the participants whose messages did go.
      await expect(registeredHandler()(JOB)).resolves.toBeUndefined();

      // Reported at error, not swallowed into the info line a delivered
      // message gets — this is data a human has to go and fix.
      expect(errorSpy.mock.calls.some(([, message, meta]) => (
        message === 'Automation email was not delivered; documents kept for a re-send'
        && meta.reason === 'no_address_on_profile'
        && meta.participant === 'Samuel Rivers'
      ))).toBe(true);

      genSpy.mockRestore();
      deliverSpy.mockRestore();
      errorSpy.mockRestore();
      await cleanupWorkerNdisBoard();
    });

    it('online with no transport: consumes no invoice number', async () => {
      process.env.ISOPLUS_OFFLINE = '0';
      delete process.env.EMAIL_FROM;
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        invoice: { enabled: true, emailSubject: 'Invoice run' },
      });
      await seedWorkerNdisBoard();
      startAutomationWorker();

      await registeredHandler()(JOB);

      const business = await Business.findOne({ workspaceId: 'ws-1' }).lean();
      expect(business.documentNumbering.invoice.nextNumber).toBe(900);
      expect(await InvoiceNumber.countDocuments({ workspaceId: 'ws-1' })).toBe(0);

      await cleanupWorkerNdisBoard();
    });
  });

  // AutomationSettings.sendMethod has been stored, validated and displayed
  // since the settings tab shipped, and nothing branched on it: a workspace
  // that chose "Send from Accounting Platform" got the ISO+ email anyway.
  describe('sendMethod routing', () => {
    const saved = {};
    let root;

    async function connectXero() {
      await Business.updateOne(
        { workspaceId: 'ws-1' },
        { $set: { xeroIntegrated: true, xeroTokens: { accessToken: 'a', refreshToken: 'r' } } },
      );
    }

    beforeEach(async () => {
      saved.ISOPLUS_OFFLINE = process.env.ISOPLUS_OFFLINE;
      saved.LOCAL_FILE_ROOT = process.env.LOCAL_FILE_ROOT;
      process.env.ISOPLUS_OFFLINE = '1';
      root = mkdtempSync(join(tmpdir(), 'worker-sendmethod-'));
      process.env.LOCAL_FILE_ROOT = root;
      await AutomationSettings.deleteMany({ workspaceId: 'ws-1' });
    });

    afterEach(async () => {
      process.env.ISOPLUS_OFFLINE = saved.ISOPLUS_OFFLINE;
      process.env.LOCAL_FILE_ROOT = saved.LOCAL_FILE_ROOT;
      rmSync(root, { recursive: true, force: true });
      vi.restoreAllMocks();
      await AutomationSettings.deleteMany({ workspaceId: 'ws-1' });
      await cleanupWorkerNdisBoard();
    });

    it("sendMethod 'isoplus' still emails and never touches Xero", async () => {
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        invoice: { enabled: true, sendMethod: 'isoplus', emailSubject: 'Invoice run' },
      });
      await seedWorkerNdisBoard();
      await connectXero();
      const pushSpy = vi.spyOn(pushXero, 'pushDraftInvoicesToXero');
      startAutomationWorker();

      await registeredHandler()(JOB);

      expect(pushSpy).not.toHaveBeenCalled();
      expect(existsSync(join(root, outboxKeyFor({ ...JOB.data, recipientKey: 'Samuel Rivers' })))).toBe(true);
    });

    it("sendMethod 'accounting' pushes the generated invoices as drafts and sends no email", async () => {
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        invoice: { enabled: true, sendMethod: 'accounting', emailSubject: 'Invoice run' },
      });
      await seedWorkerNdisBoard();
      await connectXero();
      const pushSpy = vi.spyOn(pushXero, 'pushDraftInvoicesToXero').mockResolvedValue([]);
      const deliverSpy = vi.spyOn(outbox, 'deliverEmail');
      startAutomationWorker();

      await registeredHandler()(JOB);

      expect(deliverSpy).not.toHaveBeenCalled();
      expect(existsSync(join(root, 'outbox'))).toBe(false);
      expect(pushSpy).toHaveBeenCalledTimes(1);
      const args = pushSpy.mock.calls[0][0];
      expect(args).toMatchObject({ workspaceId: 'ws-1', boardId: 'board-a', periodKey: '20260116-0900' });
      // The documents the run actually generated, not a re-derivation.
      expect(args.documents).toHaveLength(1);
      expect(args.documents[0].invoiceNumber).toBe('IN-900 (ISO+™)');
    });

    // Same guarantee composeAndDeliver already makes for email: deliverability
    // is settled before anything irreversible happens, so a workspace that
    // picked "accounting" without connecting Xero does not mint invoice
    // numbers for PDFs nobody will ever receive.
    it('accounting with Xero not connected: generates nothing, sends nothing, pushes nothing', async () => {
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        invoice: { enabled: true, sendMethod: 'accounting', emailSubject: 'Invoice run' },
      });
      await seedWorkerNdisBoard();
      const genSpy = vi.spyOn(generateDocuments, 'generateInvoicesForBoard');
      const pushSpy = vi.spyOn(pushXero, 'pushDraftInvoicesToXero');
      const deliverSpy = vi.spyOn(outbox, 'deliverEmail');
      startAutomationWorker();

      // Resolves rather than throws: only a human can connect Xero, so three
      // BullMQ attempts would just repeat the same log.
      await expect(registeredHandler()(JOB)).resolves.toBeUndefined();

      expect(genSpy).not.toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalled();
      expect(deliverSpy).not.toHaveBeenCalled();
      const business = await Business.findOne({ workspaceId: 'ws-1' }).lean();
      expect(business.documentNumbering.invoice.nextNumber).toBe(900);
      expect(await InvoiceNumber.countDocuments({ workspaceId: 'ws-1' })).toBe(0);
    });

    // Xero has no statement to create here, and the Send Method select is
    // rendered from one shared component for both blocks. A statement run
    // emails whatever the block says.
    it('a statement block set to accounting still emails', async () => {
      await AutomationSettings.create({
        workspaceId: 'ws-1',
        statement: { enabled: true, sendMethod: 'accounting', emailSubject: 'Statements' },
      });
      await cleanupWorkerNdisBoard();
      await Business.create({
        workspaceId: 'ws-1', name: 'Worker Stmt Biz', abn: '11 111 111 111',
        address: { street: '1 St', suburb: 'S', state: 'NSW', postcode: '2000', country: 'AU' },
        bankDetails: { accountName: 'A', bankName: 'B', bsb: '123456', accountNumber: '1234567' },
        documentNumbering: { invoice: { prefix: 'IN-', nextNumber: 1 }, quote: { prefix: 'QT-', nextNumber: 1 }, purchaseOrder: { prefix: 'PO-', nextNumber: 1 } },
      });
      await Board.create({
        workspaceId: 'ws-1', boardId: 'board-a', name: 'CM Board', label: 'Care Management',
      });
      await Item.create({
        workspaceId: 'ws-1', boardId: 'board-a', folderId: 'f-p', itemId: 'p-1',
        data: { 'Full Name/Preferred Name': 'Alex Rivers' },
      });
      const pushSpy = vi.spyOn(pushXero, 'pushDraftInvoicesToXero');
      startAutomationWorker();

      const statementJob = { data: { ...JOB.data, kind: 'statement_automation' } };
      await registeredHandler()(statementJob);

      expect(pushSpy).not.toHaveBeenCalled();
      const written = JSON.parse(readFileSync(
        join(root, outboxKeyFor({ ...statementJob.data, recipientKey: 'Alex Rivers' })), 'utf8',
      ));
      expect(written.attachments).toHaveLength(1);
    });
  });
});
