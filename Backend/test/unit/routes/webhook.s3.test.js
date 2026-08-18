import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

/**
 * Where src/routes/webhook.js puts the PDFs it generates.
 *
 * Every document these routes produce is a client billing document — invoices,
 * quotes and purchase orders carrying names, addresses and amounts, at keys
 * built from sequential document numbers, which anyone who guesses one can
 * enumerate. They belong in the non-public bucket (AWS_BUCKET), which
 * uploadFileToS3/getS3FileUrl select when `publicRead` is false.
 *
 * test/unit/routes/webhook.test.js covers the guards these routes share and
 * stops before S3; this suite is the opposite — it mocks the external
 * boundaries (PDF rendering, the ISO+ API, S3) so each route runs all the way
 * to the upload, and pins the bucket, the expiry and the exact key.
 */

vi.mock('@pdfme/generator', () => ({ generate: vi.fn() }));

vi.mock('../../../src/utils/uploadS3.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getS3File: vi.fn(async () => Buffer.from('logo')),
    uploadFileToS3: vi.fn(async () => ({ $metadata: { httpStatusCode: 200 } })),
    getS3FileUrl: vi.fn(async () => 'https://s3.example.com/signed.pdf'),
  };
});

vi.mock('../../../src/services/isoplus.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    validateItemBelongsToTenant: vi.fn(async () => {}),
    setIntegrationMessage: vi.fn(async () => {}),
    setGeneratedField: vi.fn(async () => {}),
    setPDFLinkAttribute: vi.fn(async () => {}),
    getJobReportingReferencedItems: vi.fn(),
    getJobPlanningReferencedItems: vi.fn(),
    getQuoteReferencedItems: vi.fn(),
    getPurchaseOrderReferencedItems: vi.fn(),
  };
});

vi.mock('../../../src/utils/ndisInvoiceGeneratorInvoicing.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getNdisInvoiceGeneratorContextFromMasterItems: vi.fn(),
    prepareParticipantForInvoiceGenerator: vi.fn(),
  };
});

vi.mock('../../../src/utils/ndisServiceRecords.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    buildNdisSupportCatalogueForServicePlan: vi.fn(() => ({})),
    buildNdisMasterPlanServiceRows: vi.fn(),
  };
});

vi.mock('../../../src/utils/ndisPricingRules.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveNdisPricingRuleForServicePlan: vi.fn(async () => null) };
});

const { generate } = await import('@pdfme/generator');
const { uploadFileToS3, getS3FileUrl } = await import('../../../src/utils/uploadS3.js');
const isoplus = await import('../../../src/services/isoplus.js');
const ndisInvoicing = await import('../../../src/utils/ndisInvoiceGeneratorInvoicing.js');
const ndisRecords = await import('../../../src/utils/ndisServiceRecords.js');
const { createApp } = await import('../../../src/app.js');
const Business = (await import('../../../src/models/Business.js')).default;

const app = createApp();

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

const CONTACT = {
  address: '12 Smith St',
  suburb: 'Blacktown',
  state: 'NSW',
  postcode: '2148',
  client: 'Jane Roe',
  contractor: 'Acme Contracting',
};

function businessFields(workspaceId) {
  return {
    workspaceId,
    name: 'Hills Grade Care',
    abn: '12 345 678 901',
    headOfficeTimezone: 'Australia/Sydney',
    address: {
      street: '5 Wattle St',
      suburb: 'Parramatta',
      state: 'NSW',
      postcode: '2150',
      country: 'Australia',
    },
    bankDetails: {
      accountName: 'Hills Grade Care Pty Ltd',
      bankName: 'Big Bank',
      bsb: '062-000',
      accountNumber: '12345678',
      accountsReceivableTerms: '14 days from invoice date',
    },
    documentNumbering: {
      invoice: { prefix: 'INV-', nextNumber: 41 },
      quote: { prefix: 'QT-', nextNumber: 7 },
      purchaseOrder: { prefix: 'PO-', nextNumber: 3 },
    },
  };
}

/** The publicRead argument each S3 call took, read off the recorded calls. */
function s3Destination() {
  return {
    uploadKey: uploadFileToS3.mock.calls[0][1],
    uploadPublicRead: uploadFileToS3.mock.calls[0][2],
    urlKey: getS3FileUrl.mock.calls[0][0],
    urlExpiry: getS3FileUrl.mock.calls[0][1],
    urlPublicRead: getS3FileUrl.mock.calls[0][2],
  };
}

/**
 * The whole point of the suite, asserted the same way for every route: the
 * upload goes to the non-public bucket, the URL is signed against the same
 * bucket (a disagreement yields a link that 404s), the link expires, and the
 * key is exactly output/<workspaceId>/<boardId>/<type>/<name>.
 */
function expectNonPublic(expectedKey) {
  const s3 = s3Destination();
  expect(s3.uploadPublicRead).toBe(false);
  expect(s3.urlPublicRead).toBe(false);
  expect(s3.urlPublicRead).toBe(s3.uploadPublicRead);
  expect(s3.urlKey).toBe(s3.uploadKey);
  expect(s3.urlExpiry).toBe(604800);
  expect(s3.uploadKey).toBe(expectedKey);
}

beforeEach(() => {
  vi.clearAllMocks();
  generate.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
  uploadFileToS3.mockResolvedValue({ $metadata: { httpStatusCode: 200 } });
  getS3FileUrl.mockResolvedValue('https://s3.example.com/signed.pdf');
});

describe('POST /api/pdf/:workspaceId/:boardId/invoice', () => {
  it('uploads the invoice to the non-public bucket at output/<ws>/<bd>/invoices/<name>', async () => {
    const workspaceId = nextId('ws');
    await Business.create(businessFields(workspaceId));
    isoplus.getJobReportingReferencedItems.mockResolvedValue([
      { id: 'jp_1', jobTitle: 'Support shift' },
      { feeType: 'Hourly' },
    ]);
    isoplus.getJobPlanningReferencedItems.mockResolvedValue([CONTACT]);

    const res = await request(app)
      .post(`/api/pdf/${workspaceId}/bd_1/invoice`)
      .send({
        items: [{
          id: 'itm_1',
          values: {
            'Issue Date': '2025-03-15T00:00:00Z',
            'Due Date': '2025-03-29T00:00:00Z',
            'Job Duration (Hrs.)': 2,
            'Payable Service Fee($) - GST Excl.': 120,
          },
        }],
      });

    expect(res.body.pdfUrl).toBe('https://s3.example.com/signed.pdf');
    expectNonPublic(`output/${workspaceId}/bd_1/invoices/INV-41-ISO+™-itm_1.pdf`);
  });
});

describe('POST /api/pdf/:workspaceId/:boardId/quote', () => {
  it('uploads the quote to the non-public bucket at output/<ws>/<bd>/quote/<name>', async () => {
    const workspaceId = nextId('ws');
    await Business.create(businessFields(workspaceId));
    isoplus.getQuoteReferencedItems.mockResolvedValue([CONTACT, { jobType: 'Support' }]);

    const res = await request(app)
      .post(`/api/pdf/${workspaceId}/bd_1/quote`)
      .send({
        items: [{
          id: 'itm_2',
          values: {
            'Issue Date': '2025-03-01T00:00:00Z',
            'Expiry Date': '2025-03-31T00:00:00Z',
            'Job Title': 'Support shift',
            Quantity: 3,
            'Unit Price($) - GST Excl.': 60.5,
          },
        }],
      });

    expect(res.body.pdfUrl).toBe('https://s3.example.com/signed.pdf');
    expectNonPublic(`output/${workspaceId}/bd_1/quote/QT-7-ISO+™-itm_2.pdf`);
  });
});

describe('POST /api/pdf/:workspaceId/:boardId/purchaseorder', () => {
  it('uploads the purchase order to the non-public bucket at output/<ws>/<bd>/purchaseorder/<name>', async () => {
    const workspaceId = nextId('ws');
    await Business.create(businessFields(workspaceId));
    isoplus.getPurchaseOrderReferencedItems.mockResolvedValue([CONTACT, { jobType: 'Support' }]);

    const res = await request(app)
      .post(`/api/pdf/${workspaceId}/bd_1/purchaseorder`)
      .send({
        items: [{
          id: 'itm_3',
          values: {
            'Issue Date': '2025-03-01T00:00:00Z',
            'Delivery Date': '2025-03-31T00:00:00Z',
            'Job Title': 'Materials',
            Quantity: 2,
            'Unit Price($) - GST Excl.': 15,
          },
        }],
      });

    expect(res.body.pdfUrl).toBe('https://s3.example.com/signed.pdf');
    expectNonPublic(`output/${workspaceId}/bd_1/purchaseorder/PO-3-ISO+™-itm_3.pdf`);
  });
});

describe('POST /api/pdf/:workspaceId/:boardId/invoicendis-invoice-generator', () => {
  it('uploads the consolidated invoice to the non-public bucket at output/<ws>/<bd>/NDIS-invoices/<name>', async () => {
    const workspaceId = nextId('ws');
    await Business.create(businessFields(workspaceId));

    const masterItem = {
      itemId: 'itm_master_1',
      data: { 'Service Plan': ['sp_1'], 'Participant Full Name': 'Jane Roe' },
    };
    ndisInvoicing.getNdisInvoiceGeneratorContextFromMasterItems.mockResolvedValue({
      masterItems: [masterItem],
      refItemsMap: new Map([['sp_1', { itemId: 'sp_1', data: {} }]]),
      participantProfileItem: null,
    });
    ndisInvoicing.prepareParticipantForInvoiceGenerator.mockResolvedValue({
      participantProfile: { fullName: 'Jane Roe' },
      participantProfileItem: null,
      participantName: 'Jane Roe',
    });
    ndisRecords.buildNdisMasterPlanServiceRows.mockReturnValue([{
      sourceItemId: 'itm_master_1',
      service: '01_011_0107_1_1 Assistance with self-care',
      unit: 'Hour',
      quantity: 2,
      unitPrice: 67.56,
      totalAmount: 135.12,
      serviceDeliveryDate: '2025-03-11T09:00:00+11:00',
      jobStatus: 'Completed',
    }]);

    const res = await request(app)
      .post(`/api/pdf/${workspaceId}/bd_1/invoicendis-invoice-generator`)
      .send({ items: [{ id: 'itm_master_1' }], participantName: 'Jane Roe' });

    expect(res.body.fileUrl).toBe('https://s3.example.com/signed.pdf');
    expectNonPublic(`output/${workspaceId}/bd_1/NDIS-invoices/INV-41-ISO+™-Jane_Roe.pdf`);
  });
});
