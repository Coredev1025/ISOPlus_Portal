import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import Board from '../../../src/models/Board.js';
import Business from '../../../src/models/Business.js';
import Item from '../../../src/models/Item.js';
import InvoiceNumber from '../../../src/models/InvoiceNumber.js';
import PDFLink from '../../../src/models/PDFLink.js';
import { generateInvoicesForBoard } from '../../../src/services/automation/generateDocuments.js';
import { getNdisInvoiceGeneratorData } from '../../../src/utils/ndisInvoiceGeneratorRouteHelpers.js';
import { ndisInvoiceGeneratorListDeps } from '../../../src/utils/automationInvoiceGeneratorDeps.js';

const WS = 'ws-gen';
const BOARD = 'board-gen';
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
  await Item.create({
    workspaceId: WS, boardId: BOARD, folderId: 'f-master', itemId: MASTER_ID,
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

    await Promise.all([
      Business.deleteMany({ workspaceId: WS }),
      Board.deleteMany({ boardId: BOARD }),
      Item.deleteMany({ workspaceId: WS }),
      InvoiceNumber.deleteMany({ workspaceId: WS }),
      PDFLink.deleteMany({ workspaceId: WS }),
    ]);
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
    await Promise.all([
      Business.deleteMany({ workspaceId: WS }),
      Board.deleteMany({ boardId: BOARD }),
      Item.deleteMany({ workspaceId: WS }),
      InvoiceNumber.deleteMany({ workspaceId: WS }),
      PDFLink.deleteMany({ workspaceId: WS }),
    ]);
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
});
