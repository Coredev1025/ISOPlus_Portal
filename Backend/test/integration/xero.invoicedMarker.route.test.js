import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Section 3.3: manual invoice generation must set the same invoiced marker as
 * the automated run, or the next scheduled run finds those items unmarked and
 * bills them a second time.
 *
 * The Xero routes are a manual invoice path, and the unit tests for
 * `xeroNdisRouteHandlers` all inject `saveInvoiceNumber: vi.fn()` and assert
 * only that it was called — so nothing exercised what the router actually
 * passes in. This drives the real router, so the real collaborator runs.
 *
 * External boundaries only: the ISO+ HTTP API, the Xero SDK, and the one heavy
 * line builder that has its own tests. Everything else — including the
 * invoice-number persistence under test — runs for real against the in-memory
 * Mongo that test/setup.js starts.
 */

vi.mock('../../src/services/isoplus.js', () => ({
  setIntegrationMessage: vi.fn(async () => {}),
  setGeneratedField: vi.fn(async () => {}),
  getQuoteNDISReferencedItems: vi.fn(),
  getNDISMasterPlanReferencedItems: vi.fn(),
  validateItemBelongsToTenant: vi.fn(async () => {}),
  getJobReportingReferencedItems: vi.fn(),
  getJobPlanningReferencedItems: vi.fn(),
  getQuoteReferencedItems: vi.fn(),
  getPurchaseOrderReferencedItems: vi.fn(),
}));
vi.mock('../../src/services/xero.js', () => ({
  createInvoice: vi.fn(),
  createQuote: vi.fn(),
  createPurchaseOrder: vi.fn(),
  createOrUpdateContact: vi.fn(),
  getContactByEmail: vi.fn(),
  getContactByName: vi.fn(),
  findOrCreateItem: vi.fn(),
  refreshTokenSet: vi.fn(),
  getAccounts: vi.fn(),
  getTaxRates: vi.fn(async () => []),
  isAccountTaxRateMatched: vi.fn(async () => true),
  configure: vi.fn(async () => {}),
  ensureAuthenticated: vi.fn(async () => {}),
}));
vi.mock('../../src/utils/auditLogger.js', () => ({ logAuditTrail: vi.fn() }));
vi.mock('../../src/utils/ndisMasterPlanLineHelpers.js', async (importOriginal) => ({
  ...(await importOriginal()),
  buildNdisMasterPlanInvoiceLines: vi.fn(),
}));

const isoplus = await import('../../src/services/isoplus.js');
const xero = await import('../../src/services/xero.js');
const { buildNdisMasterPlanInvoiceLines } = await import('../../src/utils/ndisMasterPlanLineHelpers.js');
const Business = (await import('../../src/models/Business.js')).default;
const Item = (await import('../../src/models/Item.js')).default;
const InvoiceNumber = (await import('../../src/models/InvoiceNumber.js')).default;
const xeroRoutes = (await import('../../src/routes/xero.js')).default;

const WS = 'ws_1';
const BOARD = 'bd_1';
const ITEM_ID = 'itm_master_1';

const app = express();
app.use(express.json());
app.use('/api/xero', xeroRoutes);

const MASTER_ITEM = {
  id: ITEM_ID,
  values: {
    'Invoice Date': '2025-03-15',
    'Due Date': '2025-03-29',
    'Invoice Number': 'REF-9001',
    'Group Size': '1',
    'Actual Shift Start Date and Time': '2025-03-10T22:00:00Z',
  },
};

const MASTER_REFS = [
  { servicePlanId: 'sp_1' },
  { cancellationType: 'Short notice' },
  null,
  {
    fullName: 'Jane Roe',
    firstName: 'Jane',
    lastName: 'Roe',
    email: 'jane@example.com',
    updatedAt: '2020-01-01T00:00:00Z',
  },
];

const NDIS_LINES = [
  { desc: '01_011_0107_1_1 Assistance with self-care', unit: 'Hour', qty: 2, unitPrice: 67.56, amount: 135.12 },
];

beforeEach(async () => {
  vi.clearAllMocks();
  await Business.create({ workspaceId: WS, name: 'Hills Grade Care', headOfficeTimezone: 'Australia/Sydney' });
  await Item.create({
    workspaceId: WS, boardId: BOARD, folderId: 'f1', itemId: ITEM_ID, data: {},
  });
  xero.getAccounts.mockResolvedValue([
    { Type: 'EXPENSE', Code: '400' },
    { Type: 'REVENUE', Code: '210' },
  ]);
  xero.getTaxRates.mockResolvedValue([]);
  xero.isAccountTaxRateMatched.mockResolvedValue(true);
  xero.getContactByEmail.mockResolvedValue({ contactID: 'xc_1', updatedDateUTC: '2030-01-01T00:00:00Z' });
  xero.createInvoice.mockResolvedValue({ invoiceNumber: 'INV-501', invoiceID: 'xid_1' });
  isoplus.getNDISMasterPlanReferencedItems.mockResolvedValue(MASTER_REFS);
  buildNdisMasterPlanInvoiceLines.mockResolvedValue(NDIS_LINES);
});

describe('POST /api/xero/:workspaceId/:boardId/invoicendis', () => {
  it('records the invoice number against the item', async () => {
    const res = await request(app)
      .post(`/api/xero/${WS}/${BOARD}/invoicendis`)
      .send({ items: [MASTER_ITEM] });

    expect(res.status).toBe(200);
    const row = await InvoiceNumber.findOne({ itemId: ITEM_ID }).lean();
    expect(row).toMatchObject({ invoiceNumber: 'INV-501 (Xero)', type: 'Xero' });
  });

  it('marks the item as invoiced, so the next scheduled run does not bill it again', async () => {
    await request(app)
      .post(`/api/xero/${WS}/${BOARD}/invoicendis`)
      .send({ items: [MASTER_ITEM] });

    const item = await Item.findOne({ itemId: ITEM_ID }).lean();
    expect(item.invoicedBy).toBe('INV-501 (Xero)');
  });
});
