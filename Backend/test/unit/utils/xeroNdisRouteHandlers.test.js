import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { XERO_DEFAULT_ACCOUNT_CODES } from '../../../src/constants/xeroMapping.js';

// External boundaries only: the ISO+ HTTP API, the Xero SDK, the audit
// collection, and the two heavy builders that have their own tests. The invoice
// and quote assembly, contact resolution, line/date maths, reference building
// and every error branch run for real, against the in-memory Mongo that
// test/setup.js starts.
vi.mock('../../../src/services/isoplus.js', () => ({
  setIntegrationMessage: vi.fn(async () => {}),
  setGeneratedField: vi.fn(async () => {}),
  getQuoteNDISReferencedItems: vi.fn(),
  getNDISMasterPlanReferencedItems: vi.fn(),
  validateItemBelongsToTenant: vi.fn(async () => {}),
}));
vi.mock('../../../src/services/xero.js', () => ({
  createInvoice: vi.fn(),
  createQuote: vi.fn(),
  createOrUpdateContact: vi.fn(),
  getContactByEmail: vi.fn(),
  getContactByName: vi.fn(),
  getAccounts: vi.fn(),
  getTaxRates: vi.fn(async () => []),
  isAccountTaxRateMatched: vi.fn(async () => true),
  configure: vi.fn(async () => {}),
  ensureAuthenticated: vi.fn(async () => {}),
}));
vi.mock('../../../src/utils/auditLogger.js', () => ({ logAuditTrail: vi.fn() }));
vi.mock('../../../src/utils/ndisMasterPlanLineHelpers.js', async (importOriginal) => ({
  ...(await importOriginal()),
  buildNdisMasterPlanInvoiceLines: vi.fn(),
}));
vi.mock('../../../src/utils/ndisInvoiceGeneratorInvoicing.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getNdisInvoiceGeneratorContextFromMasterItems: vi.fn(),
  prepareParticipantForInvoiceGenerator: vi.fn(),
}));
vi.mock('../../../src/utils/ndisServiceRecords.js', async (importOriginal) => ({
  ...(await importOriginal()),
  buildNdisMasterPlanServiceRows: vi.fn(() => []),
  buildNdisSupportCatalogueForServicePlan: vi.fn(() => ({})),
}));
vi.mock('../../../src/utils/ndisPricingRules.js', () => ({
  resolveNdisPricingRuleForServicePlan: vi.fn(async () => ({ rule: 'standard' })),
}));

const isoplus = await import('../../../src/services/isoplus.js');
const xero = await import('../../../src/services/xero.js');
const { logAuditTrail } = await import('../../../src/utils/auditLogger.js');
const { buildNdisMasterPlanInvoiceLines } = await import('../../../src/utils/ndisMasterPlanLineHelpers.js');
const invoicing = await import('../../../src/utils/ndisInvoiceGeneratorInvoicing.js');
const serviceRecords = await import('../../../src/utils/ndisServiceRecords.js');
const { resolveNdisPricingRuleForServicePlan } = await import('../../../src/utils/ndisPricingRules.js');
const Business = (await import('../../../src/models/Business.js')).default;
const Item = (await import('../../../src/models/Item.js')).default;

const {
  parseInvoiceGeneratorMasterItemIds,
  handleXeroInvoicendis,
  handleXeroQuotendis,
  handleXeroInvoicendisInvoiceGenerator,
  handleXeroInvoiceParticipantTax,
} = await import('../../../src/utils/xeroNdisRouteHandlers.js');

// ---------------------------------------------------------------------------
// Collaborators, reproduced from src/routes/xero.js (the only caller).
// ---------------------------------------------------------------------------

function formatValue(val) {
  const num = Number(val);
  if (!isNaN(num)) return (Math.round(num * 100) / 100).toFixed(2);
  return val;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendDateSuffix(description, rowDate) {
  const base = (description ?? '').toString().trim() || 'Service';
  const date = (rowDate ?? '').toString().trim();
  if (!date) return base;
  const alreadyHasDateSuffix = new RegExp(`\\s*-\\s*${escapeRegExp(date)}\\s*$`).test(base);
  return alreadyHasDateSuffix ? base : `${base} - ${date}`;
}

function getXeroServiceRowDate(item) {
  const status = (item?.transactionStatus ?? '').toString().trim();
  const scheduled = (item?.scheduledServiceDate ?? '').toString().trim();
  const delivered = (item?.serviceDeliveryDate ?? '').toString().trim();
  const isDelivered = status === 'Delivered - To be claimed and invoiced.'
    || status.toLowerCase().startsWith('delivered');
  return (isDelivered ? delivered : scheduled) || (isDelivered ? scheduled : delivered) || '';
}

function roundTo(value, dp) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = Math.pow(10, dp);
  return Math.round((num + Number.EPSILON) * factor) / factor;
}
const round2 = (value) => roundTo(value, 2);
const round4 = (value) => roundTo(value, 4);

function makeRes() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
}

beforeEach(() => {
  vi.clearAllMocks();
  xero.getAccounts.mockResolvedValue([
    { Type: 'EXPENSE', Code: '400' },
    { Type: 'REVENUE', Code: '210' },
  ]);
  xero.isAccountTaxRateMatched.mockResolvedValue(true);
  xero.getContactByEmail.mockResolvedValue({ contactID: 'xc_1', updatedDateUTC: '2030-01-01T00:00:00Z' });
  xero.getContactByName.mockResolvedValue(null);
  xero.createOrUpdateContact.mockResolvedValue({ contactID: 'xc_created' });
  serviceRecords.buildNdisMasterPlanServiceRows.mockReturnValue([]);
  serviceRecords.buildNdisSupportCatalogueForServicePlan.mockReturnValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseInvoiceGeneratorMasterItemIds', () => {
  it('takes plain string ids from itemIds', () => {
    expect(parseInvoiceGeneratorMasterItemIds({ itemIds: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('prefers sourceItemId, then splits a composite id on the colon', () => {
    expect(parseInvoiceGeneratorMasterItemIds({
      items: [
        { sourceItemId: 'src_1', id: 'ignored:1' },
        { id: 'itm_2:line3' },
        { id: 'itm_3' },
      ],
    })).toEqual(['src_1', 'itm_2', 'itm_3']);
  });

  it('drops empties and de-duplicates while keeping first-seen order', () => {
    expect(parseInvoiceGeneratorMasterItemIds({
      itemIds: ['b', null, 'a', '', { id: 'b' }, 0, { nothing: true }],
    })).toEqual(['b', 'a']);
  });

  it('ignores items when itemIds is present, and returns [] for anything else', () => {
    expect(parseInvoiceGeneratorMasterItemIds({ itemIds: ['x'], items: [{ id: 'y' }] })).toEqual(['x']);
    expect(parseInvoiceGeneratorMasterItemIds({})).toEqual([]);
    expect(parseInvoiceGeneratorMasterItemIds(null)).toEqual([]);
    expect(parseInvoiceGeneratorMasterItemIds({ itemIds: 'not-an-array' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

const MASTER_ITEM = {
  id: 'itm_master_1',
  values: {
    'Invoice Date': '2025-03-15',
    'Due Date': '2025-03-29',
    'Invoice Number': 'REF-9001',
    'Group Size': '2',
    'Actual Shift Start Date and Time': '2025-03-10T22:00:00Z',
  },
};

const MASTER_REFS = [
  { servicePlanId: 'sp_1' },
  { cancellationType: 'Short notice' },
  null,
  { fullName: 'Jane Roe', firstName: 'Jane', lastName: 'Roe', email: 'jane@example.com', updatedAt: '2020-01-01T00:00:00Z' },
];

const NDIS_LINES = [
  { desc: '01_011_0107_1_1 Assistance with self-care', unit: 'Hour', qty: 2, unitPrice: 67.56, amount: 135.12 },
  { desc: '02_051_0108_1_1 Provider travel', unit: 'Each', qty: 1.5, unitPrice: 4.5, amount: 6.75 },
];

function invoiceArgs(overrides = {}) {
  return {
    req: { body: {} },
    res: makeRes(),
    workspaceId: 'ws_1',
    boardId: 'bd_1',
    item: MASTER_ITEM,
    initializeXeroOperation: vi.fn(async () => ({ headOfficeTimezone: 'Australia/Sydney', name: 'Hills Grade Care' })),
    handleError: vi.fn(async () => ({ body: { message: 'handled' } })),
    saveInvoiceNumber: vi.fn(async () => {}),
    formatValue,
    ...overrides,
  };
}

describe('handleXeroInvoicendis', () => {
  it('creates a draft Xero invoice from the built NDIS lines', async () => {
    isoplus.getNDISMasterPlanReferencedItems.mockResolvedValue(MASTER_REFS);
    buildNdisMasterPlanInvoiceLines.mockResolvedValue(NDIS_LINES);
    xero.createInvoice.mockResolvedValue({ invoiceNumber: 'INV-501', invoiceID: 'xid_1' });
    const args = invoiceArgs();

    await handleXeroInvoicendis(args);

    expect(args.handleError).not.toHaveBeenCalled();
    expect(xero.createInvoice).toHaveBeenCalledWith({
      type: 'ACCREC',
      contact: { contactID: 'xc_1' },
      reference: 'REF-9001',
      lineAmountTypes: 'Exclusive',
      lineItems: [
        {
          // The service date is the actual shift start in the business
          // timezone: 2025-03-10T22:00Z is 11/03/2025 in Sydney.
          description: '01_011_0107_1_1 Assistance with self-care - 11/03/2025',
          quantity: '2.00',
          unitAmount: 67.56,
          taxType: 'EXEMPTOUTPUT',
          accountCode: XERO_DEFAULT_ACCOUNT_CODES.invoice,
        },
        {
          description: '02_051_0108_1_1 Provider travel - 11/03/2025',
          quantity: '1.50',
          unitAmount: 4.5,
          taxType: 'EXEMPTOUTPUT',
          accountCode: XERO_DEFAULT_ACCOUNT_CODES.invoice,
        },
      ],
      date: '2025-03-15',
      dueDate: '2025-03-29',
      status: 'DRAFT',
    });
    expect(isoplus.setIntegrationMessage).toHaveBeenCalledWith(
      'ws_1', 'bd_1', 'itm_master_1', 'Your invoice has been created successfully in Xero.',
    );
    expect(logAuditTrail).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws_1',
      action: 'Create Xero Invoice',
      detail: 'Invoice created successfully, invoice number: INV-501',
    }));
    expect(isoplus.setGeneratedField).toHaveBeenCalledWith('ws_1', 'bd_1', 'itm_master_1', 'INV-501 (Xero)');
    expect(args.saveInvoiceNumber).toHaveBeenCalledWith('ws_1', 'bd_1', 'itm_master_1', 'INV-501 (Xero)', 'Xero');
    expect(args.res.json).toHaveBeenCalledWith({ invoiceNumber: 'INV-501', invoiceID: 'xid_1' });
  });

  it('falls back to today in the business timezone for both dates', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-15T14:30:00Z')); // 16 March in Sydney
    isoplus.getNDISMasterPlanReferencedItems.mockResolvedValue(MASTER_REFS);
    buildNdisMasterPlanInvoiceLines.mockResolvedValue([NDIS_LINES[0]]);
    xero.createInvoice.mockResolvedValue({ invoiceNumber: 'INV-502' });
    const item = { ...MASTER_ITEM, values: { ...MASTER_ITEM.values, 'Invoice Date': '', 'Due Date': undefined } };

    await handleXeroInvoicendis(invoiceArgs({ item }));

    const payload = xero.createInvoice.mock.calls[0][0];
    expect(payload.date).toBe('2025-03-16');
    expect(payload.dueDate).toBe('2025-03-16');
  });

  it('uses the default sales account when Xero exposes no revenue account', async () => {
    isoplus.getNDISMasterPlanReferencedItems.mockResolvedValue(MASTER_REFS);
    buildNdisMasterPlanInvoiceLines.mockResolvedValue([NDIS_LINES[0]]);
    xero.getAccounts.mockResolvedValue([{ Type: 'EXPENSE', Code: '400' }]);
    xero.createInvoice.mockResolvedValue({ invoiceNumber: 'INV-503' });

    await handleXeroInvoicendis(invoiceArgs());

    expect(xero.createInvoice.mock.calls[0][0].lineItems[0].accountCode).toBe('200');
  });

  it('answers 200 with nothing to invoice when no lines are built', async () => {
    isoplus.getNDISMasterPlanReferencedItems.mockResolvedValue(MASTER_REFS);
    buildNdisMasterPlanInvoiceLines.mockResolvedValue([]);
    const args = invoiceArgs();

    await handleXeroInvoicendis(args);

    expect(xero.createInvoice).not.toHaveBeenCalled();
    expect(isoplus.setIntegrationMessage).toHaveBeenLastCalledWith(
      'ws_1', 'bd_1', 'itm_master_1', 'There is nothing to invoice!',
    );
    expect(args.res.status).toHaveBeenCalledWith(200);
    expect(args.res.json).toHaveBeenCalledWith({ message: 'There is nothing to invoice!' });
  });

  it.each([
    [
      'service plan',
      [undefined, null, null, { fullName: 'Jane Roe' }],
      'Master plan information is required. Master plan is missing a master plan reference.',
    ],
    [
      'participant profile',
      [{ servicePlanId: 'sp_1' }, null, null, null],
      'Participant profile information is required. Master plan is missing a participant profile reference.',
    ],
  ])('reports a missing %s reference through the shared error handler', async (_label, refs, message) => {
    isoplus.getNDISMasterPlanReferencedItems.mockResolvedValue(refs);
    const args = invoiceArgs();

    await handleXeroInvoicendis(args);

    expect(isoplus.setIntegrationMessage).toHaveBeenCalledWith('ws_1', 'bd_1', 'itm_master_1', message);
    expect(xero.createInvoice).not.toHaveBeenCalled();
    const [err, workspaceId, boardId, item, , kind] = args.handleError.mock.calls[0];
    expect(err.message).toBe(message);
    expect([workspaceId, boardId, item.id, kind]).toEqual(['ws_1', 'bd_1', 'itm_master_1', 'invoice']);
    expect(args.res.status).toHaveBeenCalledWith(200);
    expect(args.res.json).toHaveBeenCalledWith({ message: 'handled' });
  });

  it('creates the Xero contact when the participant has none, using the profile names', async () => {
    isoplus.getNDISMasterPlanReferencedItems.mockResolvedValue(MASTER_REFS);
    buildNdisMasterPlanInvoiceLines.mockResolvedValue([NDIS_LINES[0]]);
    xero.getContactByEmail.mockResolvedValue(null);
    xero.createInvoice.mockResolvedValue({ invoiceNumber: 'INV-504' });

    await handleXeroInvoicendis(invoiceArgs());

    expect(isoplus.setIntegrationMessage).toHaveBeenCalledWith(
      'ws_1', 'bd_1', 'itm_master_1', 'The contact does not exist in Xero, creating...',
    );
    expect(xero.createOrUpdateContact).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Jane Roe',
      firstName: 'Jane',
      lastName: 'Roe',
      emailAddress: 'jane@example.com',
    }));
    expect(xero.createInvoice.mock.calls[0][0].contact).toEqual({ contactID: 'xc_created' });
  });

  it('routes a Xero failure through the error handler and still answers 200', async () => {
    isoplus.getNDISMasterPlanReferencedItems.mockResolvedValue(MASTER_REFS);
    buildNdisMasterPlanInvoiceLines.mockResolvedValue([NDIS_LINES[0]]);
    xero.createInvoice.mockRejectedValue(new Error('Xero rejected the invoice'));
    const args = invoiceArgs();

    await handleXeroInvoicendis(args);

    expect(args.handleError.mock.calls[0][0].message).toBe('Xero rejected the invoice');
    expect(args.saveInvoiceNumber).not.toHaveBeenCalled();
    expect(args.res.status).toHaveBeenCalledWith(200);
  });
});

// ---------------------------------------------------------------------------

const QUOTE_VALUES = {
  'Issue Date': '2025-03-01T00:00:00Z',
  'Expiry Date': '2025-03-31T00:00:00Z',
  'Recipient of the Quote': 'Jane Roe',
  'Recipient Email': 'jane@example.com',
  'Recipient Address': '12 Smith St',
  Suburb: 'Blacktown',
  State: 'NSW',
  Postcode: 2148,
  'Job Title': 'Support services quote',
  'Job Description': '<p>Weekly personal care</p>',
  Quantity: 3,
  'Unit Price($) - GST Excl.': 60.5,
  'Direct Support Item Number': '01_011_0107_1_1',
  'Unit (Direct Support)': 'Hour',
  'Quantity (Direct Support)': 3,
  'Unit Price for Direct Support($)': 60.5,
  updatedAt: '2020-01-01T00:00:00Z',
};

function quoteArgs(overrides = {}) {
  const { values, ...rest } = overrides;
  return {
    req: { body: { items: [{ id: 'itm_quote_1' }] } },
    res: makeRes(),
    workspaceId: 'ws_1',
    boardId: 'bd_1',
    item: { id: 'itm_quote_1', values: { ...QUOTE_VALUES, ...values } },
    initializeXeroOperation: vi.fn(async () => ({
      headOfficeTimezone: 'Australia/Sydney',
      bankDetails: { accountsReceivableTerms: '14 days from invoice date' },
    })),
    handleError: vi.fn(async () => ({ body: { message: 'handled' } })),
    warn: vi.fn(),
    ...rest,
  };
}

describe('handleXeroQuotendis', () => {
  it('refuses an empty payload without calling Xero', async () => {
    const args = quoteArgs();
    args.req.body.items = [];

    await handleXeroQuotendis(args);

    expect(args.warn).toHaveBeenCalledWith(
      'Xero-Service', 'Received payload with empty items.', { payload: args.req.body }, args.req,
    );
    expect(args.initializeXeroOperation).not.toHaveBeenCalled();
    expect(args.res.json).toHaveBeenCalledWith('No items found in the payload.');
  });

  it('creates the Xero quote from the NDIS quote values', async () => {
    isoplus.getQuoteNDISReferencedItems.mockResolvedValue([
      { serviceArea: 'NSW Metro' },
      { itemName: 'Assistance with self-care' },
    ]);
    xero.createQuote.mockResolvedValue({ quoteNumber: 'QU-88' });
    const args = quoteArgs();

    await handleXeroQuotendis(args);

    expect(args.handleError).not.toHaveBeenCalled();
    const payload = xero.createQuote.mock.calls[0][0];
    expect(payload.contact).toEqual({ contactID: 'xc_1' });
    expect(payload.date).toBe('2025-03-01T00:00:00Z');
    expect(payload.expiryDate).toBe('2025-03-31T00:00:00Z');
    expect(payload.lineItems).toEqual([{
      description: '01_011_0107_1_1-Assistance with self-care - Hour',
      unit: 'Hour',
      quantity: 3,
      unitAmount: 60.5,
      taxType: 'EXEMPTOUTPUT',
      accountCode: XERO_DEFAULT_ACCOUNT_CODES.invoice,
    }]);
    expect(payload.terms).toContain('Payment Terms: 14 days from invoice date');
    expect(isoplus.setIntegrationMessage).toHaveBeenCalledWith(
      'ws_1', 'bd_1', 'itm_quote_1', 'Your quote has been created successfully in Xero.',
    );
    expect(logAuditTrail).toHaveBeenCalledWith(expect.objectContaining({
      action: 'Create Xero Quote',
      detail: 'Quote created successfully, quote number: QU-88',
    }));
    expect(isoplus.setGeneratedField).toHaveBeenCalledWith('ws_1', 'bd_1', 'itm_quote_1', 'QU-88 (Xero)');
    expect(args.res.json).toHaveBeenCalledWith({ quoteNumber: 'QU-88' });
  });

  it('refreshes a Xero contact that is older than the ISO+ quote record', async () => {
    isoplus.getQuoteNDISReferencedItems.mockResolvedValue([{ serviceArea: 'NSW Metro' }, { itemName: 'x' }]);
    xero.getContactByEmail.mockResolvedValue({ contactID: 'xc_1', updatedDateUTC: '2024-01-01T00:00:00Z' });
    xero.createQuote.mockResolvedValue({ quoteNumber: 'QU-89' });
    const args = quoteArgs({ values: { updatedAt: '2025-02-01T00:00:00Z' } });

    await handleXeroQuotendis(args);

    expect(xero.createOrUpdateContact).toHaveBeenCalledWith(expect.objectContaining({
      contactID: 'xc_1',
      name: 'Jane Roe',
      emailAddress: 'jane@example.com',
    }));
    expect(xero.createQuote.mock.calls[0][0].contact).toEqual({ contactID: 'xc_created' });
  });

  it('reports a missing Service Area to ISO+ and through the error handler', async () => {
    isoplus.getQuoteNDISReferencedItems.mockResolvedValue([undefined, { itemName: 'x' }]);
    const args = quoteArgs();

    await handleXeroQuotendis(args);

    expect(isoplus.setIntegrationMessage).toHaveBeenCalledWith(
      'ws_1', 'bd_1', 'itm_quote_1', 'ERROR: Service Area value is required.',
    );
    expect(xero.createQuote).not.toHaveBeenCalled();
    expect(args.handleError.mock.calls[0][0].message).toBe('Service Area value is required.');
    expect(args.handleError.mock.calls[0][5]).toBe('quote');
    expect(args.res.json).toHaveBeenCalledWith({ message: 'handled' });
  });

  it('answers 200 with the validation details when the mapped quote is incomplete', async () => {
    isoplus.getQuoteNDISReferencedItems.mockResolvedValue([{ serviceArea: 'NSW Metro' }]);
    const args = quoteArgs({
      values: {
        'Job Title': '',
        'Job Description': '',
        'Quantity (Direct Support)': 0,
        Quantity: 0,
        'Unit Price($) - GST Excl.': 0,
      },
    });

    await handleXeroQuotendis(args);

    expect(xero.createQuote).not.toHaveBeenCalled();
    expect(args.res.status).toHaveBeenCalledWith(200);
    const body = args.res.json.mock.calls[0][0];
    expect(body.message).toBe('Quote validation failed');
    expect(body.details[0].message).toBe('Job Title is required.');
    expect(isoplus.setIntegrationMessage).toHaveBeenCalledWith(
      'ws_1', 'bd_1', 'itm_quote_1',
      expect.stringContaining('ERROR: Quote validation failed:'),
    );
  });

  it('routes a Xero failure through the error handler', async () => {
    isoplus.getQuoteNDISReferencedItems.mockResolvedValue([{ serviceArea: 'NSW Metro' }, { itemName: 'x' }]);
    xero.createQuote.mockRejectedValue(new Error('Xero quote rejected'));
    const args = quoteArgs();

    await handleXeroQuotendis(args);

    expect(args.handleError.mock.calls[0][0].message).toBe('Xero quote rejected');
    expect(isoplus.setGeneratedField).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

function generatorArgs(overrides = {}) {
  return {
    req: { body: { itemIds: ['itm_master_1'], invoiceDate: '2025-03-15T00:00:00Z', dueDate: '2025-03-29T00:00:00Z' } },
    res: makeRes(),
    workspaceId: 'ws_1',
    boardId: 'bd_1',
    saveInvoiceNumber: vi.fn(async () => {}),
    appendDateSuffix,
    error: vi.fn(),
    ...overrides,
  };
}

function generatorContext(overrides = {}) {
  return {
    masterItems: [{ itemId: 'itm_master_1', data: { 'Service Plan': ['sp_1'], 'Cancellation Type': ['ct_1'] } }],
    refItemsMap: new Map([
      ['sp_1', { itemId: 'sp_1', data: { Service: 'Personal care' } }],
      ['ct_1', { itemId: 'ct_1', data: { Definition: 'Short notice' } }],
    ]),
    participantProfileItem: { itemId: 'pp_1', data: { 'Full Name/Preferred Name': 'Jane Roe', 'NDIS Number': '430 123 456' } },
    ...overrides,
  };
}

describe('handleXeroInvoicendisInvoiceGenerator', () => {
  beforeEach(() => {
    invoicing.getNdisInvoiceGeneratorContextFromMasterItems.mockResolvedValue(generatorContext());
    invoicing.prepareParticipantForInvoiceGenerator.mockResolvedValue({
      participantProfile: { fullName: 'Jane Roe', billingEmail: 'jane@example.com', billingAddress: '12 Smith St, Blacktown, NSW, 2148' },
      participantProfileItem: { itemId: 'pp_1', data: { 'Full Name/Preferred Name': 'Jane Roe', 'NDIS Number': '430 123 456' } },
      participantName: 'Jane Roe',
      billingContact: 'Jane Roe',
    });
  });

  it('builds one Xero line per service row and answers with the invoice summary', async () => {
    serviceRecords.buildNdisMasterPlanServiceRows.mockReturnValue([
      {
        sourceItemId: 'itm_master_1',
        service: 'Assistance with self-care',
        quantity: '2',
        unitPrice: '67.56',
        serviceDeliveryDate: '2025-03-10T22:00:00Z',
        scheduledServiceDate: '2025-03-09T22:00:00Z',
        jobStatus: 'Completed',
      },
      {
        sourceItemId: 'itm_master_1',
        service: 'Cancelled visit',
        quantity: 1,
        unitPrice: 60,
        serviceDeliveryDate: '2025-03-20T22:00:00Z',
        scheduledServiceDate: '2025-03-01T22:00:00Z',
        jobStatus: 'Cancelled',
      },
    ]);
    xero.createInvoice.mockResolvedValue({ invoiceNumber: 'INV-777', url: 'https://xero.example.com/inv/777' });
    const args = generatorArgs();

    await handleXeroInvoicendisInvoiceGenerator(args);

    expect(args.error).not.toHaveBeenCalled();
    const payload = xero.createInvoice.mock.calls[0][0];
    expect(payload).toEqual({
      type: 'ACCREC',
      contact: { contactID: 'xc_1' },
      reference: 'Jane Roe - 430123456',
      lineAmountTypes: 'Exclusive',
      lineItems: [
        {
          // Completed rows date from the delivery date: 11/03/2025 in Sydney.
          description: 'Assistance with self-care - 11/03/2025',
          quantity: 2,
          unitAmount: 67.56,
          taxType: 'EXEMPTOUTPUT',
          accountCode: XERO_DEFAULT_ACCOUNT_CODES.invoice,
        },
        {
          // Cancelled rows date from the scheduled date instead.
          description: 'Cancelled visit - 02/03/2025',
          quantity: 1,
          unitAmount: 60,
          taxType: 'EXEMPTOUTPUT',
          accountCode: XERO_DEFAULT_ACCOUNT_CODES.invoice,
        },
      ],
      date: '2025-03-15',
      dueDate: '2025-03-29',
      status: 'DRAFT',
    });
    expect(args.saveInvoiceNumber).toHaveBeenCalledWith('ws_1', 'bd_1', 'itm_master_1', 'INV-777 (Xero)', 'Xero');
    expect(args.res.json).toHaveBeenCalledWith({
      invoiceNumber: 'INV-777',
      invoiceUrl: 'https://xero.example.com/inv/777',
      itemCount: 1,
      lineCount: 2,
    });
  });

  it('uses the stored head office timezone when dating the line descriptions', async () => {
    await Business.create({ workspaceId: 'ws_1', name: 'Hills Grade Care', headOfficeTimezone: 'Pacific/Auckland' });
    serviceRecords.buildNdisMasterPlanServiceRows.mockReturnValue([{
      sourceItemId: 'itm_master_1',
      service: 'Late night support',
      quantity: 1,
      unitPrice: 10,
      serviceDeliveryDate: '2025-03-10T22:00:00Z',
      jobStatus: 'Completed',
    }]);
    xero.createInvoice.mockResolvedValue({ invoiceNumber: 'INV-778' });

    await handleXeroInvoicendisInvoiceGenerator(generatorArgs());

    // 2025-03-10T22:00Z is 11/03/2025 in Auckland (UTC+13).
    expect(xero.createInvoice.mock.calls[0][0].lineItems[0].description).toBe('Late night support - 11/03/2025');
    expect(resolveNdisPricingRuleForServicePlan).toHaveBeenCalledWith(
      'ws_1', expect.objectContaining({ itemId: 'sp_1' }), 'bd_1',
    );
  });

  it('answers 200 with nothing to invoice when no rows are produced', async () => {
    serviceRecords.buildNdisMasterPlanServiceRows.mockReturnValue([]);
    const args = generatorArgs();

    await handleXeroInvoicendisInvoiceGenerator(args);

    expect(xero.createInvoice).not.toHaveBeenCalled();
    expect(args.res.status).toHaveBeenCalledWith(200);
    expect(args.res.json).toHaveBeenCalledWith({ message: 'There is nothing to invoice!' });
  });

  it('reports a participant profile with no billing contact', async () => {
    invoicing.prepareParticipantForInvoiceGenerator.mockResolvedValue({
      participantProfile: {},
      participantProfileItem: null,
      participantName: '',
      billingContact: '',
    });
    const args = generatorArgs();

    await handleXeroInvoicendisInvoiceGenerator(args);

    expect(xero.createInvoice).not.toHaveBeenCalled();
    expect(args.res.status).toHaveBeenCalledWith(200);
    expect(args.res.json).toHaveBeenCalledWith({
      message: 'Billing Contact is required for NDIS invoice contact creation. Please ensure the Participant Profile has a Billing Contact, Full Name/Preferred Name, or Preferred Name.',
    });
    expect(args.error).toHaveBeenCalledWith(
      'Xero-Service',
      'Server error (NDIS invoice generator Xero)',
      expect.objectContaining({ message: expect.stringContaining('Billing Contact is required') }),
      args.req,
    );
  });

  it('reports a master plan row with no service plan reference', async () => {
    invoicing.getNdisInvoiceGeneratorContextFromMasterItems.mockResolvedValue(generatorContext({
      masterItems: [{ itemId: 'itm_master_1', data: {} }],
    }));
    const args = generatorArgs();

    await handleXeroInvoicendisInvoiceGenerator(args);

    expect(args.res.json).toHaveBeenCalledWith({
      message: 'Master plan information is required. Master plan is missing a service plan reference.',
    });
  });

  it('defaults the invoice date to today and the due date to 14 days later', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-15T00:00:00Z'));
    serviceRecords.buildNdisMasterPlanServiceRows.mockReturnValue([{
      sourceItemId: 'itm_master_1', service: 'Support', quantity: 1, unitPrice: 10, jobStatus: 'Completed',
    }]);
    xero.createInvoice.mockResolvedValue({ invoiceNumber: 'INV-779' });
    const args = generatorArgs({ req: { body: { itemIds: ['itm_master_1'] } } });

    await handleXeroInvoicendisInvoiceGenerator(args);

    const payload = xero.createInvoice.mock.calls[0][0];
    expect(payload.date).toBe('2025-03-15');
    expect(payload.dueDate).toBe('2025-03-29');
    expect(payload.lineItems[0].description).toBe('Support');
  });

  it('reports a Xero failure as a 200 with the error message', async () => {
    serviceRecords.buildNdisMasterPlanServiceRows.mockReturnValue([{
      sourceItemId: 'itm_master_1', service: 'Support', quantity: 1, unitPrice: 10, jobStatus: 'Completed',
    }]);
    xero.createInvoice.mockRejectedValue(new Error('Xero is down'));
    const args = generatorArgs();

    await handleXeroInvoicendisInvoiceGenerator(args);

    expect(args.saveInvoiceNumber).not.toHaveBeenCalled();
    expect(args.res.status).toHaveBeenCalledWith(200);
    expect(args.res.json).toHaveBeenCalledWith({ message: 'Xero is down' });
  });
});

// ---------------------------------------------------------------------------

function taxItem(overrides = {}) {
  return {
    id: 'itm_5001',
    participant: 'Jane Roe',
    service: 'Community access support',
    quantity: 2,
    unitPrice: 60,
    totalAmount: 120,
    participantContribution: 30,
    transactionStatus: 'Delivered - To be claimed and invoiced.',
    serviceDeliveryDate: '2025-03-10T22:00:00Z',
    scheduledServiceDate: '2025-03-10T09:00:00Z',
    ...overrides,
  };
}

function taxArgs(bodyOverrides = {}) {
  return {
    req: {
      body: {
        items: [taxItem()],
        participantName: 'Jane Roe',
        invoiceDate: '2025-03-15T00:00:00Z',
        ...bodyOverrides,
      },
    },
    res: makeRes(),
    workspaceId: 'ws_1',
    boardId: 'bd_1',
    saveInvoiceNumber: vi.fn(async () => {}),
    getXeroServiceRowDate,
    appendDateSuffix,
    formatDdMmYyyy: serviceRecords.formatDdMmYyyy,
    round2,
    round4,
    error: vi.fn(),
  };
}

async function seedParticipantTaxFixtures() {
  await Business.create({ workspaceId: 'ws_1', name: 'Hills Grade Care', headOfficeTimezone: 'Australia/Sydney' });
  await Item.create({
    workspaceId: 'ws_1',
    boardId: 'bd_1',
    folderId: 'fld_profiles',
    itemId: 'pp_1',
    data: {
      'Full Name/Preferred Name': 'Jane Roe',
      'Billing Contact': 'Roe Family Trust',
      'Billing Address': '12 Smith St, Blacktown, NSW, 2148',
      Email: 'billing@example.com',
    },
  });
}

describe('handleXeroInvoiceParticipantTax', () => {
  it('rejects an empty item list', async () => {
    const args = taxArgs({ items: [] });

    await handleXeroInvoiceParticipantTax(args);

    expect(args.res.status).toHaveBeenCalledWith(400);
    expect(args.res.json).toHaveBeenCalledWith({ message: 'No items provided for invoice generation.' });
    expect(xero.configure).not.toHaveBeenCalled();
  });

  it('rejects a request with neither a participant name nor one on the first item', async () => {
    const args = taxArgs({ participantName: '', items: [taxItem({ participant: undefined })] });

    await handleXeroInvoiceParticipantTax(args);

    expect(args.res.status).toHaveBeenCalledWith(400);
    expect(args.res.json).toHaveBeenCalledWith({ message: 'Participant name is required.' });
  });

  it('creates the participant tax invoice from the participant contributions', async () => {
    await seedParticipantTaxFixtures();
    xero.createInvoice.mockResolvedValue({
      invoiceNumber: 'INV-900', invoiceID: 'xid_900', url: 'https://xero.example.com/inv/900',
    });
    const args = taxArgs();

    await handleXeroInvoiceParticipantTax(args);

    expect(args.error).not.toHaveBeenCalled();
    expect(xero.createInvoice).toHaveBeenCalledWith({
      type: 'ACCREC',
      contact: { contactID: 'xc_1' },
      reference: 'Participant Tax Invoice - Roe Family Trust',
      lineAmountTypes: 'Exclusive',
      lineItems: [{
        description: 'Community access support - 11/03/2025',
        quantity: 2,
        unitAmount: 15,
        lineAmount: 30,
        accountCode: XERO_DEFAULT_ACCOUNT_CODES.invoice,
        taxType: 'EXEMPTOUTPUT',
      }],
      date: '2025-03-15T00:00:00Z',
      dueDate: '2025-03-29T00:00:00.000Z',
      status: 'DRAFT',
    });
    expect(isoplus.setIntegrationMessage).toHaveBeenCalledWith(
      'ws_1', 'bd_1', 'itm_5001', 'Your participant tax invoice has been created successfully in Xero.',
    );
    expect(isoplus.setGeneratedField).toHaveBeenCalledWith('ws_1', 'bd_1', 'itm_5001', 'INV-900 (Xero)');
    expect(args.saveInvoiceNumber).toHaveBeenCalledWith('ws_1', 'bd_1', 'itm_5001', 'INV-900 (Xero)', 'Xero');
    expect(logAuditTrail).toHaveBeenCalledWith(expect.objectContaining({
      action: 'Create Xero Participant Tax Invoice',
      detail: 'Invoice created successfully, invoice number: INV-900, participant: Roe Family Trust, items: 1',
    }));
    expect(args.res.status).toHaveBeenCalledWith(200);
    expect(args.res.json).toHaveBeenCalledWith({
      message: 'Participant Tax Invoice generated successfully in Xero',
      invoiceNumber: 'INV-900',
      invoiceId: 'xid_900',
      invoiceUrl: 'https://xero.example.com/inv/900',
      itemCount: 1,
      participantName: 'Roe Family Trust',
    });
  });

  it('bills the full amount and relabels everything for a low-cat board', async () => {
    await seedParticipantTaxFixtures();
    xero.createInvoice.mockResolvedValue({ invoiceNumber: 'INV-901' });
    const args = taxArgs({ isLowCat: true, dueDate: '2025-04-01T00:00:00Z' });

    await handleXeroInvoiceParticipantTax(args);

    const payload = xero.createInvoice.mock.calls[0][0];
    expect(payload.reference).toBe('Tax Invoice - Roe Family Trust');
    expect(payload.dueDate).toBe('2025-04-01T00:00:00Z');
    expect(payload.lineItems[0]).toMatchObject({ lineAmount: 120, unitAmount: 60, quantity: 2 });
    expect(isoplus.setIntegrationMessage).toHaveBeenCalledWith(
      'ws_1', 'bd_1', 'itm_5001', 'Your tax invoice has been created successfully in Xero.',
    );
    expect(logAuditTrail).toHaveBeenCalledWith(expect.objectContaining({
      action: 'Create Xero Tax Invoice',
      detail: expect.stringContaining('receiver: Roe Family Trust'),
    }));
    expect(args.res.json.mock.calls[0][0].message).toBe('Tax Invoice generated successfully in Xero');
  });

  it('answers 400 and tells ISO+ when every line rounds to zero', async () => {
    await seedParticipantTaxFixtures();
    const args = taxArgs({ items: [taxItem({ participantContribution: 0, totalAmount: 0 })] });

    await handleXeroInvoiceParticipantTax(args);

    expect(xero.createInvoice).not.toHaveBeenCalled();
    expect(isoplus.setIntegrationMessage).toHaveBeenCalledWith(
      'ws_1', 'bd_1', 'itm_5001', 'There is nothing to invoice!',
    );
    expect(args.res.status).toHaveBeenCalledWith(400);
    expect(args.res.json).toHaveBeenCalledWith({ message: 'There is nothing to invoice!' });
  });

  it('answers 500 and marks every item when the business is missing', async () => {
    const args = taxArgs();

    await handleXeroInvoiceParticipantTax(args);

    expect(args.res.status).toHaveBeenCalledWith(500);
    expect(args.res.json).toHaveBeenCalledWith({ message: 'Business not found' });
    expect(isoplus.setIntegrationMessage).toHaveBeenCalledWith(
      'ws_1', 'bd_1', 'itm_5001', 'Error: Business not found',
    );
    expect(args.error).toHaveBeenCalledWith(
      'Xero-Service',
      'Error creating participant tax invoice in Xero',
      { message: 'Business not found', workspaceId: 'ws_1', boardId: 'bd_1', itemCount: 1 },
      args.req,
    );
  });

  it('answers 500 when no participant profile row matches the name', async () => {
    await Business.create({ workspaceId: 'ws_1', name: 'Hills Grade Care' });
    const args = taxArgs({ participantName: 'Nobody At All' });

    await handleXeroInvoiceParticipantTax(args);

    expect(args.res.status).toHaveBeenCalledWith(500);
    expect(args.res.json).toHaveBeenCalledWith({ message: 'Participant profile item not found' });
  });

  it('answers 500 when Xero rejects the invoice', async () => {
    await seedParticipantTaxFixtures();
    xero.createInvoice.mockRejectedValue(new Error('Xero refused'));
    const args = taxArgs();

    await handleXeroInvoiceParticipantTax(args);

    expect(args.saveInvoiceNumber).not.toHaveBeenCalled();
    expect(args.res.status).toHaveBeenCalledWith(500);
    expect(args.res.json).toHaveBeenCalledWith({ message: 'Xero refused' });
  });

  it('validates every item against the tenant before contacting Xero', async () => {
    await seedParticipantTaxFixtures();
    xero.createInvoice.mockResolvedValue({ invoiceNumber: 'INV-902' });
    const args = taxArgs({ items: [taxItem(), taxItem({ id: 'itm_5002' })] });

    await handleXeroInvoiceParticipantTax(args);

    expect(isoplus.validateItemBelongsToTenant).toHaveBeenCalledWith('ws_1', 'bd_1', 'itm_5001');
    expect(isoplus.validateItemBelongsToTenant).toHaveBeenCalledWith('ws_1', 'bd_1', 'itm_5002');
    expect(xero.ensureAuthenticated).toHaveBeenCalledWith('ws_1');
    expect(xero.createInvoice.mock.calls[0][0].lineItems).toHaveLength(2);
  });
});
