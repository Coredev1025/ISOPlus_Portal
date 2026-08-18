import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The shipping Invoice Generator → Xero handler is the thing under
// orchestration, not the thing under test, and it is the only door to the Xero
// SDK on this path. Mocking it here is what guarantees no test in this file can
// reach the network.
const { handleXeroInvoicendisInvoiceGenerator } = vi.hoisted(() => ({
  handleXeroInvoicendisInvoiceGenerator: vi.fn(),
}));

vi.mock('../../../src/utils/xeroNdisRouteHandlers.js', () => ({
  handleXeroInvoicendisInvoiceGenerator,
  handleXeroInvoicendis: vi.fn(),
  handleXeroQuotendis: vi.fn(),
  handleXeroInvoiceParticipantTax: vi.fn(),
  parseInvoiceGeneratorMasterItemIds: vi.fn(),
}));

import Board from '../../../src/models/Board.js';
import Business from '../../../src/models/Business.js';
import PDFLink from '../../../src/models/PDFLink.js';
import {
  pushDraftInvoicesToXero,
  xeroDeliveryPreflight,
} from '../../../src/services/automation/pushDraftInvoicesToXero.js';
import { PDFLINK_TYPE_NDIS_INVOICE } from '../../../src/constants/automation.js';

const WS = 'ws-xero-auto';
const BOARD = 'board-xero-auto';
const PERIOD = '20260814-0900';
const SLOT = new Date('2026-08-14T05:09:00.000Z');
const TZ = 'Australia/Sydney';
const INVOICE = 'IN-700 (ISO+™)';

async function seedBusiness({ integrated = true, token = 'a' } = {}) {
  await Business.deleteMany({ workspaceId: WS });
  await Business.create({
    workspaceId: WS,
    name: 'Xero Auto Biz',
    xeroIntegrated: integrated,
    xeroTenantId: 'tenant-1',
    xeroTokens: token ? { accessToken: token, refreshToken: 'r' } : undefined,
    bankDetails: { accountsReceivableTerms: '14 days' },
  });
}

async function seedBoard(label = 'Care Management - NDIS') {
  await Board.deleteMany({ boardId: BOARD });
  await Board.create({ workspaceId: WS, boardId: BOARD, name: 'B', label });
}

async function seedLinks(itemIds, invoiceNumber = INVOICE) {
  await Promise.all(itemIds.map((itemId) => PDFLink.create({
    workspaceId: WS,
    boardId: BOARD,
    itemId,
    type: PDFLINK_TYPE_NDIS_INVOICE,
    periodKey: PERIOD,
    invoiceNumber,
    participant: 'Sam Rivers',
    pdfLink: `https://example.test/${invoiceNumber}.pdf`,
    createdBy: '',
    isDeleted: false,
    SignatureStatus: 'Unsigned',
  })));
}

function documents(invoiceNumber = INVOICE) {
  return [{
    itemId: 'm-1',
    invoiceNumber,
    participant: 'Sam Rivers',
    pdfUrl: `https://example.test/${invoiceNumber}.pdf`,
  }];
}

function push(docs = documents()) {
  return pushDraftInvoicesToXero({
    workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ,
    periodKey: PERIOD, documents: docs,
  });
}

describe('xeroDeliveryPreflight', () => {
  beforeEach(async () => {
    await seedBoard();
    await seedBusiness();
  });

  afterEach(async () => {
    await Promise.all([
      Business.deleteMany({ workspaceId: WS }),
      Board.deleteMany({ boardId: BOARD }),
      PDFLink.deleteMany({ workspaceId: WS }),
    ]);
  });

  it('passes for an NDIS board whose workspace holds a Xero access token', async () => {
    expect(await xeroDeliveryPreflight({ workspaceId: WS, boardId: BOARD }))
      .toEqual({ ok: true });
  });

  // The client chose "Send from Accounting Platform". Falling back to email
  // would send the document they asked us not to send; throwing would burn
  // three BullMQ attempts against a connection that only a human can restore.
  it('fails, without throwing, when Xero is not connected', async () => {
    await seedBusiness({ integrated: false });

    const result = await xeroDeliveryPreflight({ workspaceId: WS, boardId: BOARD });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not connected/i);
  });

  it('fails when the workspace has no business record at all', async () => {
    await Business.deleteMany({ workspaceId: WS });

    expect((await xeroDeliveryPreflight({ workspaceId: WS, boardId: BOARD })).ok).toBe(false);
  });

  // Age Care invoices are pushed by a different shipping handler, which needs
  // the Invoice Generator's own row objects rather than the item ids PDFLink
  // stores. Refusing before generation is what stops a slot minting invoice
  // numbers for documents this path cannot deliver.
  it('fails on a non-NDIS board rather than pushing the wrong shape', async () => {
    await seedBoard('Care Management');

    const result = await xeroDeliveryPreflight({ workspaceId: WS, boardId: BOARD });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/NDIS/);
  });
});

describe('pushDraftInvoicesToXero', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    handleXeroInvoicendisInvoiceGenerator.mockImplementation(async ({ res }) =>
      res.json({ invoiceNumber: 'INV-0001', invoiceUrl: 'https://xero.test/1' }));
    await seedBoard();
    await seedBusiness();
  });

  afterEach(async () => {
    await Promise.all([
      Business.deleteMany({ workspaceId: WS }),
      Board.deleteMany({ boardId: BOARD }),
      PDFLink.deleteMany({ workspaceId: WS }),
    ]);
  });

  it('creates one DRAFT per generated invoice, carrying every covered master item', async () => {
    await seedLinks(['m-1', 'm-2']);

    const results = await push();

    expect(handleXeroInvoicendisInvoiceGenerator).toHaveBeenCalledTimes(1);
    const call = handleXeroInvoicendisInvoiceGenerator.mock.calls[0][0];
    expect(call.workspaceId).toBe(WS);
    expect(call.boardId).toBe(BOARD);
    expect(call.req.body.itemIds.sort()).toEqual(['m-1', 'm-2']);
    expect(call.req.body.participantName).toBe('Sam Rivers');
    // The draft is dated on the claimed slot, matching the PDF, not on now.
    expect(call.req.body.invoiceDate).toBe(SLOT.toISOString());
    expect(call.req.body.dueDate).toBe('2026-08-28T05:09:00.000Z');
    expect(results).toEqual([{ invoiceNumber: INVOICE, xeroInvoiceNumber: 'INV-0001' }]);
  });

  it('records the Xero number on every PDFLink row of that invoice', async () => {
    await seedLinks(['m-1', 'm-2']);

    await push();

    const links = await PDFLink.find({ workspaceId: WS, invoiceNumber: INVOICE }).lean();
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.xeroInvoiceNumber === 'INV-0001')).toBe(true);
  });

  // A replayed slot re-reads the PDFs it already generated and hands the worker
  // the same documents. Without this the accountant gets a second draft for an
  // invoice they have already seen.
  it('creates no second draft when the slot is replayed', async () => {
    await seedLinks(['m-1', 'm-2']);
    await push();
    handleXeroInvoicendisInvoiceGenerator.mockClear();

    const results = await push();

    expect(handleXeroInvoicendisInvoiceGenerator).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  // The shipping handler answers 200 with {message} on failure, so a caller
  // that only awaits it cannot tell success from failure. A swallowed failure
  // would mark the run green with nothing in Xero.
  it('throws when the handler answers without an invoice number', async () => {
    await seedLinks(['m-1']);
    handleXeroInvoicendisInvoiceGenerator.mockImplementation(async ({ res }) =>
      res.status(200).json({ message: 'Account code and Tax rate is not matched' }));

    await expect(push()).rejects.toThrow(/Account code and Tax rate is not matched/);
    const link = await PDFLink.findOne({ workspaceId: WS, itemId: 'm-1' }).lean();
    expect(link.xeroInvoiceNumber).toBeFalsy();
  });

  it('throws rather than pushing an invoice whose PDFLink rows are missing', async () => {
    await expect(push()).rejects.toThrow(/no PDFLink rows/i);
    expect(handleXeroInvoicendisInvoiceGenerator).not.toHaveBeenCalled();
  });

  it('touches Xero for nothing when the run generated nothing', async () => {
    expect(await push([])).toEqual([]);
    expect(handleXeroInvoicendisInvoiceGenerator).not.toHaveBeenCalled();
  });
});
