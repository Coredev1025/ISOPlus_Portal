import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Section 3.5 asks for the "nothing to bill" decision to be logged, so the log
// line is the behaviour under test here, not incidental noise.
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, info: vi.fn() };
});

import Board from '../../../src/models/Board.js';
import Business from '../../../src/models/Business.js';
import Item from '../../../src/models/Item.js';
import InvoiceNumber from '../../../src/models/InvoiceNumber.js';
import PDFLink from '../../../src/models/PDFLink.js';
import {
  assertListNotTruncated,
  generateInvoicesForBoard,
  invoiceGeneratorListQuery,
} from '../../../src/services/automation/generateDocuments.js';
import { GENERATOR_LIST_LIMIT } from '../../../src/constants/automation.js';
import { parseListPagination } from '../../../src/utils/itemsRouteHelpers.js';
import { getNdisInvoiceGeneratorData } from '../../../src/utils/ndisInvoiceGeneratorRouteHelpers.js';
import { ndisInvoiceGeneratorListDeps } from '../../../src/utils/automationInvoiceGeneratorDeps.js';
import { info } from '../../../src/utils/logger.js';

const WS = 'ws-gen';
const BOARD = 'board-gen';
const BOARD_B = 'board-gen-b';
const MASTER_ID_B = 'mp-gen-b-1';
const SLOT = new Date('2026-08-14T05:09:00.000Z');
const TZ = 'Australia/Sydney';
const MONTHLY = { every: { n: 1, unit: 'month' } };
const FORTNIGHTLY = { every: { n: 2, unit: 'week' } };
const SP_ID = '11111111-bbbb-4111-8111-111111111111';
const PP_ID = '22222222-bbbb-4111-8111-222222222222';
const SUPPORT_CAT_ID = '66666666-bbbb-4111-8111-666666666666';
const MASTER_ID = 'mp-gen-1';
const JULY_SHIFT = {
  scheduled: '2026-07-14T21:00:00.000Z',
  actualStart: '2026-07-14T22:00:00.000Z',
  actualEnd: '2026-07-15T00:30:00.000Z',
};
const JANUARY_SHIFT = {
  scheduled: '2026-01-14T21:00:00.000Z',
  actualStart: '2026-01-14T22:00:00.000Z',
  actualEnd: '2026-01-15T00:30:00.000Z',
};

async function seedNdisGeneratorShift(shift = JULY_SHIFT) {
  await Item.create({
    workspaceId: WS, boardId: 'cat-board', folderId: 'f-cat', itemId: SUPPORT_CAT_ID,
    data: { 'Support Item Number': '01_011_0107_1_1', 'Support Item Name': 'Assistance' },
  });
  await Item.create({
    workspaceId: WS, boardId: 'cat-board', folderId: 'f-cat', itemId: SP_ID,
    data: {
      'Direct Support Item Number': [{ id: SUPPORT_CAT_ID, name: 'Assistance' }],
      'Unit (Direct Support)': 'Hour(H)',
      'Agreed Unit Price for Direct Support ($)': '70.00',
    },
  });
  await Item.create({
    workspaceId: WS, boardId: 'cat-board', folderId: 'f-cat', itemId: PP_ID,
    data: { 'Full Name/Preferred Name': 'Samuel Rivers', 'NDIS Number': '430123456' },
  });
  await seedMasterShift(BOARD, MASTER_ID, shift);
}

async function seedMasterShift(boardId, itemId, shift = JULY_SHIFT) {
  await Item.create({
    workspaceId: WS, boardId, folderId: 'f-master', itemId,
    data: {
      'Timesheet Approval': 'Approved',
      'Job Status': 'Completed',
      'Payment Status': 'Unpaid',
      'Service Plan': [{ id: SP_ID }],
      'Participant Profile': [{ id: PP_ID }],
      'Scheduled Shift Start Date & Time': shift.scheduled,
      'Actual Shift Start Date and Time': shift.actualStart,
      'Actual Shift End Date and Time': shift.actualEnd,
      'Actual Shift Duration(Hr.)': '2.5',
      'Direct Support Value($) - Time Based Support': '175.00',
    },
  });
}

describe('generateInvoicesForBoard — Invoice Generator pipeline', () => {
  const saved = {};
  let root;

  beforeEach(async () => {
    saved.ISOPLUS_OFFLINE = process.env.ISOPLUS_OFFLINE;
    saved.LOCAL_FILE_ROOT = process.env.LOCAL_FILE_ROOT;
    process.env.ISOPLUS_OFFLINE = '1';
    root = mkdtempSync(join(tmpdir(), 'gen-docs-'));
    process.env.LOCAL_FILE_ROOT = root;

    await Business.create({
      workspaceId: WS,
      name: 'Gen Test Business',
      abn: '12 345 678 901',
      address: { street: '1 Fixture St', suburb: 'Testville', state: 'NSW', postcode: '2000', country: 'Australia' },
      bankDetails: {
        accountName: 'Gen', bankName: 'Test Bank', bsb: '123456',
        accountNumber: '12345678', accountsReceivableTerms: '14 days',
      },
      documentNumbering: {
        invoice: { prefix: 'IN-', nextNumber: 500 },
        quote: { prefix: 'QT-', nextNumber: 1 },
        purchaseOrder: { prefix: 'PO-', nextNumber: 1 },
      },
    });
    await Board.create({
      workspaceId: WS, boardId: BOARD, name: 'NDIS Board', label: 'Care Management - NDIS',
    });
  });

  afterEach(async () => {
    process.env.ISOPLUS_OFFLINE = saved.ISOPLUS_OFFLINE;
    process.env.LOCAL_FILE_ROOT = saved.LOCAL_FILE_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  it('does not invoice a quote-shaped item without an approved timesheet', async () => {
    await Item.create({
      workspaceId: WS, boardId: BOARD, folderId: 'f1', itemId: 'quote-only',
      data: {
        'Recipient of the Quote': 'Gen Test',
        'Quantity (Direct Support)': 2,
        'Unit Price for Direct Support($)': 62.17,
        'Unit (Direct Support)': 'Hour',
      },
    });

    const results = await generateInvoicesForBoard({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, schedule: MONTHLY,
    });

    expect(results).toHaveLength(0);
    expect(await InvoiceNumber.countDocuments({ workspaceId: WS })).toBe(0);
  });

  it('does not invoice a shift whose Service Delivery Date is outside the completed schedule period', async () => {
    await seedNdisGeneratorShift(JANUARY_SHIFT);

    const results = await generateInvoicesForBoard({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: '20260814-1509',
      schedule: MONTHLY,
    });

    expect(results).toHaveLength(0);
    expect(await InvoiceNumber.countDocuments({ workspaceId: WS })).toBe(0);
  });

  it('does not invoice a previous-month shift when the claimed schedule is fortnightly', async () => {
    await seedNdisGeneratorShift();

    const results = await generateInvoicesForBoard({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: '20260814-1509',
      schedule: FORTNIGHTLY,
    });

    expect(results).toHaveLength(0);
    expect(await InvoiceNumber.countDocuments({ workspaceId: WS })).toBe(0);
  });

  // Spec 3.5: a run that bills nothing must say so. Both empty-selection exits
  // returned in silence while the sibling early exits above them logged, so a
  // period that correctly had nothing to bill was indistinguishable from one
  // that selected nothing because a status alias or a date field was missing —
  // the run closes Succeeded either way. This is a recorded field trap.
  it('logs an NDIS period that selected nothing rather than closing silently', async () => {
    await seedNdisGeneratorShift(JANUARY_SHIFT);
    info.mockClear();

    const results = await generateInvoicesForBoard({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: '20260814-1509',
      schedule: MONTHLY,
    });

    expect(results).toHaveLength(0);
    expect(info).toHaveBeenCalledWith(
      'Automation',
      'No billable items for the period; no invoice and no email',
      expect.objectContaining({
        workspaceId: WS,
        boardId: BOARD,
        periodKey: '20260814-1509',
        // 'Care Management - NDIS' names neither Certification nor
        // Verification, so invoiceTypeFromBoardLabel returns null for it. The
        // log records what it actually ran under rather than inventing a type.
        invoiceType: null,
        listed: 0,
      }),
    );
  });

  it('logs an Age Care period that selected nothing rather than closing silently', async () => {
    await Board.create({
      workspaceId: WS, boardId: 'board-sah', name: 'SaH Board', label: 'Care Management - SaH',
    });
    info.mockClear();

    const results = await generateInvoicesForBoard({
      workspaceId: WS, boardId: 'board-sah', slot: SLOT, timezone: TZ, periodKey: '20260814-1509',
      schedule: MONTHLY,
    });

    expect(results).toHaveLength(0);
    expect(info).toHaveBeenCalledWith(
      'Automation',
      'No billable items for the period; no invoice and no email',
      expect.objectContaining({
        workspaceId: WS,
        boardId: 'board-sah',
        periodKey: '20260814-1509',
        invoiceType: 'sah',
        listed: 0,
      }),
    );
  });

  it('invoices pending Invoice Generator rows and writes InvoiceNumber + PDFLink', async () => {
    await seedNdisGeneratorShift();

    const results = await generateInvoicesForBoard({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: '20260814-1509',
      schedule: MONTHLY,
    });

    expect(results).toHaveLength(1);
    expect(results[0].invoiceNumber).toBe('IN-500 (ISO+™)');
    expect(results[0].pdfUrl).toContain('NDIS-invoices/');
    expect(results[0].pdfUrl).not.toContain('/auto/');

    const stored = join(root, decodeURIComponent(results[0].pdfUrl.split('/api/local-files/')[1]));
    expect(existsSync(stored)).toBe(true);
    expect(readFileSync(stored).subarray(0, 5).toString()).toBe('%PDF-');

    const recorded = await InvoiceNumber.findOne({
      workspaceId: WS, itemId: MASTER_ID, type: 'PDF',
    }).lean();
    expect(recorded.invoiceNumber).toBe('IN-500 (ISO+™)');

    const link = await PDFLink.findOne({ workspaceId: WS, itemId: MASTER_ID }).lean();
    expect(link.type).toBe('NDIS Invoice');
    expect(link.periodKey).toBe('20260814-1509');

    const business = await Business.findOne({ workspaceId: WS }).lean();
    expect(business.documentNumbering.invoice.nextNumber).toBe(501);

    const listed = await getNdisInvoiceGeneratorData(
      { workspaceId: WS, boardId: BOARD, query: { status: 'all', page: 1, limit: 1000 }, req: null },
      ndisInvoiceGeneratorListDeps(),
    );
    expect(listed.invoiced).toBeGreaterThan(0);
    expect(listed.pending).toBe(0);
    expect(listed.items[0].invoiceNumber).toBe('IN-500 (ISO+™)');
  });

  it('is idempotent per slot: a re-run reuses URLs and does not consume a second number', async () => {
    await seedNdisGeneratorShift();
    const first = await generateInvoicesForBoard({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: '20260814-1509',
      schedule: MONTHLY,
    });
    const again = await generateInvoicesForBoard({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: '20260814-1509',
      schedule: MONTHLY,
    });

    expect(again).toHaveLength(1);
    expect(again[0].pdfUrl).toBe(first[0].pdfUrl);
    expect(await InvoiceNumber.countDocuments({ workspaceId: WS, type: 'PDF' })).toBe(1);
    const business = await Business.findOne({ workspaceId: WS }).lean();
    expect(business.documentNumbering.invoice.nextNumber).toBe(501);
  });

  it('carries the participant so the email can resolve {{client_name}}', async () => {
    await seedNdisGeneratorShift();

    const results = await generateInvoicesForBoard({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: '20260814-1509',
      schedule: MONTHLY,
    });

    expect(results[0].participant).toBe('Samuel Rivers');

    // The re-run reads PDFLink rather than the generator list, so the name has
    // to be on the stored row too — otherwise a retry emails {{client_name}}.
    const again = await generateInvoicesForBoard({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: '20260814-1509',
      schedule: MONTHLY,
    });
    expect(again[0].participant).toBe('Samuel Rivers');
  });

  describe('per-board isolation at one periodKey', () => {
    // Fan-out enqueues every board in the workspace against the same slot, so
    // two boards reach this code with an identical workspaceId + periodKey.
    beforeEach(async () => {
      await Board.create({
        workspaceId: WS, boardId: BOARD_B, name: 'NDIS Board B', label: 'Care Management - NDIS',
      });
      await seedNdisGeneratorShift();
    });

    it('does not return board A PDFs from board B on an ordinary first run', async () => {
      await seedMasterShift(BOARD_B, MASTER_ID_B);

      const a = await generateInvoicesForBoard({
        workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: '20260814-1509',
        schedule: MONTHLY,
      });
      const b = await generateInvoicesForBoard({
        workspaceId: WS, boardId: BOARD_B, slot: SLOT, timezone: TZ, periodKey: '20260814-1509',
        schedule: MONTHLY,
      });

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(b[0].itemId).toBe(MASTER_ID_B);
      expect(b.map((row) => row.pdfUrl)).not.toContain(a[0].pdfUrl);

      const link = await PDFLink.findOne({ workspaceId: WS, itemId: MASTER_ID_B }).lean();
      expect(link.boardId).toBe(BOARD_B);
    });

    it('returns nothing for a board with nothing to bill, not the other board PDFs', async () => {
      const a = await generateInvoicesForBoard({
        workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: '20260814-1509',
        schedule: MONTHLY,
      });
      expect(a).toHaveLength(1);

      const b = await generateInvoicesForBoard({
        workspaceId: WS, boardId: BOARD_B, slot: SLOT, timezone: TZ, periodKey: '20260814-1509',
        schedule: MONTHLY,
      });
      expect(b).toEqual([]);
    });
  });

  describe('board label routing', () => {
    // A renamed board, an unset label, or a board deleted between fan-out and
    // processing must not silently fall through into the other product's
    // generator — different template, different pricing, different GST.
    it.each(['No Label', '', 'Support Coordination'])(
      'generates nothing for an unrecognised label %j',
      async (label) => {
        await Board.updateOne({ boardId: BOARD }, { $set: { label } });
        await seedNdisGeneratorShift();

        const results = await generateInvoicesForBoard({
          workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: '20260814-1509',
          schedule: MONTHLY,
        });

        expect(results).toEqual([]);
        expect(await InvoiceNumber.countDocuments({ workspaceId: WS })).toBe(0);
        expect(await PDFLink.countDocuments({ workspaceId: WS })).toBe(0);
      },
    );

    it('generates nothing when the board no longer exists', async () => {
      await Board.deleteMany({ boardId: BOARD });
      await seedNdisGeneratorShift();

      const results = await generateInvoicesForBoard({
        workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: '20260814-1509',
        schedule: MONTHLY,
      });

      expect(results).toEqual([]);
      expect(await InvoiceNumber.countDocuments({ workspaceId: WS })).toBe(0);
    });
  });
});

describe('pdflink-scheduled-xero-ids migration', () => {
  const INDEX_NAME = 'automation_slot_lookup';

  async function loadMigration() {
    return import('../../../migrations/1786697189409-pdflink-scheduled-xero-ids.js');
  }

  afterEach(async () => {
    await mongoose.connection.collection('pdflinks').deleteMany({});
  });

  it('up creates the index the automation slot lookup depends on', async () => {
    const { up } = await loadMigration();
    await up(mongoose.connection);

    const indexes = await mongoose.connection.collection('pdflinks').indexes();
    expect(indexes.map((index) => index.name)).toContain(INDEX_NAME);
  });

  it('down drops that index and only unsets rows an automation run wrote', async () => {
    const { up, down } = await loadMigration();
    await up(mongoose.connection);

    const collection = mongoose.connection.collection('pdflinks');
    await collection.insertMany([
      {
        workspaceId: 'ws-mig', itemId: 'i-auto', type: 'NDIS Invoice',
        pdfLink: 'https://x/auto.pdf', periodKey: '20260814-1509', invoiceNumber: 'IN-9',
      },
      {
        workspaceId: 'ws-mig', itemId: 'i-manual', type: 'NDIS Invoice',
        pdfLink: 'https://x/manual.pdf', invoiceNumber: 'IN-8',
      },
    ]);

    await down(mongoose.connection);

    const indexes = await collection.indexes();
    expect(indexes.map((index) => index.name)).not.toContain(INDEX_NAME);

    const auto = await collection.findOne({ itemId: 'i-auto' });
    expect(auto.periodKey).toBeUndefined();
    expect(auto.invoiceNumber).toBeUndefined();

    // The UI generators write invoiceNumber with no periodKey. A blanket
    // updateMany({}) would strip theirs too.
    const manual = await collection.findOne({ itemId: 'i-manual' });
    expect(manual.invoiceNumber).toBe('IN-8');
  });
});

/**
 * The list window a scheduled run asks for.
 *
 * A scheduled run has no Next button. The limit here used to be 1000 — the
 * Invoice Generator page's own page size, copied across — so a board with more
 * billable rows than that in one period had the surplus dropped: the list is
 * sorted by service date, only the first page was invoiced, and the next run's
 * window is the NEXT period, so those rows were never billed at all.
 */
describe('invoiceGeneratorListQuery', () => {
  it('asks for every row in the period rather than one page of them', () => {
    const query = invoiceGeneratorListQuery(SLOT, TZ, MONTHLY);

    // 'all' is parseListPagination's sentinel for "do not paginate".
    expect(query.limit).toBe('all');
    expect(GENERATOR_LIST_LIMIT).toBe('all');
  });

  it('keeps the deterministic ordering the invoice depends on', () => {
    const query = invoiceGeneratorListQuery(SLOT, TZ, MONTHLY);

    expect(query).toMatchObject({
      status: 'pending',
      sortBy: 'scheduledServiceDate',
      sortOrder: 'asc',
      page: 1,
    });
  });

  it('carries the caller status through, for the Age Care list that wants them all', () => {
    expect(invoiceGeneratorListQuery(SLOT, TZ, MONTHLY, { status: 'all' }).status).toBe('all');
  });

  // parseListPagination only skips pagination for 'all' or a non-positive
  // limit; any number turns it back on. Pinning the sentinel by behaviour
  // rather than by string means a rename of the constant cannot quietly
  // reintroduce a page size.
  it('sends a limit the pagination parser refuses to paginate on', () => {
    const { applyPagination } = parseListPagination(
      1,
      invoiceGeneratorListQuery(SLOT, TZ, MONTHLY).limit,
    );

    expect(applyPagination).toBe(false);
  });
});

/**
 * The tripwire behind the limit. Both helpers report `total` as the size of the
 * filtered set before pagination, so a shorter `items` means the run can only
 * see part of the period.
 */
describe('assertListNotTruncated', () => {
  const context = { boardId: 'board-x', periodKey: '20260801-0900' };

  it('passes when the rows returned are the whole filtered set', () => {
    expect(assertListNotTruncated({ items: [{}, {}], total: 2 }, context)).toBe(2);
  });

  it('passes when the helper reports no total at all', () => {
    expect(assertListNotTruncated({ items: [{}] }, context)).toBe(1);
  });

  it('passes for an empty period', () => {
    expect(assertListNotTruncated({ items: [], total: 0 }, context)).toBe(0);
  });

  // Throws rather than billing what it can see: a partial invoice reads as a
  // complete one, and the rows it omits fall outside the next run's window.
  it('refuses to bill part of a period, naming both counts', () => {
    expect(() => assertListNotTruncated({ items: [{}, {}], total: 1500 }, context))
      .toThrow(/returned 2 of 1500 rows for board board-x slot 20260801-0900/);
  });

  it('does not trip on a total smaller than the rows returned', () => {
    // Defensive: a helper that under-reports its own total is a different bug,
    // and must not stop a run that has every row it needs.
    expect(assertListNotTruncated({ items: [{}, {}], total: 1 }, context)).toBe(2);
  });
});
