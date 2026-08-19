import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The shipping Invoice Generator → Xero handler is the thing under
// orchestration, not the thing under test, and it is the only door to the Xero
// SDK on this path. Mocking it here is what guarantees no test in this file can
// reach the network.
const { handleXeroInvoicendisInvoiceGenerator, handleXeroInvoiceParticipantTax } = vi.hoisted(() => ({
  handleXeroInvoicendisInvoiceGenerator: vi.fn(),
  handleXeroInvoiceParticipantTax: vi.fn(),
}));

vi.mock('../../../src/utils/xeroNdisRouteHandlers.js', () => ({
  handleXeroInvoicendisInvoiceGenerator,
  handleXeroInvoicendis: vi.fn(),
  handleXeroQuotendis: vi.fn(),
  handleXeroInvoiceParticipantTax,
  parseInvoiceGeneratorMasterItemIds: vi.fn(),
}));

// The Age Care push re-reads the Invoice Generator rows for the slot rather
// than being handed them, so a replay and a retry behave like the first
// attempt. Stubbed here: what this suite tests is the routing and the shape
// handed over, not the list helper, which has its own suite.
const { getInvoiceGeneratorData } = vi.hoisted(() => ({ getInvoiceGeneratorData: vi.fn() }));
vi.mock('../../../src/utils/invoiceGeneratorRouteHelpers.js', () => ({ getInvoiceGeneratorData }));

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

  // This used to assert the opposite, and the refusal was the gap rather than
  // the guard: an Age Care board with sendMethod 'accounting' generated
  // nothing, month after month, with a line in the log the client never sees.
  // The Age Care handler wants the Invoice Generator's own row objects, which
  // are now re-read for the slot — so both branches are wired and both pass.
  it('passes for an Age Care board too, now that its rows are re-read', async () => {
    await seedBoard('Care Management');

    expect(await xeroDeliveryPreflight({ workspaceId: WS, boardId: BOARD }))
      .toEqual({ ok: true });
  });

  it('passes for the low-cat Age Care variant', async () => {
    await seedBoard('Care Management - SaH - Low Cat');

    expect((await xeroDeliveryPreflight({ workspaceId: WS, boardId: BOARD })).ok).toBe(true);
  });

  // A board with no generator has nothing to push, so it is still refused —
  // before generation, which is what stops a slot minting invoice numbers for
  // documents this path cannot deliver.
  it('fails on a board neither generator serves', async () => {
    await seedBoard('Library');

    const result = await xeroDeliveryPreflight({ workspaceId: WS, boardId: BOARD });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Care Management/);
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

/**
 * The Age Care branch. `sendMethod: 'accounting'` on an Age Care board used to
 * generate nothing at all — the preflight refused every non-NDIS board, so a
 * workspace that chose "Send from Accounting Platform" got an error line in the
 * log and no invoices, month after month.
 *
 * The two handlers differ in what they need: the NDIS one rebuilds everything
 * from item ids, the Age Care one builds its Xero lines from the Invoice
 * Generator's own row objects. Those rows are re-read for the slot rather than
 * carried out of generation, so a retry behaves like the first attempt.
 */
describe('pushDraftInvoicesToXero, Age Care boards', () => {
  const AGE_CARE_INVOICE = 'IN-800 (ISO+™)';

  function generatorRow(id, overrides = {}) {
    return {
      id,
      participant: 'Sam Rivers',
      service: 'Assistance With Self-Care',
      quantity: 2,
      unitPrice: 65.5,
      totalAmount: 131,
      participantContribution: 25.75,
      gst: 'GST Free',
      transactionStatus: 'Delivered - To be claimed and invoiced.',
      serviceDeliveryDate: '2026-08-04',
      ...overrides,
    };
  }

  async function seedAgeCareLinks(itemIds) {
    await Promise.all(itemIds.map((itemId) => PDFLink.create({
      workspaceId: WS,
      boardId: BOARD,
      itemId,
      type: 'Participant Tax Invoice',
      periodKey: PERIOD,
      invoiceNumber: AGE_CARE_INVOICE,
      participant: 'Sam Rivers',
      pdfLink: `https://example.test/${AGE_CARE_INVOICE}.pdf`,
      createdBy: '',
      isDeleted: false,
      SignatureStatus: 'Unsigned',
    })));
  }

  const pushAgeCare = () => pushDraftInvoicesToXero({
    workspaceId: WS,
    boardId: BOARD,
    slot: SLOT,
    timezone: TZ,
    schedule: { every: { n: 1, unit: 'month' } },
    periodKey: PERIOD,
    documents: [{
      itemId: 'ac-1',
      invoiceNumber: AGE_CARE_INVOICE,
      participant: 'Sam Rivers',
      pdfUrl: `https://example.test/${AGE_CARE_INVOICE}.pdf`,
    }],
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    handleXeroInvoiceParticipantTax.mockImplementation(async ({ res }) =>
      res.json({ invoiceNumber: 'INV-0042', invoiceUrl: 'https://xero.test/42' }));
    getInvoiceGeneratorData.mockResolvedValue({
      items: [generatorRow('ac-1'), generatorRow('ac-2'), generatorRow('other-board-row')],
      total: 3,
    });
    await seedBoard('Care Management');
    await seedBusiness();
  });

  afterEach(async () => {
    await Promise.all([
      Business.deleteMany({ workspaceId: WS }),
      Board.deleteMany({ boardId: BOARD }),
      PDFLink.deleteMany({ workspaceId: WS }),
    ]);
  });

  it('pushes through the Age Care handler, not the NDIS one', async () => {
    await seedAgeCareLinks(['ac-1', 'ac-2']);

    const results = await pushAgeCare();

    expect(handleXeroInvoicendisInvoiceGenerator).not.toHaveBeenCalled();
    expect(handleXeroInvoiceParticipantTax).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      { invoiceNumber: AGE_CARE_INVOICE, xeroInvoiceNumber: 'INV-0042' },
    ]);
  });

  // The handler builds its lines from these rows, so it has to receive the row
  // objects — not the item ids the NDIS handler takes.
  it('hands over the generator rows this invoice covers, and only those', async () => {
    await seedAgeCareLinks(['ac-1', 'ac-2']);

    await pushAgeCare();

    const { req } = handleXeroInvoiceParticipantTax.mock.calls[0][0];
    expect(req.body.items.map((row) => row.id)).toEqual(['ac-1', 'ac-2']);
    expect(req.body.items[0]).toMatchObject({ quantity: 2, unitPrice: 65.5, gst: 'GST Free' });
    expect(req.body.participantName).toBe('Sam Rivers');
    // Dated on the claimed slot, matching the PDF, not on whenever the worker
    // drained the queue.
    expect(req.body.invoiceDate).toBe(SLOT.toISOString());
    expect(req.body.dueDate).toBe('2026-08-28T05:09:00.000Z');
  });

  it('reads the rows for the same window generation used', async () => {
    await seedAgeCareLinks(['ac-1']);

    await pushAgeCare();

    const [{ query }] = getInvoiceGeneratorData.mock.calls[0];
    // 'all', not 'pending': by push time the rows carry invoice numbers, so a
    // pending list would be empty and nothing would ever be pushed.
    expect(query.status).toBe('all');
    expect(query.limit).toBe('all');
    expect(query.serviceDeliveryStart).toBeTruthy();
  });

  it('tells the handler when the board is the low-cat variant', async () => {
    await seedBoard('Care Management - SaH - Low Cat');
    await seedAgeCareLinks(['ac-1']);

    await pushAgeCare();

    expect(handleXeroInvoiceParticipantTax.mock.calls[0][0].req.body.isLowCat).toBe(true);
  });

  it('does not mark it low-cat for an ordinary Age Care board', async () => {
    await seedAgeCareLinks(['ac-1']);

    await pushAgeCare();

    expect(handleXeroInvoiceParticipantTax.mock.calls[0][0].req.body.isLowCat).toBe(false);
  });

  it('lists once for the whole board, not once per invoice', async () => {
    await seedAgeCareLinks(['ac-1']);
    await PDFLink.create({
      workspaceId: WS, boardId: BOARD, itemId: 'ac-2', type: 'Participant Tax Invoice',
      periodKey: PERIOD, invoiceNumber: 'IN-801 (ISO+™)', participant: 'Dana Cole',
      pdfLink: 'https://example.test/IN-801.pdf', createdBy: '', isDeleted: false,
      SignatureStatus: 'Unsigned',
    });

    await pushDraftInvoicesToXero({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ,
      schedule: { every: { n: 1, unit: 'month' } }, periodKey: PERIOD,
      documents: [
        { itemId: 'ac-1', invoiceNumber: AGE_CARE_INVOICE, participant: 'Sam Rivers' },
        { itemId: 'ac-2', invoiceNumber: 'IN-801 (ISO+™)', participant: 'Dana Cole' },
      ],
    });

    expect(handleXeroInvoiceParticipantTax).toHaveBeenCalledTimes(2);
    expect(getInvoiceGeneratorData).toHaveBeenCalledTimes(1);
  });

  it('records the Xero number on the invoice PDFLink rows', async () => {
    await seedAgeCareLinks(['ac-1', 'ac-2']);

    await pushAgeCare();

    const links = await PDFLink.find({ workspaceId: WS, invoiceNumber: AGE_CARE_INVOICE }).lean();
    expect(links.every((link) => link.xeroInvoiceNumber === 'INV-0042')).toBe(true);
  });

  it('creates no second draft when the slot is replayed', async () => {
    await seedAgeCareLinks(['ac-1']);
    await pushAgeCare();
    handleXeroInvoiceParticipantTax.mockClear();

    expect(await pushAgeCare()).toEqual([]);
    expect(handleXeroInvoiceParticipantTax).not.toHaveBeenCalled();
  });

  // The handler answers its own failures with a 200 carrying {message}, so a
  // caller that only awaits it would mark the run green with nothing in Xero.
  it('throws when the handler answers without an invoice number', async () => {
    await seedAgeCareLinks(['ac-1']);
    handleXeroInvoiceParticipantTax.mockImplementation(async ({ res }) =>
      res.status(400).json({ message: 'There is nothing to invoice!' }));

    await expect(pushAgeCare()).rejects.toThrow(/nothing to invoice/);
    const link = await PDFLink.findOne({ workspaceId: WS, itemId: 'ac-1' }).lean();
    expect(link.xeroInvoiceNumber).toBeFalsy();
  });

  // Pushing a draft built from no rows would create an empty invoice in the
  // client's accountant's Xero, which is worse than failing the job.
  it('throws rather than pushing an invoice whose generator rows have gone', async () => {
    await seedAgeCareLinks(['ac-1']);
    getInvoiceGeneratorData.mockResolvedValue({ items: [generatorRow('someone-else')], total: 1 });

    await expect(pushAgeCare()).rejects.toThrow(/no Invoice Generator rows/i);
    expect(handleXeroInvoiceParticipantTax).not.toHaveBeenCalled();
  });

  it('throws when the generator list itself fails', async () => {
    await seedAgeCareLinks(['ac-1']);
    getInvoiceGeneratorData.mockResolvedValue({ error: { body: { message: 'board unreachable' } } });

    await expect(pushAgeCare()).rejects.toThrow(/board unreachable/);
  });

  // The same tripwire generation carries: pushing part of a period would put a
  // draft in Xero that reads as the whole month's invoice.
  it('refuses a truncated generator list', async () => {
    await seedAgeCareLinks(['ac-1']);
    getInvoiceGeneratorData.mockResolvedValue({ items: [generatorRow('ac-1')], total: 1500 });

    await expect(pushAgeCare()).rejects.toThrow(/refusing to bill part of a period/);
  });

  it('does not list at all for an NDIS board', async () => {
    await seedBoard('Care Management - NDIS');
    await seedLinks(['m-1']);

    await push();

    expect(getInvoiceGeneratorData).not.toHaveBeenCalled();
  });
});
