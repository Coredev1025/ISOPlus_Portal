import { describe, it, expect, vi } from 'vitest';

/**
 * POST /api/pdf/:workspaceId/:boardId/invoice, the Job Management invoice route.
 *
 * KAN-288. The route fetches the business once and then builds every item in the
 * request at the same time. Each item used to read the invoice counter off that
 * one shared object, so every invoice in the request got the same number. The
 * number is now claimed in the database, one claim per invoice.
 *
 * Only the outside world is replaced: the ISO+ lookups, the PDF renderer, S3 and
 * the step that writes the number back to the shift. The route, the allocator
 * and the Business counter are real, which is what the assertion depends on.
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
    saveInvoiceNumber: vi.fn(async () => {}),
  };
});

const request = (await import('supertest')).default;
const { createApp } = await import('../../../src/app.js');
const Business = (await import('../../../src/models/Business.js')).default;
const { saveInvoiceNumber } = await import('../../../src/utils/invoicePdfSupport.js');

const app = createApp();

const ITEM_VALUES = {
  'Issue Date': '2026-09-30T00:00:00Z',
  'Due Date': '2026-10-14T00:00:00Z',
  'Job Duration (Hrs.)': 2,
  'Payable Service Fee($) - GST Excl.': 100,
};

describe('POST /api/pdf/:workspaceId/:boardId/invoice numbering', () => {
  it('gives each item in one request its own invoice number', async () => {
    await Business.create({
      workspaceId: 'ws_inv',
      name: 'Gen Test Business',
      abn: '12 345 678 901',
      address: { street: '1 Fixture St', suburb: 'Testville', state: 'NSW', postcode: '2000', country: 'Australia' },
      bankDetails: {
        accountName: 'Gen', bankName: 'Test Bank', bsb: '123456', accountNumber: '12345678',
      },
      documentNumbering: {
        invoice: { prefix: 'INV-', nextNumber: 41 },
        quote: { prefix: 'QT-', nextNumber: 1 },
        purchaseOrder: { prefix: 'PO-', nextNumber: 1 },
      },
    });

    await request(app)
      .post('/api/pdf/ws_inv/bd_inv/invoice')
      .send({
        items: [
          { id: 'itm_a', values: { ...ITEM_VALUES } },
          { id: 'itm_b', values: { ...ITEM_VALUES } },
          { id: 'itm_c', values: { ...ITEM_VALUES } },
        ],
      });

    // The route answers once and the rest of the work carries on behind it, so
    // wait for every item to finish writing its number back.
    await vi.waitFor(() => expect(saveInvoiceNumber).toHaveBeenCalledTimes(3), { timeout: 10_000 });

    const numbers = saveInvoiceNumber.mock.calls.map((call) => call[3]).sort();
    expect(numbers).toEqual(['INV-41', 'INV-42', 'INV-43']);

    const stored = await Business.findOne({ workspaceId: 'ws_inv' }).lean();
    expect(stored.documentNumbering.invoice.nextNumber).toBe(44);
  });
});
