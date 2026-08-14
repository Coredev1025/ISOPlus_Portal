// Backend/test/unit/services/automation.generateDocuments.test.js
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import Business from '../../../src/models/Business.js';
import Item from '../../../src/models/Item.js';
import PDFLink from '../../../src/models/PDFLink.js';
import {
  findBillableItems,
  generateInvoicesForBoard,
} from '../../../src/services/automation/generateDocuments.js';

// Epic 5 part 3, first slice: the scheduled engine renders real NDIS invoice
// PDFs from the billable values already stored on board items. Which items
// count as billable is a deliberate v1 contract (any quote-shaped
// quantity+price pair) — the ticket excludes the fields that would refine it.

const WS = 'ws-gen';
const BOARD = 'board-gen';
const SLOT = new Date('2026-08-14T05:09:00.000Z');
const TZ = 'Australia/Sydney';

const BILLABLE = {
  workspaceId: WS, boardId: BOARD, folderId: 'f1', itemId: 'gen-item-1',
  data: {
    'Recipient of the Quote': 'Gen Test',
    'Recipient Address': '1 Test St', Suburb: 'Testville', State: 'NSW', Postcode: '2000',
    'Direct Support Item Number': '01_011_0107_1_1',
    'Quantity (Direct Support)': 2,
    'Unit Price for Direct Support($)': 62.17,
    'Unit (Direct Support)': 'Hour',
  },
};

const NOT_BILLABLE = {
  workspaceId: WS, boardId: BOARD, folderId: 'f1', itemId: 'gen-item-2',
  data: { 'Recipient of the Quote': 'No Amounts Here' },
};

describe('generateDocuments', () => {
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
      Item.deleteMany({ workspaceId: WS }),
      PDFLink.deleteMany({ workspaceId: WS }),
    ]);
    await Business.create({
      workspaceId: WS,
      name: 'Gen Test Business',
      abn: '12 345 678 901',
      address: { street: '1 Fixture St', suburb: 'Testville', state: 'NSW', postcode: '2000', country: 'Australia' },
      bankDetails: { accountName: 'Gen', bankName: 'Test Bank', bsb: '123456', accountNumber: '12345678', accountsReceivableTerms: '14 days' },
      documentNumbering: { invoice: { prefix: 'IN-', nextNumber: 500 }, quote: { prefix: 'QT-', nextNumber: 1 }, purchaseOrder: { prefix: 'PO-', nextNumber: 1 } },
    });
    await Item.create([BILLABLE, NOT_BILLABLE]);
  });

  afterEach(async () => {
    process.env.ISOPLUS_OFFLINE = saved.ISOPLUS_OFFLINE;
    process.env.LOCAL_FILE_ROOT = saved.LOCAL_FILE_ROOT;
    rmSync(root, { recursive: true, force: true });
    await Promise.all([
      Business.deleteMany({ workspaceId: WS }),
      Item.deleteMany({ workspaceId: WS }),
      PDFLink.deleteMany({ workspaceId: WS }),
    ]);
  });

  it('selects only items carrying a billable quantity+price pair', async () => {
    const items = await findBillableItems(BOARD);
    expect(items.map((i) => i.itemId)).toEqual(['gen-item-1']);
  });

  it('renders a real invoice PDF, stores it, and records a PDFLink', async () => {
    const results = await generateInvoicesForBoard({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ,
    });

    expect(results).toHaveLength(1);
    const [r] = results;
    expect(r.invoiceNumber).toBe('IN-500');
    expect(r.pdfUrl).toContain('/api/local-files/');

    // The stored artifact is a genuine PDF, not a stub.
    const stored = join(root, decodeURIComponent(r.pdfUrl.split('/api/local-files/')[1]));
    expect(existsSync(stored)).toBe(true);
    expect(readFileSync(stored).subarray(0, 5).toString()).toBe('%PDF-');

    const link = await PDFLink.findOne({ workspaceId: WS, itemId: 'gen-item-1' }).lean();
    expect(link).toBeTruthy();
    expect(link.type).toBe('NDIS Invoice');

    const business = await Business.findOne({ workspaceId: WS }).lean();
    expect(business.documentNumbering.invoice.nextNumber).toBe(501);
  });

  // Redelivery of the same slot must not bill again: same file key, no second
  // PDFLink, and — the billing-correctness one — no second invoice number.
  it('is idempotent per slot: a re-run generates nothing new', async () => {
    await generateInvoicesForBoard({ workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ });
    const again = await generateInvoicesForBoard({ workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ });

    expect(again).toHaveLength(0);
    expect(await PDFLink.countDocuments({ workspaceId: WS })).toBe(1);
    const business = await Business.findOne({ workspaceId: WS }).lean();
    expect(business.documentNumbering.invoice.nextNumber).toBe(501);
  });

  it('a different slot generates and numbers a fresh document', async () => {
    await generateInvoicesForBoard({ workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ });
    const next = await generateInvoicesForBoard({
      workspaceId: WS, boardId: BOARD, slot: new Date('2026-09-14T05:09:00.000Z'), timezone: TZ,
    });

    expect(next).toHaveLength(1);
    expect(next[0].invoiceNumber).toBe('IN-501');
  });
});
