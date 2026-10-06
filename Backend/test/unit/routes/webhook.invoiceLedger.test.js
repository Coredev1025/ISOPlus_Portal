import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * POST /api/pdf/:workspaceId/:boardId/invoice, the Job Management invoice route
 * (KAN-306): with INVOICE_LEDGER_WRITE on it also records the invoice, as kind
 * `job`, billed to the client on the job planning item. Same doubles as
 * webhook.invoiceNumbering.test.js.
 */

vi.mock('@pdfme/generator', () => ({
  generate: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
}));

vi.mock('../../../src/services/isoplus.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    validateItemBelongsToTenant: vi.fn(),
    setIntegrationMessage: vi.fn(),
    setGeneratedField: vi.fn(),
    setPDFLinkAttribute: vi.fn(),
    getJobReportingReferencedItems: vi.fn(async () => [
      { id: 'jp_1', jobTitle: 'Fix gutter' },
      { feeType: 'Hourly' },
    ]),
    getJobPlanningReferencedItems: vi.fn(async () => [
      { address: '1 Test St', suburb: 'Testville', state: 'NSW', postcode: '2000', client: 'Jane Roe' },
    ]),
  };
});

vi.mock('../../../src/utils/uploadS3.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    uploadFileToS3: vi.fn(async () => ({ $metadata: { httpStatusCode: 200 } })),
    getS3FileUrl: vi.fn(async () => 'https://s3.example.com/signed.pdf'),
  };
});

vi.mock('../../../src/utils/invoicePdfSupport.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getLogoData: vi.fn(async () => ''),
    saveInvoiceNumber: vi.fn(actual.saveInvoiceNumber),
  };
});

const request = (await import('supertest')).default;
const mongoose = (await import('mongoose')).default;
const { createApp } = await import('../../../src/app.js');
const Business = (await import('../../../src/models/Business.js')).default;
const Invoice = (await import('../../../src/models/Invoice.js')).default;
const Item = (await import('../../../src/models/Item.js')).default;
const { saveInvoiceNumber } = await import('../../../src/utils/invoicePdfSupport.js');
const { up: buildInvoiceIndexes } = await import('../../../migrations/1791102300000-invoice-ledger-indexes.js');
const { resetIndexCheckForTests } = await import('../../../src/utils/invoiceLedger/issue.js');

const app = createApp();
const WS = 'ws_job_ledger';
const BD = 'bd_job_ledger';

const ITEM_VALUES = {
  'Issue Date': '2026-09-30T00:00:00Z',
  'Due Date': '2026-10-14T00:00:00Z',
  'Job Duration (Hrs.)': 2,
  'Payable Service Fee($) - GST Excl.': 100,
};

const saved = process.env.INVOICE_LEDGER_WRITE;

beforeEach(async () => {
  vi.clearAllMocks();
  await Business.deleteMany({ workspaceId: WS });
  await Invoice.deleteMany({});
  await Item.deleteMany({ workspaceId: WS });
  await Item.create({ workspaceId: WS, boardId: BD, folderId: 'f', itemId: 'itm_job', data: {} });
  await Business.create({
    workspaceId: WS,
    name: 'Gen Test Business',
    abn: '12 345 678 901',
    address: { street: '1 Fixture St', suburb: 'Testville', state: 'NSW', postcode: '2000', country: 'Australia' },
    bankDetails: { accountName: 'Gen', bankName: 'Test Bank', bsb: '123456', accountNumber: '12345678' },
    documentNumbering: {
      invoice: { prefix: 'INV-', nextNumber: 71 },
      quote: { prefix: 'QT-', nextNumber: 1 },
      purchaseOrder: { prefix: 'PO-', nextNumber: 1 },
    },
  });
  await buildInvoiceIndexes(mongoose.connection);
  resetIndexCheckForTests();
});

afterEach(() => {
  if (saved === undefined) delete process.env.INVOICE_LEDGER_WRITE; else process.env.INVOICE_LEDGER_WRITE = saved;
});

const post = async () => {
  await request(app).post(`/api/pdf/${WS}/${BD}/invoice`).send({ items: [{ id: 'itm_job', values: { ...ITEM_VALUES } }] });
  await vi.waitFor(() => expect(saveInvoiceNumber).toHaveBeenCalledTimes(1), { timeout: 10_000 });
};

describe('the Job Management invoice record', () => {
  it('is written as a job invoice to the client, with the item as its one line', async () => {
    process.env.INVOICE_LEDGER_WRITE = 'on';
    await post();

    await vi.waitFor(async () => expect(await Invoice.countDocuments({ workspaceId: WS })).toBe(1));
    const [invoice] = await Invoice.find({ workspaceId: WS }).lean();
    expect(invoice).toMatchObject({
      number: 'INV-71', kind: 'job', trigger: 'manual', total: 100, boardId: BD,
      participant: { name: 'Jane Roe' },
      lines: [{ itemId: 'itm_job', amount: 100 }],
    });
    expect(invoice.issuedAt.toISOString()).toBe('2026-09-30T00:00:00.000Z');
    expect(invoice.dueDate.toISOString()).toBe('2026-10-14T00:00:00.000Z');

    // The real marker claim ran, so the item names this invoice and points at it.
    const item = await Item.findOne({ workspaceId: WS, itemId: 'itm_job' }).lean();
    expect(item.invoicedBy).toBe('INV-71');
    expect(String(item.activeInvoiceId)).toBe(String(invoice._id));
  });

  it('is not written with the flag off', async () => {
    delete process.env.INVOICE_LEDGER_WRITE;
    await post();

    expect(await Invoice.countDocuments({ workspaceId: WS })).toBe(0);
  });
});
