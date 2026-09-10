import { describe, it, expect, vi, beforeEach } from 'vitest';

// External boundaries only: PDF rendering, the ISO+ HTTP API and S3. The
// templates in src/assets are read for real, the quote/invoice line maths runs
// for real, and the participant-profile lookup hits the in-memory Mongo that
// test/setup.js starts.
vi.mock('@pdfme/generator', () => ({ generate: vi.fn() }));
vi.mock('../../../src/services/isoplus.js', () => ({
  validateItemBelongsToTenant: vi.fn(),
  setIntegrationMessage: vi.fn(),
  setGeneratedField: vi.fn(),
  getQuoteNDISReferencedItems: vi.fn(),
  getNDISMasterPlanReferencedItems: vi.fn(),
}));
vi.mock('../../../src/utils/ndisMasterPlanLineHelpers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildNdisMasterPlanInvoiceLines: vi.fn() };
});

const { generate } = await import('@pdfme/generator');
const isoplus = await import('../../../src/services/isoplus.js');
const { buildNdisMasterPlanInvoiceLines } = await import('../../../src/utils/ndisMasterPlanLineHelpers.js');
const Item = (await import('../../../src/models/Item.js')).default;

const {
  processWebhookNdisQuotePdfItem,
  processWebhookNdisInvoicePdfItem,
} = await import('../../../src/utils/webhookNdisPdfHandlers.js');

// ---------------------------------------------------------------------------
// Collaborators, reproduced from src/routes/webhook.js (the only caller).
// ---------------------------------------------------------------------------

/** webhook.js formatValue: 2dp for anything numeric, pass-through otherwise. */
function formatValue(val) {
  const num = Number(val);
  if (!isNaN(num)) return (Math.round(num * 100) / 100).toFixed(2);
  return val;
}

/**
 * Stands in for webhook.js formatDateNumericAU. It records exactly what the
 * handler passed so the Z-stripping and timezone choice can be asserted.
 */
const formatDateNumericAU = (value, timeZone) => `${value === null ? 'NULL' : value}@${timeZone}`;

const enableRepeatHeadOnTables = vi.fn((template) => {
  template.__repeatHeadEnabled = true;
});

function makeBusiness(overrides = {}) {
  return {
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
      quote: { prefix: 'QT-', nextNumber: 7 },
      invoice: { prefix: 'INV-', nextNumber: 41 },
    },
    save: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeHandlerArgs(overrides = {}) {
  return {
    req: { body: {} },
    res: { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() },
    workspaceId: 'ws_1',
    boardId: 'bd_1',
    getLogoData: vi.fn(async () => 'data:image/png;base64,LOGO'),
    enableRepeatHeadOnTables,
    formatValue,
    formatDateNumericAU,
    isEmpty: (value) => value === undefined || value === null || value === '',
    uploadFileToS3: vi.fn(async () => ({ $metadata: { httpStatusCode: 200 } })),
    getS3FileUrl: vi.fn(async () => 'https://s3.example.com/signed.pdf'),
    handlePDFSuccess: vi.fn(async () => {}),
    handlePDFError: vi.fn(async () => {}),
    saveInvoiceNumber: vi.fn(async () => {}),
    ...overrides,
  };
}

const QUOTE_VALUES = {
  'Issue Date': '2025-03-01T00:00:00Z',
  'Expiry Date': '2025-03-31T00:00:00Z',
  'From Date': '2025-04-01T00:00:00Z',
  'To Date': '2025-04-30T00:00:00Z',
  'Days of the Week': ['Monday', 'Wednesday'],
  'Recipient of the Quote': 'Jane Roe',
  'Recipient Address': '12 Smith St',
  Suburb: 'Blacktown',
  State: 'NSW',
  Postcode: '2148',
  'Direct Support Item Number': '01_011_0107_1_1',
  'Unit (Direct Support)': 'Hour',
  'Quantity (Direct Support)': 3,
  'Unit Price for Direct Support($)': 60.5,
  'Provider Travel - Non-Labour Cost Item Number': '02_051_0108_1_1',
  'Unit (Provider Travel - Non-Labour Cost)': 'Each',
  'Quantity (Provider Travel)': 2,
  'Unit Price for Provider Travel($)': 1.5,
};

const QUOTE_REFS = [
  { serviceArea: 'NSW Metro' },
  { itemName: 'Assistance with self-care' },
  { itemName: 'Provider travel' },
  null,
  null,
  null,
];

function quoteItem(overrides = {}) {
  return { id: 'itm_quote_1', values: { ...QUOTE_VALUES }, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  generate.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
});

describe('processWebhookNdisQuotePdfItem', () => {
  it('renders, uploads and reports a quote PDF, then advances the quote number', async () => {
    isoplus.getQuoteNDISReferencedItems.mockResolvedValue(QUOTE_REFS);
    const business = makeBusiness();
    const args = makeHandlerArgs();
    const item = quoteItem();

    await processWebhookNdisQuotePdfItem({ ...args, business, item });

    expect(args.handlePDFError).not.toHaveBeenCalled();
    expect(isoplus.validateItemBelongsToTenant).toHaveBeenCalledWith('ws_1', 'bd_1', 'itm_quote_1');
    expect(isoplus.setIntegrationMessage).toHaveBeenCalledWith('ws_1', 'bd_1', 'itm_quote_1', 'Running...');

    const inputs = generate.mock.calls[0][0].inputs[0];
    // 3 x 60.50 = 181.50 and 2 x 1.50 = 3.00, so the subtotal is 184.50 and,
    // with a GST rate of 0%, the total equals it.
    expect(JSON.parse(inputs.orders)).toEqual([
      ['01_011_0107_1_1-Assistance with self-care - Hour', 'Hour', '3.00', '60.50', 'GST Free', '181.50'],
      ['02_051_0108_1_1-Provider travel - Each', 'Each', '2.00', '1.50', 'GST Free', '3.00'],
    ]);
    expect(inputs.subtotal).toBe('184.50');
    expect(inputs.totalGST).toBe('0.00');
    expect(inputs.total).toBe('184.50');
    expect(inputs.logo).toBe('data:image/png;base64,LOGO');
    expect(JSON.parse(inputs.clientDetails)).toEqual({
      Address: '12 Smith St',
      Suburb: 'Blacktown',
      State: 'NSW',
      Postcode: '2148',
      Client: 'Jane Roe',
    });
    expect(JSON.parse(inputs.quoteDetails)).toEqual({
      'Issue Date': '2025-03-01T00:00:00@Australia/Sydney',
      'expiry Date': '2025-03-31T00:00:00@Australia/Sydney',
      'Quote Number': 'QT-7',
    });
    expect(JSON.parse(inputs.companyDetails)).toEqual({
      ABN: '12 345 678 901',
      'Street Address': '5 Wattle St',
      Suburb: 'Parramatta',
      State: 'NSW',
      Postcode: '2150',
      Country: 'Australia',
    });
    expect(JSON.parse(inputs.termsInputs)).toEqual({
      'Accounts Receivable Payment Terms': '14 days from invoice date',
    });
    expect(JSON.parse(inputs.field17)).toEqual({
      'From Date': '2025-04-01T00:00:00@Australia/Sydney',
      'To Date': '2025-04-30T00:00:00@Australia/Sydney',
      'Days of the week': 'Monday, Wednesday',
    });

    // The quote is a client billing document, so it goes to the non-public
    // bucket and is served by a presigned URL. `publicRead` is asserted as
    // exactly false, not merely falsy: uploading to one bucket and signing
    // against the other yields a URL that 404s.
    expect(args.uploadFileToS3).toHaveBeenCalledWith(
      Buffer.from(new Uint8Array([1, 2, 3, 4])),
      'output/ws_1/bd_1/NDIS-quote/QT-7-ISO+™-itm_quote_1.pdf',
      false,
    );
    expect(args.getS3FileUrl).toHaveBeenCalledWith(
      'output/ws_1/bd_1/NDIS-quote/QT-7-ISO+™-itm_quote_1.pdf',
      604800,
      false,
    );
    expect(args.handlePDFSuccess).toHaveBeenCalledWith(
      'ws_1', 'bd_1', 'itm_quote_1', 'https://s3.example.com/signed.pdf', 'NDIS Quote', args.req, args.res,
    );
    expect(isoplus.setGeneratedField).toHaveBeenCalledWith('ws_1', 'bd_1', 'itm_quote_1', 'QT-7 (ISO+™)');
    expect(business.documentNumbering.quote.nextNumber).toBe(8);
    expect(business.save).toHaveBeenCalledTimes(1);
  });

  it('renders the real NDISquote template with repeating table heads enabled', async () => {
    isoplus.getQuoteNDISReferencedItems.mockResolvedValue(QUOTE_REFS);

    await processWebhookNdisQuotePdfItem({ ...makeHandlerArgs(), business: makeBusiness(), item: quoteItem() });

    const template = generate.mock.calls[0][0].template;
    expect(Array.isArray(template.schemas)).toBe(true);
    expect(template.__repeatHeadEnabled).toBe(true);
  });

  it('falls back to a single space for the days of the week when none are set', async () => {
    isoplus.getQuoteNDISReferencedItems.mockResolvedValue(QUOTE_REFS);
    const item = quoteItem({ values: { ...QUOTE_VALUES, 'Days of the Week': [] } });

    await processWebhookNdisQuotePdfItem({ ...makeHandlerArgs(), business: makeBusiness(), item });

    expect(JSON.parse(generate.mock.calls[0][0].inputs[0].field17)['Days of the week']).toBe(' ');
  });

  it('passes null dates through when the quote has no issue or expiry date', async () => {
    isoplus.getQuoteNDISReferencedItems.mockResolvedValue(QUOTE_REFS);
    const item = quoteItem({ values: { ...QUOTE_VALUES, 'Issue Date': '', 'Expiry Date': undefined } });

    await processWebhookNdisQuotePdfItem({ ...makeHandlerArgs(), business: makeBusiness(), item });

    const quoteDetails = JSON.parse(generate.mock.calls[0][0].inputs[0].quoteDetails);
    expect(quoteDetails['Issue Date']).toBe('NULL@Australia/Sydney');
    expect(quoteDetails['expiry Date']).toBe('NULL@Australia/Sydney');
  });

  it('routes a missing Service Area to handlePDFError and never renders', async () => {
    isoplus.getQuoteNDISReferencedItems.mockResolvedValue([undefined, { itemName: 'x' }]);
    const business = makeBusiness();
    const args = makeHandlerArgs();

    await processWebhookNdisQuotePdfItem({ ...args, business, item: quoteItem() });

    expect(generate).not.toHaveBeenCalled();
    expect(args.handlePDFError).toHaveBeenCalledTimes(1);
    const [err, workspaceId, boardId, itemId, label] = args.handlePDFError.mock.calls[0];
    expect(err.message).toBe('Service Area value is required.');
    expect([workspaceId, boardId, itemId, label]).toEqual(['ws_1', 'bd_1', 'itm_quote_1', 'Generate PDF NDIS Quote']);
    expect(business.documentNumbering.quote.nextNumber).toBe(7);
    expect(business.save).not.toHaveBeenCalled();
  });

  it('routes a failed S3 upload to handlePDFError without advancing the quote number', async () => {
    isoplus.getQuoteNDISReferencedItems.mockResolvedValue(QUOTE_REFS);
    const business = makeBusiness();
    const args = makeHandlerArgs({
      uploadFileToS3: vi.fn(async () => ({ $metadata: { httpStatusCode: 403 } })),
    });

    await processWebhookNdisQuotePdfItem({ ...args, business, item: quoteItem() });

    expect(args.getS3FileUrl).not.toHaveBeenCalled();
    expect(args.handlePDFError.mock.calls[0][0].message)
      .toBe('Upload of PDF failed, please provide correct information.');
    expect(business.documentNumbering.quote.nextNumber).toBe(7);
  });

  it('routes a tenancy validation failure to handlePDFError before touching ISO+', async () => {
    isoplus.validateItemBelongsToTenant.mockRejectedValueOnce(new Error('Item does not belong to this board'));
    const args = makeHandlerArgs();

    await processWebhookNdisQuotePdfItem({ ...args, business: makeBusiness(), item: quoteItem() });

    expect(isoplus.setIntegrationMessage).not.toHaveBeenCalled();
    expect(args.handlePDFError.mock.calls[0][0].message).toBe('Item does not belong to this board');
  });
});

const INVOICE_VALUES = {
  'Invoice Date': '2025-03-15T00:00:00Z',
  'Due Date': '2025-03-29T00:00:00Z',
  'Actual Shift Start Date and Time': '2025-03-10T22:00:00Z',
  'Group Size': '2',
};

function invoiceItem(overrides = {}) {
  return { id: 'itm_master_1', values: { ...INVOICE_VALUES }, ...overrides };
}

const NDIS_LINES = [
  { desc: '01_011_0107_1_1 Assistance with self-care', unit: 'Hour', qty: 2, unitPrice: 67.56, amount: 135.12 },
  { desc: '02_051_0108_1_1 Provider travel', unit: 'Each', qty: 1, unitPrice: 4.5, amount: 4.5 },
];

const MASTER_PLAN_REFS = [
  { servicePlanId: 'sp_1' },
  { cancellationType: 'Short notice' },
  null,
  { fullName: 'Jane Roe', firstName: 'Jane', lastName: 'Roe', email: 'jane@example.com' },
];

describe('processWebhookNdisInvoicePdfItem', () => {
  it('renders, uploads and records an NDIS invoice PDF', async () => {
    isoplus.getNDISMasterPlanReferencedItems.mockResolvedValue(MASTER_PLAN_REFS);
    buildNdisMasterPlanInvoiceLines.mockResolvedValue(NDIS_LINES);
    const business = makeBusiness();
    const args = makeHandlerArgs();

    await processWebhookNdisInvoicePdfItem({ ...args, business, item: invoiceItem() });

    expect(args.handlePDFError).not.toHaveBeenCalled();
    const inputs = generate.mock.calls[0][0].inputs[0];
    // 135.12 + 4.50 = 139.62, GST rate 0%.
    expect(inputs.subtotal).toBe('139.62');
    expect(inputs.totalGST).toBe('0.00');
    expect(inputs.total).toBe('139.62');
    // The service date is the actual shift start rendered in the business
    // timezone: 2025-03-10T22:00Z is 11 March 2025 09:00 in Sydney.
    expect(JSON.parse(inputs.orders)).toEqual([
      ['11/03/2025', '01_011_0107_1_1 Assistance with self-care', 'Hour', '2.00', '67.56', 'GST Free', '135.12'],
      ['11/03/2025', '02_051_0108_1_1 Provider travel', 'Each', '1.00', '4.50', 'GST Free', '4.50'],
    ]);
    expect(JSON.parse(inputs.invoiceDetails)).toEqual({
      Date: '2025-03-15T00:00:00@Australia/Sydney',
      'Invoice Number': 'INV-41',
    });
    expect(inputs.dueDate).toBe('2025-03-29T00:00:00@Australia/Sydney');
    expect(JSON.parse(inputs['Bank Details'])).toEqual({
      'Account Name': 'Hills Grade Care Pty Ltd',
      'Bank Name': 'Big Bank',
      BSB: '062-000',
      'Account Number': '12345678',
      'invoice Number': 'INV-41',
    });
    // No master-plan row exists in Mongo, so the client block comes from the
    // ISO+ profile values.
    expect(JSON.parse(inputs.clientDetails)).toEqual({
      Contact: 'Jane Roe',
      Address: ' ',
      'Participant Name': 'Jane Roe',
      'NDIS Number': ' ',
    });

    expect(args.uploadFileToS3).toHaveBeenCalledWith(
      Buffer.from(new Uint8Array([1, 2, 3, 4])),
      'output/ws_1/bd_1/NDIS-invoices/INV-41-ISO+™-itm_master_1.pdf',
      false,
    );
    expect(args.getS3FileUrl).toHaveBeenCalledWith(
      'output/ws_1/bd_1/NDIS-invoices/INV-41-ISO+™-itm_master_1.pdf',
      604800,
      false,
    );
    // The document details travel with the success call so the row it writes
    // can be found by a statement. Without them the row carries no participant,
    // no board and no total, and the statement — which matches on exactly
    // those — can never see the invoice.
    expect(args.handlePDFSuccess).toHaveBeenCalledWith(
      'ws_1', 'bd_1', 'itm_master_1', 'https://s3.example.com/signed.pdf', 'NDIS Invoice', args.req, args.res,
      {
        participant: 'Jane Roe',
        invoiceNumber: 'INV-41 (ISO+™)',
        invoiceTotal: 139.62,
        invoiceDate: '2025-03-15T00:00:00',
      },
    );
    expect(isoplus.setGeneratedField).toHaveBeenCalledWith('ws_1', 'bd_1', 'itm_master_1', 'INV-41 (ISO+™)');
    expect(args.saveInvoiceNumber).toHaveBeenCalledWith(
      'ws_1', 'bd_1', 'itm_master_1', 'INV-41 (ISO+™)', 'PDF', 'https://s3.example.com/signed.pdf',
    );
    expect(business.documentNumbering.invoice.nextNumber).toBe(42);
    expect(business.save).toHaveBeenCalledTimes(1);
  });

  it('builds the client block from the stored participant profile when one exists', async () => {
    await Item.insertMany([
      {
        workspaceId: 'ws_1',
        boardId: 'bd_1',
        folderId: 'fld_master',
        itemId: 'itm_master_1',
        data: { 'Participant Profile': ['pp_1'] },
      },
      {
        workspaceId: 'ws_1',
        boardId: 'bd_1',
        folderId: 'fld_profiles',
        itemId: 'pp_1',
        data: {
          'Full Name/Preferred Name': 'Janet Roe',
          'Billing Contact': 'Roe Family Trust',
          'Billing Address': '12 Smith St, Blacktown, NSW 2148',
          'NDIS Number': '430 123 456',
        },
      },
    ]);
    isoplus.getNDISMasterPlanReferencedItems.mockResolvedValue(MASTER_PLAN_REFS);
    buildNdisMasterPlanInvoiceLines.mockResolvedValue(NDIS_LINES);

    await processWebhookNdisInvoicePdfItem({
      ...makeHandlerArgs(),
      business: makeBusiness(),
      item: invoiceItem(),
    });

    expect(JSON.parse(generate.mock.calls[0][0].inputs[0].clientDetails)).toEqual({
      Contact: 'Roe Family Trust',
      Address: '12 Smith St, Blacktown, NSW 2148',
      'Participant Name': 'Janet Roe',
      'NDIS Number': '430123456',
    });
  });

  it('passes the master plan context through to the line builder', async () => {
    isoplus.getNDISMasterPlanReferencedItems.mockResolvedValue(MASTER_PLAN_REFS);
    buildNdisMasterPlanInvoiceLines.mockResolvedValue(NDIS_LINES);

    await processWebhookNdisInvoicePdfItem({
      ...makeHandlerArgs(),
      business: makeBusiness(),
      item: invoiceItem(),
    });

    const ctx = buildNdisMasterPlanInvoiceLines.mock.calls[0][0];
    expect(ctx).toMatchObject({
      workspaceId: 'ws_1',
      boardId: 'bd_1',
      itemId: 'itm_master_1',
      servicePlanValues: MASTER_PLAN_REFS[0],
      cancellationTypeValues: MASTER_PLAN_REFS[1],
      groupSize: 2,
      timezone: 'Australia/Sydney',
      awaitIntegrationMessage: false,
    });
  });

  it('defaults the group size to 1 and the timezone to Sydney when neither is set', async () => {
    isoplus.getNDISMasterPlanReferencedItems.mockResolvedValue(MASTER_PLAN_REFS);
    buildNdisMasterPlanInvoiceLines.mockResolvedValue(NDIS_LINES);
    const business = makeBusiness({ headOfficeTimezone: undefined });

    await processWebhookNdisInvoicePdfItem({
      ...makeHandlerArgs(),
      business,
      item: invoiceItem({ values: { ...INVOICE_VALUES, 'Group Size': '' } }),
    });

    const ctx = buildNdisMasterPlanInvoiceLines.mock.calls[0][0];
    expect(ctx.groupSize).toBe(1);
    expect(ctx.timezone).toBe('Australia/Sydney');
  });

  it('answers 200 with "There is nothing to invoice!" when no lines are built', async () => {
    isoplus.getNDISMasterPlanReferencedItems.mockResolvedValue(MASTER_PLAN_REFS);
    buildNdisMasterPlanInvoiceLines.mockResolvedValue([]);
    const business = makeBusiness();
    const args = makeHandlerArgs();

    await processWebhookNdisInvoicePdfItem({ ...args, business, item: invoiceItem() });

    expect(isoplus.setIntegrationMessage).toHaveBeenLastCalledWith(
      'ws_1', 'bd_1', 'itm_master_1', 'There is nothing to invoice!',
    );
    expect(args.res.status).toHaveBeenCalledWith(200);
    expect(args.res.json).toHaveBeenCalledWith({ message: 'There is nothing to invoice!' });
    expect(generate).not.toHaveBeenCalled();
    expect(args.uploadFileToS3).not.toHaveBeenCalled();
    expect(business.documentNumbering.invoice.nextNumber).toBe(41);
  });

  it.each([
    ['participant profile', [{ servicePlanId: 'sp_1' }, null, null, undefined]],
    ['service plan', [undefined, null, null, { fullName: 'Jane Roe' }]],
  ])('routes a missing %s reference to handlePDFError', async (_label, refs) => {
    isoplus.getNDISMasterPlanReferencedItems.mockResolvedValue(refs);
    const args = makeHandlerArgs();

    await processWebhookNdisInvoicePdfItem({ ...args, business: makeBusiness(), item: invoiceItem() });

    expect(generate).not.toHaveBeenCalled();
    const [err, , , , label] = args.handlePDFError.mock.calls[0];
    expect(err.message).toBe('Participant Profile and Service Plan information is required.');
    expect(label).toBe('Generate PDF NDIS Invoice');
  });

  it('routes a failed S3 upload to handlePDFError and never saves an invoice number', async () => {
    isoplus.getNDISMasterPlanReferencedItems.mockResolvedValue(MASTER_PLAN_REFS);
    buildNdisMasterPlanInvoiceLines.mockResolvedValue(NDIS_LINES);
    const business = makeBusiness();
    const args = makeHandlerArgs({
      uploadFileToS3: vi.fn(async () => ({ $metadata: { httpStatusCode: 500 } })),
    });

    await processWebhookNdisInvoicePdfItem({ ...args, business, item: invoiceItem() });

    expect(args.saveInvoiceNumber).not.toHaveBeenCalled();
    expect(args.handlePDFError.mock.calls[0][0].message)
      .toBe('Upload of PDF failed, please provide correct information.');
    expect(business.documentNumbering.invoice.nextNumber).toBe(41);
  });

  it('uses the scheduled shift start for a cancelled job', async () => {
    isoplus.getNDISMasterPlanReferencedItems.mockResolvedValue(MASTER_PLAN_REFS);
    buildNdisMasterPlanInvoiceLines.mockResolvedValue([NDIS_LINES[0]]);

    await processWebhookNdisInvoicePdfItem({
      ...makeHandlerArgs(),
      business: makeBusiness(),
      item: invoiceItem({
        values: {
          ...INVOICE_VALUES,
          'Job Status': 'Cancelled',
          'Scheduled Shift Start Date & Time': '2025-03-01T22:00:00Z',
        },
      }),
    });

    expect(JSON.parse(generate.mock.calls[0][0].inputs[0].orders)[0][0]).toBe('02/03/2025');
  });
});

// ---------------------------------------------------------------------------
// Where the generated PDFs land. These documents carry participant names,
// addresses and amounts at keys built from sequential document numbers, so the
// bucket they go to is the point of this suite: AWS_BUCKET (publicRead false),
// never AWS_BUCKET_PUBLIC.
// ---------------------------------------------------------------------------

/** The publicRead argument both S3 calls take, read off the recorded calls. */
function s3Destination(args) {
  return {
    uploadKey: args.uploadFileToS3.mock.calls[0][1],
    uploadPublicRead: args.uploadFileToS3.mock.calls[0][2],
    urlKey: args.getS3FileUrl.mock.calls[0][0],
    urlExpiry: args.getS3FileUrl.mock.calls[0][1],
    urlPublicRead: args.getS3FileUrl.mock.calls[0][2],
  };
}

describe('generated NDIS documents go to the non-public bucket', () => {
  it('uploads and signs an NDIS quote against the same, non-public bucket', async () => {
    isoplus.getQuoteNDISReferencedItems.mockResolvedValue(QUOTE_REFS);
    const args = makeHandlerArgs();

    await processWebhookNdisQuotePdfItem({ ...args, business: makeBusiness(), item: quoteItem() });

    const s3 = s3Destination(args);
    expect(s3.uploadPublicRead).toBe(false);
    expect(s3.urlPublicRead).toBe(false);
    // Upload and URL must agree, or the signature is against the wrong bucket.
    expect(s3.urlPublicRead).toBe(s3.uploadPublicRead);
    expect(s3.urlKey).toBe(s3.uploadKey);
    expect(s3.urlExpiry).toBe(604800);
    // output/<workspaceId>/<boardId>/<type>/<name>, with the type folder
    // exactly the one already in the bucket.
    expect(s3.uploadKey).toBe('output/ws_1/bd_1/NDIS-quote/QT-7-ISO+™-itm_quote_1.pdf');
  });

  it('uploads and signs an NDIS invoice against the same, non-public bucket', async () => {
    isoplus.getNDISMasterPlanReferencedItems.mockResolvedValue(MASTER_PLAN_REFS);
    buildNdisMasterPlanInvoiceLines.mockResolvedValue(NDIS_LINES);
    const args = makeHandlerArgs();

    await processWebhookNdisInvoicePdfItem({ ...args, business: makeBusiness(), item: invoiceItem() });

    const s3 = s3Destination(args);
    expect(s3.uploadPublicRead).toBe(false);
    expect(s3.urlPublicRead).toBe(false);
    expect(s3.urlPublicRead).toBe(s3.uploadPublicRead);
    expect(s3.urlKey).toBe(s3.uploadKey);
    expect(s3.urlExpiry).toBe(604800);
    expect(s3.uploadKey).toBe('output/ws_1/bd_1/NDIS-invoices/INV-41-ISO+™-itm_master_1.pdf');
  });
});
