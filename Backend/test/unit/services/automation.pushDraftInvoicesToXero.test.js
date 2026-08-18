import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  createInvoice,
  ensureAuthenticated,
  configure,
  getContactByEmail,
  createOrUpdateContact,
  isAccountTaxRateMatched,
  getAccounts,
  getTaxRates,
} = vi.hoisted(() => ({
  createInvoice: vi.fn(),
  ensureAuthenticated: vi.fn(),
  configure: vi.fn(),
  getContactByEmail: vi.fn(),
  createOrUpdateContact: vi.fn(),
  isAccountTaxRateMatched: vi.fn(),
  getAccounts: vi.fn(),
  getTaxRates: vi.fn(),
}));

vi.mock('../../../src/services/xero.js', () => ({
  createInvoice,
  ensureAuthenticated,
  configure,
  getContactByEmail,
  createOrUpdateContact,
  isAccountTaxRateMatched,
  getAccounts,
  getTaxRates,
}));

import Business from '../../../src/models/Business.js';
import Item from '../../../src/models/Item.js';
import PDFLink from '../../../src/models/PDFLink.js';
import { pushDraftInvoicesToXero } from '../../../src/services/automation/pushDraftInvoicesToXero.js';
import { automationPeriodKey } from '../../../src/utils/automationPeriodKey.js';

const WS = 'ws-xero-auto';
const BOARD = 'board-xero-auto';
const SLOT = new Date('2026-08-14T05:09:00.000Z');
const TZ = 'Australia/Sydney';
const PERIOD = automationPeriodKey({ slot: SLOT, timezone: TZ });
const CONTACT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

async function seed({ integrated = true } = {}) {
  await Promise.all([
    Business.deleteMany({ workspaceId: WS }),
    Item.deleteMany({ workspaceId: WS }),
    PDFLink.deleteMany({ workspaceId: WS }),
  ]);
  await Business.create({
    workspaceId: WS,
    name: 'Xero Auto Biz',
    xeroIntegrated: integrated,
    xeroTenantId: integrated ? 'tenant-1' : undefined,
    xeroTokens: integrated
      ? { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() / 1000 + 3600 }
      : undefined,
    documentNumbering: {
      invoice: { prefix: 'IN-', nextNumber: 700 },
      quote: { prefix: 'QT-', nextNumber: 1 },
      purchaseOrder: { prefix: 'PO-', nextNumber: 1 },
    },
  });
  await Item.create({
    workspaceId: WS, boardId: BOARD, folderId: 'f', itemId: 'auto-1',
    data: {
      'Recipient of the Quote': 'Jordan Fixture',
      'Recipient Email': 'jordan@example.test',
      'Recipient Address': '2 Sample Road',
      Suburb: 'Testville', State: 'NSW', Postcode: '2000',
      'Quantity (Direct Support)': 4,
      'Unit Price for Direct Support($)': 67.56,
      'Unit (Direct Support)': 'Hour',
    },
  });
}

async function seedPdfLink(itemId, invoiceNumber = 'IN-700 (ISO+™)') {
  await PDFLink.create({
    workspaceId: WS,
    itemId,
    type: 'Participant Tax Invoice',
    periodKey: PERIOD,
    invoiceNumber,
    pdfLink: `https://example.test/${itemId}.pdf`,
    createdBy: '',
    isDeleted: false,
    SignatureStatus: 'Unsigned',
  });
}

describe('pushDraftInvoicesToXero', () => {
  const saved = {};
  let root;

  beforeEach(async () => {
    saved.ISOPLUS_OFFLINE = process.env.ISOPLUS_OFFLINE;
    saved.LOCAL_FILE_ROOT = process.env.LOCAL_FILE_ROOT;
    process.env.ISOPLUS_OFFLINE = '1';
    root = mkdtempSync(join(tmpdir(), 'push-xero-drafts-'));
    process.env.LOCAL_FILE_ROOT = root;
    vi.clearAllMocks();
    ensureAuthenticated.mockResolvedValue({ tenantId: 'tenant-1' });
    getAccounts.mockResolvedValue([{ Type: 'REVENUE', Code: '200' }]);
    getTaxRates.mockResolvedValue([]);
    isAccountTaxRateMatched.mockResolvedValue(true);
    getContactByEmail.mockResolvedValue({ contactID: CONTACT_ID });
    createInvoice.mockResolvedValue({ invoiceID: 'inv-xero-1', invoiceNumber: 'INV-0001' });
    await seed();
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

  it('creates one DRAFT per billable item and stores the Xero id', async () => {
    await seedPdfLink('auto-1');
    const results = await pushDraftInvoicesToXero({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD,
    });

    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect(createInvoice.mock.calls[0][0].status).toBe('DRAFT');
    expect(createInvoice.mock.calls[0][0].reference).toBe('IN-700 (ISO+™)');
    expect(results[0]).toMatchObject({
      itemId: 'auto-1',
      invoiceNumber: 'IN-700 (ISO+™)',
      xeroInvoiceId: 'inv-xero-1',
      xeroInvoiceNumber: 'INV-0001',
    });
    const link = await PDFLink.findOne({
      workspaceId: WS, itemId: 'auto-1', periodKey: PERIOD,
    }).lean();
    expect(link.xeroInvoiceId).toBe('inv-xero-1');
  });

  it('skips an item that already has xeroInvoiceId', async () => {
    await seedPdfLink('auto-1');
    await PDFLink.updateOne(
      { workspaceId: WS, itemId: 'auto-1', periodKey: PERIOD },
      { $set: { xeroInvoiceId: 'already', xeroInvoiceNumber: 'INV-OLD' } },
    );

    await pushDraftInvoicesToXero({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD,
    });

    expect(createInvoice).not.toHaveBeenCalled();
  });

  it('throws when the PDF is missing and does not create', async () => {
    await expect(pushDraftInvoicesToXero({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD,
    })).rejects.toThrow(/PDF missing/);
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it('throws when Xero is not connected', async () => {
    await seed({ integrated: false });
    await seedPdfLink('auto-1');

    await expect(pushDraftInvoicesToXero({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD,
    })).rejects.toThrow(/not connected/i);
    expect(createInvoice).not.toHaveBeenCalled();
  });

  // The PDFLink fallback lookup interpolates an ISO+-sourced itemId straight
  // into a $regex. ISO+ item ids are free text, so one containing a regex
  // metacharacter is either a syntax error Mongo rejects outright — failing the
  // whole board's Xero push — or, worse, a pattern that matches a different
  // PDF and attaches the wrong participant's invoice to a Xero draft.
  it('treats an itemId with regex metacharacters as a literal in the PDF fallback', async () => {
    const oddId = 'auto[1';
    await Item.create({
      workspaceId: WS, boardId: BOARD, folderId: 'f', itemId: oddId,
      data: {
        'Recipient of the Quote': 'Bracket Fixture',
        'Recipient Email': 'bracket@example.test',
        'Recipient Address': '4 Sample Road',
        Suburb: 'Testville', State: 'NSW', Postcode: '2000',
        'Quantity (Direct Support)': 1,
        'Unit Price for Direct Support($)': 10,
        'Unit (Direct Support)': 'Hour',
      },
    });
    await Item.deleteMany({ workspaceId: WS, itemId: 'auto-1' });
    // No periodKey on the link, so the lookup must fall through to the regex.
    await PDFLink.create({
      workspaceId: WS,
      itemId: oddId,
      type: 'Participant Tax Invoice',
      invoiceNumber: 'IN-702 (ISO+™)',
      pdfLink: `https://example.test/${oddId}-${PERIOD}.pdf`,
      createdBy: '',
      isDeleted: false,
      SignatureStatus: 'Unsigned',
    });

    const results = await pushDraftInvoicesToXero({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ itemId: oddId, invoiceNumber: 'IN-702 (ISO+™)' });
  });

  it('propagates createInvoice failure after persisting earlier items', async () => {
    await Item.create({
      workspaceId: WS, boardId: BOARD, folderId: 'f', itemId: 'auto-2',
      data: {
        'Recipient of the Quote': 'Sam Fixture',
        'Recipient Email': 'sam@example.test',
        'Recipient Address': '3 Sample Road',
        Suburb: 'Testville', State: 'VIC', Postcode: '3000',
        'Quantity (Direct Support)': 2,
        'Unit Price for Direct Support($)': 62.17,
        'Unit (Direct Support)': 'Hour',
      },
    });
    await seedPdfLink('auto-1');
    await seedPdfLink('auto-2', 'IN-701 (ISO+™)');
    createInvoice
      .mockResolvedValueOnce({ invoiceID: 'inv-xero-1', invoiceNumber: 'INV-0001' })
      .mockRejectedValueOnce(new Error('Xero 500'));

    await expect(pushDraftInvoicesToXero({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD,
    })).rejects.toThrow('Xero 500');
    const first = await PDFLink.findOne({
      workspaceId: WS, itemId: 'auto-1', periodKey: PERIOD,
    }).lean();
    const second = await PDFLink.findOne({
      workspaceId: WS, itemId: 'auto-2', periodKey: PERIOD,
    }).lean();
    expect(first.xeroInvoiceId).toBe('inv-xero-1');
    expect(second.xeroInvoiceId).toBeFalsy();
  });
});
