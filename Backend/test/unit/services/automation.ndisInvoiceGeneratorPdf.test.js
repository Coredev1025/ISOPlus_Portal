import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import Business from '../../../src/models/Business.js';
import Item from '../../../src/models/Item.js';
import InvoiceNumber from '../../../src/models/InvoiceNumber.js';
import { generateNdisInvoiceGeneratorPdf } from '../../../src/services/automation/ndisInvoiceGeneratorPdf.js';

const WS = 'ws-ndis-pdf';
const BOARD = 'board-ndis-pdf';
const SP_ID = '11111111-aaaa-4111-8111-111111111111';
const PP_ID = '22222222-aaaa-4111-8111-222222222222';
const SUPPORT_CAT_ID = '66666666-aaaa-4111-8111-666666666666';
const MASTER_ID = 'mp-ndis-1';

async function seedGeneratorItems() {
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
      'Scheduled Shift Start Date & Time': '2026-01-14T21:00:00.000Z',
      'Actual Shift Start Date and Time': '2026-01-14T22:00:00.000Z',
      'Actual Shift End Date and Time': '2026-01-15T00:30:00.000Z',
      'Actual Shift Duration(Hr.)': '2.5',
      'Direct Support Value($) - Time Based Support': '175.00',
    },
  });
}

describe('generateNdisInvoiceGeneratorPdf', () => {
  const saved = {};
  let root;

  beforeEach(async () => {
    saved.ISOPLUS_OFFLINE = process.env.ISOPLUS_OFFLINE;
    saved.LOCAL_FILE_ROOT = process.env.LOCAL_FILE_ROOT;
    process.env.ISOPLUS_OFFLINE = '1';
    root = mkdtempSync(join(tmpdir(), 'ndis-inv-pdf-'));
    process.env.LOCAL_FILE_ROOT = root;

    await Promise.all([
      Business.deleteMany({ workspaceId: WS }),
      Item.deleteMany({ workspaceId: WS }),
      InvoiceNumber.deleteMany({ workspaceId: WS }),
    ]);
    await Business.create({
      workspaceId: WS,
      name: 'NDIS Pdf Biz',
      abn: '12 345 678 901',
      address: { street: '1 St', suburb: 'S', state: 'NSW', postcode: '2000', country: 'Australia' },
      bankDetails: { accountName: 'A', bankName: 'B', bsb: '123456', accountNumber: '1234567' },
      documentNumbering: {
        invoice: { prefix: 'IN-', nextNumber: 40 },
        quote: { prefix: 'QT-', nextNumber: 1 },
        purchaseOrder: { prefix: 'PO-', nextNumber: 1 },
      },
    });
    await seedGeneratorItems();
  });

  afterEach(async () => {
    process.env.ISOPLUS_OFFLINE = saved.ISOPLUS_OFFLINE;
    process.env.LOCAL_FILE_ROOT = saved.LOCAL_FILE_ROOT;
    rmSync(root, { recursive: true, force: true });
    await Promise.all([
      Business.deleteMany({ workspaceId: WS }),
      Item.deleteMany({ workspaceId: WS }),
      InvoiceNumber.deleteMany({ workspaceId: WS }),
    ]);
  });

  it('renders an Invoice Generator PDF, numbers it, and marks the master item invoiced', async () => {
    const result = await generateNdisInvoiceGeneratorPdf({
      workspaceId: WS,
      boardId: BOARD,
      masterItemIds: [MASTER_ID],
      invoiceDate: '2026-08-14T09:00:00.000Z',
      dueDate: '2026-08-28T09:00:00.000Z',
    });

    expect(result.empty).toBeFalsy();
    expect(result.invoiceNumber).toBe('IN-40 (ISO+™)');
    expect(result.fileUrl).toContain('/api/local-files/');
    expect(result.fileUrl).toContain('NDIS-invoices/');
    expect(result.fileUrl).not.toContain('/auto/');

    const stored = join(root, decodeURIComponent(result.fileUrl.split('/api/local-files/')[1]));
    expect(existsSync(stored)).toBe(true);
    expect(readFileSync(stored).subarray(0, 5).toString()).toBe('%PDF-');

    const recorded = await InvoiceNumber.findOne({ workspaceId: WS, itemId: MASTER_ID, type: 'PDF' }).lean();
    expect(recorded.invoiceNumber).toBe('IN-40 (ISO+™)');
    expect(recorded.pdfLink).toBe(result.fileUrl);

    const business = await Business.findOne({ workspaceId: WS }).lean();
    expect(business.documentNumbering.invoice.nextNumber).toBe(41);
  });
});
