import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import Business from '../../../src/models/Business.js';

/**
 * Covers invoice/quote/PO paths that hit loadXeroChartOptions +
 * rejectIfAccountTaxMismatch by mocking isoplus + xero + chart helpers.
 * Kept separate from xero.test.js so vi.mock does not affect guard-only cases.
 */

vi.mock('../../../src/services/isoplus.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    validateItemBelongsToTenant: vi.fn(async () => {}),
    getJobReportingReferencedItems: vi.fn(),
    getJobPlanningReferencedItems: vi.fn(),
    getQuoteReferencedItems: vi.fn(),
    getPurchaseOrderReferencedItems: vi.fn(),
    setIntegrationMessage: vi.fn(async () => {}),
    setGeneratedField: vi.fn(async () => {}),
    getQuoteNDISReferencedItems: vi.fn(),
    getNDISMasterPlanReferencedItems: vi.fn(),
  };
});

vi.mock('../../../src/services/xero.js', () => ({
  configure: vi.fn(async () => ({})),
  ensureAuthenticated: vi.fn(async () => ({ tenantId: 'tenant-1' })),
  createInvoice: vi.fn(),
  createOrUpdateContact: vi.fn(),
  createQuote: vi.fn(),
  createPurchaseOrder: vi.fn(),
  getAuthUrl: vi.fn(),
  refreshTokenSet: vi.fn(),
  callback: vi.fn(),
  getContactByEmail: vi.fn(),
  getContactByName: vi.fn(),
  findOrCreateItem: vi.fn(),
}));

vi.mock('../../../src/utils/xeroAccountTaxHelpers.js', () => ({
  loadXeroChartOptions: vi.fn(),
  rejectIfAccountTaxMismatch: vi.fn(),
  ACCOUNT_TAX_MISMATCH_MESSAGE:
    'Account code and Tax rate is not matched, please update them in ISO+ portal',
  ACCOUNT_TAX_MISMATCH_RESPONSE: {
    message: 'Account code and Tax rate is not matched',
  },
}));

vi.mock('../../../src/utils/xeroLineItemMapping.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveSalesLineMapping: vi.fn(() => ({
      accountCode: '200',
      taxType: 'OUTPUT',
    })),
  };
});

vi.mock('../../../src/utils/xeroMaterialLineHelpers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveMaterialSalesLine: vi.fn(() => ({
      accountCode: '200',
      taxType: 'OUTPUT',
    })),
    getPayableMaterialFeeAmount: vi.fn(() => 0),
  };
});

vi.mock('../../../src/utils/auditLogger.js', () => ({
  logAuditTrail: vi.fn(async () => {}),
}));

import { createApp } from '../../../src/app.js';
import {
  getJobReportingReferencedItems,
  getJobPlanningReferencedItems,
  getQuoteReferencedItems,
  getPurchaseOrderReferencedItems,
} from '../../../src/services/isoplus.js';
import {
  getContactByEmail,
  findOrCreateItem,
  createInvoice,
  createQuote,
  createPurchaseOrder,
} from '../../../src/services/xero.js';
import {
  loadXeroChartOptions,
  rejectIfAccountTaxMismatch,
} from '../../../src/utils/xeroAccountTaxHelpers.js';
import { getPayableMaterialFeeAmount } from '../../../src/utils/xeroMaterialLineHelpers.js';

const app = createApp();

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

const validInvoiceValues = {
  'Job Number': ['JOB-1'],
  'Job Duration (Hrs.)': 2,
  'Service Fee Type': ['Standard'],
  'Payable Service Fee($) - GST Excl.': 100,
  'Payable Material Fee($) - GST Excl.': 0,
  'Other Payable Fee($) - GST Excl.': 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  loadXeroChartOptions.mockResolvedValue({ accounts: [], taxRates: [] });
  rejectIfAccountTaxMismatch.mockResolvedValue(null);
  getPayableMaterialFeeAmount.mockReturnValue(0);
  getContactByEmail.mockResolvedValue({
    contactID: '0f5e2a5e-6d4e-4a1f-8f0c-9b6a2f0f1c3d',
    updatedDateUTC: '2099-01-01T00:00:00.000Z',
  });
  findOrCreateItem.mockResolvedValue({ code: 'JOB' });
});

function stubInvoiceRefs() {
  getJobReportingReferencedItems.mockResolvedValue([
    {
      id: 'jp-1',
      jobNumber: 'JOB-1',
      jobTitle: 'Install',
    },
    { id: 'sft-1', feeType: 'Standard' },
  ]);
  getJobPlanningReferencedItems.mockResolvedValue([
    {
      emailAddress: 'ada@example.com',
      updatedAt: '2020-01-01T00:00:00.000Z',
      address: '1 St',
      suburb: 'Sydney',
      state: 'NSW',
      postcode: 2000,
    },
    { jobCode: 'JC', jobType: 'Install' },
  ]);
}

describe('POST invoice account/tax mismatch early return', () => {
  it('returns the mismatch response when rejectIfAccountTaxMismatch rejects', async () => {
    const workspaceId = nextId('ws');
    await Business.create({
      workspaceId,
      name: 'Mismatch Biz',
      xeroIntegrated: true,
      xeroLineItemMapping: {
        invoice: { accountCode: '200', taxType: 'OUTPUT' },
      },
    });

    getJobReportingReferencedItems.mockResolvedValue([
      { id: 'jp-1', jobNumber: 'JOB-1' },
      { id: 'sft-1' },
    ]);
    getJobPlanningReferencedItems.mockResolvedValue([
      {
        emailAddress: 'ada@example.com',
        updatedAt: '2020-01-01T00:00:00.000Z',
        address: '1 St',
        suburb: 'Sydney',
        state: 'NSW',
        postcode: 2000,
      },
      { jobCode: 'JC', jobType: 'Install' },
    ]);
    rejectIfAccountTaxMismatch.mockImplementation(async ({ res }) => {
      res.status(200).json({ message: 'Account code and Tax rate is not matched' });
      return true;
    });

    const res = await request(app)
      .post(`/api/xero/${workspaceId}/b1/invoice`)
      .send({
        items: [{ id: 'item-1', values: validInvoiceValues }],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: 'Account code and Tax rate is not matched',
    });
    expect(rejectIfAccountTaxMismatch).toHaveBeenCalled();
    expect(loadXeroChartOptions).toHaveBeenCalledWith(workspaceId);
  });
});

describe('POST quote account/tax mismatch early return', () => {
  it('returns the mismatch response on the quote path', async () => {
    const workspaceId = nextId('ws');
    await Business.create({
      workspaceId,
      name: 'Quote Mismatch',
      xeroIntegrated: true,
      xeroLineItemMapping: {
        quote: { accountCode: '200', taxType: 'OUTPUT' },
      },
    });

    getQuoteReferencedItems.mockResolvedValue([
      {
        emailAddress: 'ada@example.com',
        updatedAt: '2020-01-01T00:00:00.000Z',
        address: '1 St',
        suburb: 'Sydney',
        state: 'NSW',
        postcode: 2000,
      },
      { jobCode: 'JC', jobType: 'Install' },
    ]);
    // Quote line mapping reads GST etc from the quote item itself
    const quoteItemValues = {
      'Job Title': 'Roof',
      Quantity: 1,
      'Unit Price($) - GST Excl.': 100,
      'Issue Date': '2026-03-01',
      'Expiry Date': '2026-03-31',
      GST: ['GST'],
    };
    rejectIfAccountTaxMismatch.mockImplementation(async ({ res }) => {
      res.status(200).json({ message: 'Account code and Tax rate is not matched' });
      return true;
    });

    const res = await request(app)
      .post(`/api/xero/${workspaceId}/b1/quote`)
      .send({ items: [{ id: 'item-1', values: quoteItemValues }] });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Account code and Tax rate is not matched');
    expect(rejectIfAccountTaxMismatch).toHaveBeenCalled();
  });
});

describe('POST purchaseorder account/tax mismatch early return', () => {
  it('returns the mismatch response on the purchase-order path', async () => {
    const workspaceId = nextId('ws');
    await Business.create({
      workspaceId,
      name: 'PO Mismatch',
      xeroIntegrated: true,
      xeroLineItemMapping: {
        purchaseOrder: { accountCode: '400', taxType: 'INPUT' },
      },
    });

    getPurchaseOrderReferencedItems.mockResolvedValue([
      {
        emailAddress: 'grace@example.com',
        updatedAt: '2020-01-01T00:00:00.000Z',
        address: '2 St',
        suburb: 'Sydney',
        state: 'NSW',
        postcode: 2000,
      },
      { jobCode: 'JC', jobType: 'Install' },
    ]);
    const poItemValues = {
      Quantity: 1,
      'Unit Price($) - GST Excl.': 50,
      'Delivery Date': '2026-03-15',
      'Job Description': 'Parts',
      GST: ['GST'],
    };
    rejectIfAccountTaxMismatch.mockImplementation(async ({ res }) => {
      res.status(200).json({
        message: 'Account code is required. Configure account mapping in Finance Settings.',
      });
      return true;
    });

    const res = await request(app)
      .post(`/api/xero/${workspaceId}/b1/purchaseorder`)
      .send({ items: [{ id: 'item-1', values: poItemValues }] });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/Account code/i);
    expect(rejectIfAccountTaxMismatch).toHaveBeenCalled();
  });
});

describe('POST invoice/quote/PO success paths with chart mapping', () => {
  it('creates an invoice including material and other fee lines Exclusive amounts', async () => {
    const workspaceId = nextId('ws');
    await Business.create({
      workspaceId,
      name: 'Invoice Success',
      xeroIntegrated: true,
      xeroLineItemMapping: {
        invoice: { accountCode: '200', taxType: 'OUTPUT' },
      },
    });
    stubInvoiceRefs();
    getPayableMaterialFeeAmount.mockReturnValue(25);
    createInvoice.mockResolvedValue({
      invoiceNumber: 'INV-9001',
      invoiceID: 'inv-id',
    });

    const res = await request(app)
      .post(`/api/xero/${workspaceId}/b1/invoice`)
      .send({
        items: [
          {
            id: 'item-1',
            values: {
              ...validInvoiceValues,
              'Payable Material Fee($) - GST Excl.': 25,
              'Other Payable Fee($) - GST Excl.': 10,
              GST: ['10%'],
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.invoiceNumber).toBe('INV-9001');
    expect(createInvoice).toHaveBeenCalled();
    const invoiceArg = createInvoice.mock.calls[0][0];
    expect(invoiceArg.lineAmountTypes).toBe('Exclusive');
    expect(invoiceArg.lineItems.length).toBeGreaterThanOrEqual(2);
    expect(rejectIfAccountTaxMismatch).toHaveBeenCalled();
  });

  it('returns material mismatch before createInvoice when material fee fails the gate', async () => {
    const workspaceId = nextId('ws');
    await Business.create({
      workspaceId,
      name: 'Material Mismatch',
      xeroIntegrated: true,
    });
    stubInvoiceRefs();
    getPayableMaterialFeeAmount.mockReturnValue(40);
    rejectIfAccountTaxMismatch
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async ({ res }) => {
        res.status(200).json({ message: 'Account code and Tax rate is not matched' });
        return true;
      });

    const res = await request(app)
      .post(`/api/xero/${workspaceId}/b1/invoice`)
      .send({
        items: [{ id: 'item-1', values: validInvoiceValues }],
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/not matched/i);
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it('creates a quote with optional material line via chart mapping', async () => {
    const workspaceId = nextId('ws');
    await Business.create({
      workspaceId,
      name: 'Quote Success',
      xeroIntegrated: true,
    });
    getQuoteReferencedItems.mockResolvedValue([
      {
        emailAddress: 'ada@example.com',
        updatedAt: '2020-01-01T00:00:00.000Z',
        address: '1 St',
        suburb: 'Sydney',
        state: 'NSW',
        postcode: 2000,
      },
      { jobCode: 'JC', jobType: 'Install' },
    ]);
    getPayableMaterialFeeAmount.mockReturnValue(15);
    createQuote.mockResolvedValue({ quoteNumber: 'QT-42', quoteID: 'q-1' });

    const res = await request(app)
      .post(`/api/xero/${workspaceId}/b1/quote`)
      .send({
        items: [
          {
            id: 'item-1',
            values: {
              'Job Title': 'Roof',
              Quantity: 1,
              'Unit Price($) - GST Excl.': 100,
              'Issue Date': '2026-03-01',
              'Expiry Date': '2026-03-31',
              GST: ['GST'],
              'Job Description': 'Fix roof',
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.quoteNumber).toBe('QT-42');
    expect(createQuote).toHaveBeenCalled();
    const quoteArg = createQuote.mock.calls[0][0];
    expect(quoteArg.lineItems.length).toBeGreaterThanOrEqual(2);
  });

  it('creates a purchase order using mapped expense account/tax', async () => {
    const workspaceId = nextId('ws');
    await Business.create({
      workspaceId,
      name: 'PO Success',
      xeroIntegrated: true,
      xeroLineItemMapping: {
        purchaseOrder: { accountCode: '400', taxType: 'INPUT' },
      },
    });
    getPurchaseOrderReferencedItems.mockResolvedValue([
      {
        contractor: 'Bolt Services',
        contactPersonsFirstName: 'Grace',
        contactPersonsLastName: 'Hopper',
        emailAddress: 'grace@example.com',
        updatedAt: '2020-01-01T00:00:00.000Z',
        address: '2 St',
        suburb: 'Sydney',
        state: 'NSW',
        postcode: 2000,
      },
      { jobCode: 'JC', jobType: 'Install' },
    ]);
    createPurchaseOrder.mockResolvedValue({
      purchaseOrderNumber: 'PO-7',
      purchaseOrderID: 'po-1',
    });

    const res = await request(app)
      .post(`/api/xero/${workspaceId}/b1/purchaseorder`)
      .send({
        items: [
          {
            id: 'item-1',
            values: {
              Quantity: 1,
              'Unit Price($) - GST Excl.': 50,
              'Issue Date': '2026-03-01',
              'Delivery Date': '2026-03-15',
              'Job Description': 'Parts',
              'Job Title': 'Supply',
              "Client's Order Number": 'CO-1',
              GST: ['GST'],
            },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.purchaseOrderNumber).toBe('PO-7');
    expect(createPurchaseOrder).toHaveBeenCalled();
    const poArg = createPurchaseOrder.mock.calls[0][0];
    expect(poArg.lineItems[0].accountCode).toBeTruthy();
    expect(poArg.lineItems[0].taxType).toBeTruthy();
  });
});
