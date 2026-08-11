import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

import {
  buildMonthlyStatementDeps,
  handleMonthlyStatementRoute,
} from '../../../src/utils/webhookMonthlyStatementPdfHelpers.js';

// ---------------------------------------------------------------------------
// Collaborators. Every one of these is injected by src/routes/webhook.js, so
// the test supplies the same behaviour: the small pure ones (setCurrencyField,
// setMultiValueField, applyBudgetMapping, normalizeStatus, normalizeTableCell,
// getQuarterMetadata, formatDateToAU, safeString, parseNumberValue) are copied
// from webhook.js; the heavy ones (template rendering, S3, ISO+ fetches) are
// recorders. Everything the module under test computes runs for real.
// ---------------------------------------------------------------------------

function parseNumberValue(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const s = value.toString().trim();
  if (!s) return 0;
  const parsed = parseFloat(s.replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatValue(val) {
  const num = Number(val);
  if (!isNaN(num)) return (Math.round(num * 100) / 100).toFixed(2);
  return val;
}

function formatCurrencyValue(value) {
  const num = parseNumberValue(value);
  const formatted = formatValue(num);
  return num < 0 ? `-$${formatted.replace(/^-/, '')}` : `$${formatted}`;
}

function formatDateToAU(value, timezone) {
  if (!value) return '';
  if (typeof value === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(value.trim())) return value.trim();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-AU', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: timezone || 'Australia/Sydney',
  }).format(date);
}

function safeString(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return value.name || value.id || '';
  return String(value);
}

function setCurrencyField(target, fieldName, value) {
  if (!fieldName) return;
  target[fieldName] = formatCurrencyValue(value);
}

function setMultiValueField(target, fieldName, payload) {
  if (!fieldName || payload === undefined) return;
  target[fieldName] = JSON.stringify(payload);
}

function applyBudgetMapping(templateInputs, aggregate, mappings = []) {
  for (const entry of mappings) {
    const value = typeof entry.value === 'function' ? entry.value(aggregate) : entry.value;
    const fields = Array.isArray(entry.field) ? entry.field : [entry.field];
    for (const field of fields) {
      if (entry.type === 'currency') setCurrencyField(templateInputs, field, value);
      if (entry.type === 'multi') setMultiValueField(templateInputs, field, value);
    }
  }
}

function normalizeStatus(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.toLowerCase();
  if (typeof value === 'object') return (value.name || value.toString()).toLowerCase();
  return value.toString().toLowerCase();
}

function normalizeTableCell(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return value.toString();
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(normalizeTableCell).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    return Object.values(value).map(normalizeTableCell).filter(Boolean).join(', ') || '';
  }
  return String(value) || '';
}

function getQuarterMetadata(monthNumber, year, fallbackQuarterLabel, timezone) {
  const monthIndex = Number(monthNumber) || 1;
  const effectiveYear = Number(year) || new Date().getFullYear();
  return {
    monthNo: ((monthIndex - 1) % 3) + 1,
    quarterLabel: fallbackQuarterLabel || `Q${Math.floor((monthIndex - 1) / 3) + 1}`,
    firstDay: formatDateToAU(new Date(Date.UTC(effectiveYear, monthIndex - 1, 1)), timezone),
    lastDay: formatDateToAU(new Date(Date.UTC(effectiveYear, monthIndex, 0)), timezone),
  };
}

function initializeBudgetAggregate() {
  return {
    availableFundStart: 0,
    quarterlyAdjustment: 0,
    primarySupplementAmount: 0,
    carryoverFunding: 0,
    unspentReturned: 0,
    commonwealthUnspent: 0,
    providerUnspent: 0,
    participantUnspent: 0,
    previousMonthSpending: 0,
    totalAvailableBudget: 0,
    deliveredAmount: 0,
    adjustmentAmount: 0,
    remainingBalance: 0,
    committedFunds: 0,
    remainingBalanceEndOfMonth: 0,
    remainingBalanceAllocationPeriod: 0,
    fundAmount: 0,
    additionalAmountApproved: 0,
    fund: '',
    fundClassification: '',
    primarySupplementLabel: '',
    quarterLabel: '',
    fundingStartDate: null,
    fundingEndDate: null,
  };
}

function createServiceBuckets() {
  return {
    HSQ: { delivered: [], adjustment: [] },
    RCP: { delivered: [], adjustment: [] },
    EOL: { delivered: [], adjustment: [] },
    ATS: { delivered: [], adjustment: [], committed: [] },
    ATO: { delivered: [], adjustment: [], committed: [] },
    HMB: { delivered: [], adjustment: [], committed: [] },
  };
}

/** Trimmed copy of webhook.js SERVICE_TABLE_CONFIG: the two codes under test. */
const SERVICE_TABLE_CONFIG = {
  HSQ: {
    delivered: {
      tableName: 'Table P6-1 copy',
      columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
      totals: [['$P6-1  copy', '$P3-3'], ['$P6-2 copy', '$P3-4'], ['$P6-3 copy', '$P3-5']],
      rowType: 'delivered',
    },
    adjustment: {
      tableName: 'Table P7-1 copy',
      columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
      totals: ['$P7-1 copy', '$P7-2 copy', '$P7-3 copy'],
      rowType: 'adjustment',
    },
  },
  ATS: {
    delivered: {
      tableName: 'Table P10-1  copy',
      columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
      totals: ['$P10-1  copy', '$P10-3 copy', '$P10-3  copy'],
      rowType: 'delivered',
    },
    committed: {
      tableName: 'Table P10-2 copy',
      columns: ['date', 'service', 'unit', 'quantity', 'unitPrice', 'totalAmount', 'govSubsidy', 'participantContribution'],
      totals: ['$P10-4 copy', '$P10-5 copy', '$P10-6 copy'],
      rowType: 'committed',
    },
  },
};

/** Stand-in for webhook.js buildServiceTableRows: one row per service, real totals. */
function buildServiceTableRows(services = [], config = {}, business, timezone) {
  const totals = { amount: 0, gov: 0, participant: 0 };
  const rows = services.map((service) => {
    totals.amount += parseNumberValue(service.totalAmount);
    totals.gov += parseNumberValue(service.govSubsidy);
    totals.participant += parseNumberValue(service.participantContribution);
    return config.columns.map((column) => {
      if (column === 'date') return `${service.id}@${timezone}`;
      if (column === 'service') return `${service.service} (${business?.name})`;
      return service[column] ?? '';
    });
  });
  return { rows, totals };
}

const TEMPLATE_FIXTURE = {
  schemas: [
    [{ type: 'image', name: 'logo', content: 'TEMPLATE_DEFAULT_LOGO' }],
    [{ type: 'text', name: 'headerMonthlyStatement_p2', content: '' }],
    [{ type: 'text', name: 'headerMonthlyStatement_p3', content: '' }],
  ],
};

const TRANSPARENT_PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeFs({ miniChart = null, footer = Buffer.from('FOOT') } = {}) {
  const readFile = vi.fn(async (filePath) => {
    if (filePath.endsWith('monthlyStatement.json')) return JSON.stringify(TEMPLATE_FIXTURE);
    if (filePath.endsWith('mini-chart.png')) {
      if (!miniChart) throw new Error(`ENOENT: ${filePath}`);
      return miniChart;
    }
    if (filePath.endsWith('monthly-statement-footer.png')) {
      if (!footer) throw new Error(`ENOENT: ${filePath}`);
      return footer;
    }
    throw new Error(`unexpected read: ${filePath}`);
  });
  return { readFile };
}

function makeDeps(overrides = {}) {
  const { fsOptions, ...rest } = overrides;
  return buildMonthlyStatementDeps({
    path,
    fs: makeFs(fsOptions),
    getValidatedBusiness: vi.fn(async () => ({
      name: 'Hills Grade Care',
      companyRegistrationId: 'PRV-500',
      phone: '02 9000 0000',
      email: 'accounts@example.com',
      headOfficeTimezone: 'Australia/Sydney',
      address: { street: '5 Wattle St', suburb: 'Parramatta', state: 'NSW', postcode: '2150' },
    })),
    enableRepeatHeadOnTables: vi.fn(),
    ensureMonthlyStatementHeaderFromPage2: vi.fn(),
    getLogoData: vi.fn(async () => 'data:image/png;base64,BUSINESS_LOGO'),
    resolveTemplateImageUrls: vi.fn(async () => {}),
    getTemplateImageContentByName: (template, name) => {
      for (const page of template.schemas) {
        const match = page.find((s) => s.type === 'image' && s.name === name);
        if (match) return match.content;
      }
      return '';
    },
    applyTemplateTextDefaults: vi.fn(),
    calculateBudgetAggregates: vi.fn(() => ({})),
    enrichAggregateFromCategory: vi.fn((aggregate, category) => {
      Object.assign(aggregate, category);
    }),
    initializeBudgetAggregate,
    getQuarterMetadata,
    setMultiValueField,
    setCurrencyField,
    applyBudgetMapping,
    safeString,
    formatDateToAU,
    createServiceBuckets,
    determineFundingCode: (service) => service.code || 'HSQ',
    normalizeStatus,
    buildServiceTableRows,
    normalizeTableCell,
    parseNumberValue,
    uploadFileToS3: vi.fn(async () => ({ $metadata: { httpStatusCode: 200 } })),
    getS3FileUrl: vi.fn(async () => 'https://s3.example.com/statement.pdf'),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fetchBudgetItems: vi.fn(async () => []),
    fetchServiceItems: vi.fn(async () => []),
    generate: vi.fn(async () => new Uint8Array([9, 9, 9])),
    text: 'text-plugin',
    image: 'image-plugin',
    line: 'line-plugin',
    table: 'table-plugin',
    multiVariableText: 'mvt-plugin',
    SERVICE_TABLE_CONFIG,
    ...rest,
  });
}

function makeReq(bodyOverrides = {}) {
  return {
    params: { workspaceId: 'ws_1', boardId: 'bd_1' },
    body: {
      statementData: {
        participant: 'Jane Roe',
        month: 'March',
        monthNumber: '3',
        year: '2025',
        myAgedCareIdNumber: 'AC-9911',
        providerId: 'PRV-500',
        participantAddress: '12 Smith St',
        participantSuburb: 'Blacktown',
        participantState: 'NSW',
        participantPostcode: '2148',
        budgetCategories: [],
      },
      ...bodyOverrides,
    },
  };
}

function makeRes() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
}

function inputsFrom(deps) {
  return deps.generate.mock.calls[0][0].inputs[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildMonthlyStatementDeps', () => {
  it('returns the dependency bag unchanged', () => {
    const deps = { a: 1, generate: () => {} };
    expect(buildMonthlyStatementDeps(deps)).toBe(deps);
  });
});

describe('handleMonthlyStatementRoute', () => {
  it('rejects a request with no statement data before doing any work', async () => {
    const deps = makeDeps();
    const res = makeRes();

    await handleMonthlyStatementRoute({ params: { workspaceId: 'ws_1', boardId: 'bd_1' }, body: {} }, res, deps);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'No statement data provided.' });
    expect(deps.getValidatedBusiness).not.toHaveBeenCalled();
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it('generates, uploads and answers with the signed statement URL', async () => {
    const deps = makeDeps();
    const res = makeRes();

    await handleMonthlyStatementRoute(makeReq(), res, deps);

    expect(deps.uploadFileToS3).toHaveBeenCalledWith(
      Buffer.from(new Uint8Array([9, 9, 9])),
      'output/ws_1/bd_1/monthly-statements/Jane-Roe_March_2025_Statement.pdf',
      true,
    );
    expect(deps.getS3FileUrl).toHaveBeenCalledWith(
      'output/ws_1/bd_1/monthly-statements/Jane-Roe_March_2025_Statement.pdf',
      3600,
      true,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Monthly statement PDF generated successfully',
      fileUrl: 'https://s3.example.com/statement.pdf',
      filename: 'Jane-Roe_March_2025_Statement.pdf',
    });
  });

  it('answers 500 with the error message when the upload is rejected', async () => {
    const deps = makeDeps({
      uploadFileToS3: vi.fn(async () => ({ $metadata: { httpStatusCode: 403 } })),
    });
    const res = makeRes();

    await handleMonthlyStatementRoute(makeReq(), res, deps);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Upload of PDF failed, please provide correct information.',
      error: 'Upload of PDF failed, please provide correct information.',
    });
    expect(deps.error).toHaveBeenCalledWith(
      'Webhook-Service',
      'Error generating monthly statement PDF',
      expect.objectContaining({ message: 'Upload of PDF failed, please provide correct information.' }),
      expect.anything(),
    );
  });

  it('answers 500 when PDF rendering throws', async () => {
    const deps = makeDeps({ generate: vi.fn(async () => { throw new Error('pdfme exploded'); }) });
    const res = makeRes();

    await handleMonthlyStatementRoute(makeReq(), res, deps);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'pdfme exploded', error: 'pdfme exploded' });
    expect(deps.uploadFileToS3).not.toHaveBeenCalled();
  });

  it('slugifies the participant name and collapses whitespace in the month for the filename', async () => {
    const deps = makeDeps();
    const req = makeReq();
    req.body.statementData.participant = "Mary-Anne O'Brien";
    req.body.statementData.month = 'March 2025 Q1';

    await handleMonthlyStatementRoute(req, makeRes(), deps);

    expect(deps.uploadFileToS3.mock.calls[0][1]).toBe(
      'output/ws_1/bd_1/monthly-statements/Mary-Anne-O-Brien_March_2025_Q1_2025_Statement.pdf',
    );
  });

  // --- date range resolution -------------------------------------------------

  it('derives the month range in the business timezone when no dates are supplied', async () => {
    const deps = makeDeps();

    await handleMonthlyStatementRoute(makeReq(), makeRes(), deps);

    // March 2025 in Sydney is UTC+11 throughout, so the local month starts at
    // 2025-02-28T13:00Z and ends at 2025-03-31T12:59:59.999Z.
    expect(deps.fetchServiceItems).toHaveBeenCalledWith('ws_1', 'bd_1', {
      participant: 'Jane Roe',
      startDate: '2025-02-28T13:00:00.000Z',
      endDate: '2025-03-31T12:59:59.999Z',
    });
    expect(deps.fetchBudgetItems).toHaveBeenCalledWith('ws_1', 'bd_1', {
      participant: 'Jane Roe',
      month: '3',
      year: '2025',
    });
  });

  it('normalises supplied request dates to ISO instants', async () => {
    const deps = makeDeps();

    await handleMonthlyStatementRoute(
      makeReq({ startDate: '2025-03-05T00:00:00+11:00', endDate: '2025-03-06T00:00:00Z' }),
      makeRes(),
      deps,
    );

    expect(deps.fetchServiceItems.mock.calls[0][2]).toEqual({
      participant: 'Jane Roe',
      startDate: '2025-03-04T13:00:00.000Z',
      endDate: '2025-03-06T00:00:00.000Z',
    });
  });

  it('discards an inverted request range and falls back to the month range', async () => {
    const deps = makeDeps();

    await handleMonthlyStatementRoute(
      makeReq({ startDate: '2025-03-20T00:00:00Z', endDate: '2025-03-02T00:00:00Z' }),
      makeRes(),
      deps,
    );

    expect(deps.fetchServiceItems.mock.calls[0][2]).toEqual({
      participant: 'Jane Roe',
      startDate: '2025-02-28T13:00:00.000Z',
      endDate: '2025-03-31T12:59:59.999Z',
    });
  });

  it('ignores an unparsable request date and falls back to the month range', async () => {
    const deps = makeDeps();

    await handleMonthlyStatementRoute(
      makeReq({ startDate: 'not-a-date', endDate: '2025-03-06T00:00:00Z' }),
      makeRes(),
      deps,
    );

    expect(deps.fetchServiceItems.mock.calls[0][2].startDate).toBe('2025-02-28T13:00:00.000Z');
    expect(deps.fetchServiceItems.mock.calls[0][2].endDate).toBe('2025-03-06T00:00:00.000Z');
  });

  it('leaves both dates null when there is neither a request range nor a month', async () => {
    const deps = makeDeps();
    const req = makeReq();
    req.body.statementData.monthNumber = '';
    req.body.statementData.year = '';

    await handleMonthlyStatementRoute(req, makeRes(), deps);

    expect(deps.fetchServiceItems.mock.calls[0][2]).toEqual({
      participant: 'Jane Roe',
      startDate: null,
      endDate: null,
    });
  });

  it('prefers the client timezone only when the business has none', async () => {
    const deps = makeDeps({
      getValidatedBusiness: vi.fn(async () => ({ name: 'No TZ Co' })),
    });

    await handleMonthlyStatementRoute(makeReq({ timezone: 'Australia/Perth' }), makeRes(), deps);

    // Perth is UTC+8 all year: March starts at 2025-02-28T16:00Z.
    expect(deps.fetchServiceItems.mock.calls[0][2].startDate).toBe('2025-02-28T16:00:00.000Z');
  });

  // --- images ---------------------------------------------------------------

  it('uses a raw base64 chart from the frontend, prefixing the data URI scheme', async () => {
    const deps = makeDeps();
    const chartImage = 'A'.repeat(80);

    await handleMonthlyStatementRoute(makeReq({ chartImage }), makeRes(), deps);

    expect(inputsFrom(deps)['Summary Table']).toBe(`data:image/png;base64,${chartImage}`);
    expect(deps.info).toHaveBeenCalledWith(
      'Webhook-Service',
      'Monthly statement PDF: using chart image from frontend',
      { sizeChars: 80 },
      expect.anything(),
    );
  });

  it('passes a data-URI chart through untouched', async () => {
    const deps = makeDeps();
    const chartImage = `data:image/png;base64,${'B'.repeat(80)}`;

    await handleMonthlyStatementRoute(makeReq({ chartImage }), makeRes(), deps);

    expect(inputsFrom(deps)['Summary Table']).toBe(chartImage);
  });

  it('ignores a chart string of 50 characters or fewer', async () => {
    const deps = makeDeps();

    await handleMonthlyStatementRoute(makeReq({ chartImage: 'C'.repeat(50) }), makeRes(), deps);

    expect(inputsFrom(deps)['Summary Table']).toBe(TRANSPARENT_PNG_DATA_URI);
  });

  it('uses the transparent placeholder when every budget category is zero', async () => {
    const deps = makeDeps();
    const req = makeReq();
    req.body.statementData.budgetCategories = [
      { code: 'HSQ', availableFunds: 0, remainingBudget: 0, serviceDeliveredAmount: 0 },
      { code: 'ATS', availableFunds: '0', remainingBudget: null, serviceDeliveredAmount: undefined },
    ];

    await handleMonthlyStatementRoute(req, makeRes(), deps);

    expect(inputsFrom(deps)['Summary Table']).toBe(TRANSPARENT_PNG_DATA_URI);
  });

  it('falls back to the packaged mini-chart when a category carries a non-zero amount', async () => {
    const deps = makeDeps({ fsOptions: { miniChart: Buffer.from('MINI') } });
    const req = makeReq();
    req.body.statementData.budgetCategories = [
      { code: 'HSQ', availableFunds: 0, remainingBudget: 0, serviceDeliveredAmount: 12.5 },
    ];

    await handleMonthlyStatementRoute(req, makeRes(), deps);

    expect(inputsFrom(deps)['Summary Table']).toBe(`data:image/png;base64,${Buffer.from('MINI').toString('base64')}`);
    expect(deps.fs.readFile.mock.calls[1][0].endsWith(path.join('assets', 'mini-chart.png'))).toBe(true);
  });

  it('omits the Summary Table field and warns when the mini-chart is missing', async () => {
    const deps = makeDeps();
    const req = makeReq();
    req.body.statementData.budgetCategories = [{ code: 'HSQ', availableFunds: 100 }];

    await handleMonthlyStatementRoute(req, makeRes(), deps);

    expect(inputsFrom(deps)).not.toHaveProperty('Summary Table');
    expect(deps.warn).toHaveBeenCalledWith(
      'Webhook-Service',
      'Monthly statement mini-chart not found, using template default for Summary Table',
      expect.objectContaining({ path: expect.stringContaining('mini-chart.png') }),
      expect.anything(),
    );
  });

  it('embeds the footer image as a data URI', async () => {
    const deps = makeDeps({ fsOptions: { footer: Buffer.from('FOOT') } });

    await handleMonthlyStatementRoute(makeReq(), makeRes(), deps);

    expect(inputsFrom(deps)['Image 13-1'])
      .toBe(`data:image/png;base64,${Buffer.from('FOOT').toString('base64')}`);
  });

  // Characterization of a latent defect: resolveFooterImage's warn() call
  // references `req`, which is not one of its parameters, so the recovery path
  // for a missing footer asset throws a ReferenceError and 500s the request
  // instead of falling back to the template default. src/assets currently ships
  // monthly-statement-footer.png, which is the only reason this is not visible
  // in production.
  it('fails the whole request with "req is not defined" when the footer asset is missing', async () => {
    const deps = makeDeps({ fsOptions: { footer: null } });
    const res = makeRes();

    await handleMonthlyStatementRoute(makeReq(), res, deps);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'req is not defined', error: 'req is not defined' });
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it('falls back to the template logo when the business has none', async () => {
    const deps = makeDeps({ getLogoData: vi.fn(async () => null) });

    await handleMonthlyStatementRoute(makeReq(), makeRes(), deps);

    expect(inputsFrom(deps).logo).toBe('TEMPLATE_DEFAULT_LOGO');
  });

  it('repeats the header and logo on every page after the first', async () => {
    const deps = makeDeps();

    await handleMonthlyStatementRoute(makeReq(), makeRes(), deps);

    const inputs = inputsFrom(deps);
    expect(inputs.headerMonthlyStatement_p2).toBe('Monthly Statement');
    expect(inputs.headerMonthlyStatement_p3).toBe('Monthly Statement');
    expect(inputs).not.toHaveProperty('headerMonthlyStatement_p1');
    expect(inputs).not.toHaveProperty('headerMonthlyStatement_p4');
    expect(inputs.logoHeader_p2).toBe('data:image/png;base64,BUSINESS_LOGO');
    expect(inputs.logoHeader_p3).toBe('data:image/png;base64,BUSINESS_LOGO');
  });

  // --- header / participant fields ------------------------------------------

  it('fills the participant, organisation and recipient blocks', async () => {
    const deps = makeDeps();

    await handleMonthlyStatementRoute(makeReq(), makeRes(), deps);

    const inputs = inputsFrom(deps);
    expect(JSON.parse(inputs.companyName)).toEqual({ 'Company Name': 'Hills Grade Care' });
    expect(JSON.parse(inputs.Organisation)).toEqual({
      Participant: 'Jane Roe',
      'My Aged Care ID Number': 'AC-9911',
      'Provider ID': 'PRV-500',
      Address: '5 Wattle St',
      Suburb: 'Parramatta',
      'Post Code': '2150',
      State: 'NSW',
    });
    expect(JSON.parse(inputs.Recipient)).toEqual({
      Participant: 'Jane Roe',
      Address: '12 Smith St',
      Suburb: 'Blacktown',
      State: 'NSW',
      'Post Code': '2148',
    });
    expect(JSON.parse(inputs['Text title'])).toEqual({ month: 'March', year: '2025' });
  });

  it('prefers explicit businessDetails over the stored business record', async () => {
    const deps = makeDeps();

    await handleMonthlyStatementRoute(
      makeReq({
        businessDetails: {
          companyName: 'Override Care',
          phoneNumber: '03 8000 0000',
          businessEmail: 'billing@example.com',
          address: '1 Override Rd',
          suburb: 'Melbourne',
          state: 'VIC',
          postcode: '3000',
        },
      }),
      makeRes(),
      deps,
    );

    const inputs = inputsFrom(deps);
    expect(JSON.parse(inputs.companyName)).toEqual({ 'Company Name': 'Override Care' });
    expect(JSON.parse(inputs.Organisation).Suburb).toBe('Melbourne');
    expect(JSON.parse(inputs['Disclaimer 2a'])).toEqual({
      'Phone Number': '03 8000 0000',
      'Business Email': 'billing@example.com',
    });
    expect(inputs['Text 13-']).toBe(inputs['Disclaimer 2a']);
  });

  it('writes the quarter subtitle payload and the first/last day fields', async () => {
    const deps = makeDeps();

    await handleMonthlyStatementRoute(makeReq(), makeRes(), deps);

    const inputs = inputsFrom(deps);
    // March 2025 is month 3 of Q1; the quarter month index therefore reads 3.
    expect(JSON.parse(inputs['P2 Subtitle'])).toEqual({
      'Month No.': '3',
      'Quarter No': 'Q1',
      'First Day': '01/03/2025',
      'Last Day': '31/03/2025',
    });
    expect(JSON.parse(inputs['P12 Subtitle-2  copy copy'])).toEqual(JSON.parse(inputs['P2 Subtitle']));
    expect(JSON.parse(inputs['P2-10'])).toEqual({ 'first day': '01/03/2025' });
    expect(JSON.parse(inputs['P2-14'])).toEqual({ 'last day': '31/03/2025' });
  });

  it('takes the quarter label from the statement summary when present', async () => {
    const deps = makeDeps();
    const req = makeReq();
    req.body.statementData.summary = { quarter: 'FY25 Q3' };

    await handleMonthlyStatementRoute(req, makeRes(), deps);

    expect(JSON.parse(inputsFrom(deps)['P2 Subtitle'])['Quarter No']).toBe('FY25 Q3');
  });

  // --- budget mappings -------------------------------------------------------

  it('maps the home support aggregate onto its currency fields', async () => {
    const deps = makeDeps({
      calculateBudgetAggregates: vi.fn(() => ({
        HSQ: {
          ...initializeBudgetAggregate(),
          availableFundStart: 1000,
          quarterlyAdjustment: -50,
          primarySupplementAmount: 25.5,
          carryoverFunding: 100,
          unspentReturned: -30,
          commonwealthUnspent: 10,
          providerUnspent: 20,
          participantUnspent: 5,
          previousMonthSpending: -200,
          totalAvailableBudget: 880.5,
          deliveredAmount: -300,
          adjustmentAmount: -12.34,
          remainingBalance: 568.16,
          fund: 'Veterans',
        },
      })),
    });

    await handleMonthlyStatementRoute(makeReq(), makeRes(), deps);

    const inputs = inputsFrom(deps);
    expect(inputs['$P2-1']).toBe('$1000.00');
    expect(inputs['$P2-2']).toBe('-$50.00');
    expect(inputs['$P2-3']).toBe('$25.50');
    expect(inputs['$P2-4']).toBe('$70.00'); // 100 carryover + (-30) returned
    expect(inputs['$P2-6']).toBe('$35.00'); // 10 + 20 + 5 unspent
    expect(inputs['$P2-6 copy copy']).toBe('$10.00');
    expect(inputs['$P4-8']).toBe('$10.00');
    expect(inputs['$P2-9']).toBe('-$200.00');
    expect(inputs['$P2-10']).toBe('$880.50');
    expect(inputs['$P2-12']).toBe('-$300.00');
    expect(inputs['$P2-14']).toBe('$568.16');
    expect(inputs['$P7-6 copy']).toBe('$70.00');
    expect(inputs['$P4-7']).toBe('$70.00');
    // No primarySupplementLabel, so the fund name is used as the label.
    expect(JSON.parse(inputs['P2-3'])).toEqual({ 'Primary Supplement': 'Veterans' });
  });

  it('labels a supplement N/A when the aggregate carries no label, fund or classification', async () => {
    const deps = makeDeps();

    await handleMonthlyStatementRoute(makeReq(), makeRes(), deps);

    expect(JSON.parse(inputsFrom(deps)['P2-3'])).toEqual({ 'Primary Supplement': 'N/A' });
    expect(JSON.parse(inputsFrom(deps)['P3-2'])).toEqual({ 'Primary Supplement': 'N/A' });
    expect(inputsFrom(deps)['$P2-1']).toBe('$0.00');
  });

  it('formats the restorative funding dates and the assistive technology balances', async () => {
    const deps = makeDeps({
      calculateBudgetAggregates: vi.fn(() => ({
        RCP: {
          ...initializeBudgetAggregate(),
          fundingStartDate: '2025-01-01T00:00:00Z',
          fundingEndDate: '2025-06-30T00:00:00Z',
          primarySupplementLabel: 'Restorative',
        },
        ATS: {
          ...initializeBudgetAggregate(),
          availableFundStart: 500,
          additionalAmountApproved: 250,
          fundAmount: 999,
          committedFunds: -75,
          remainingBalanceEndOfMonth: 300,
          remainingBalanceAllocationPeriod: 225,
          fundingEndDate: '2025-12-31T00:00:00Z',
        },
      })),
    });

    await handleMonthlyStatementRoute(makeReq(), makeRes(), deps);

    const inputs = inputsFrom(deps);
    expect(JSON.parse(inputs['P3 Subtitle'])).toEqual({
      ' Funding Start Date': '01/01/2025',
      ' Funding end date': '30/06/2025',
    });
    expect(JSON.parse(inputs['P3 Subtitle copy'])).toEqual({
      ' Funding Start Date': 'N/A',
      ' Funding end date': 'N/A',
    });
    expect(inputs['$P4-1  copy']).toBe('$500.00');
    expect(inputs['$P5-1']).toBe('$500.00');
    // additionalAmountApproved wins over fundAmount.
    expect(inputs['$P4-3 copy']).toBe('$250.00');
    expect(inputs['$P4-11 copy']).toBe('$300.00');
    expect(inputs['$P4-12 copy']).toBe('-$75.00');
    expect(inputs['$P4-13 copy']).toBe('$225.00');
    expect(JSON.parse(inputs['P4 Footer 1 copy'])).toEqual({ 'Funding End Date': '31/12/2025' });
  });

  it('creates an aggregate for a statement category the ISO+ data did not produce', async () => {
    const deps = makeDeps();
    const req = makeReq();
    req.body.statementData.budgetCategories = [
      { code: 'EOL', availableFundStart: 400 },
      { availableFundStart: 999 }, // no code: must be skipped
    ];

    await handleMonthlyStatementRoute(req, makeRes(), deps);

    expect(deps.enrichAggregateFromCategory).toHaveBeenCalledTimes(1);
    expect(deps.enrichAggregateFromCategory.mock.calls[0][1]).toEqual({ code: 'EOL', availableFundStart: 400 });
    expect(inputsFrom(deps)['$P3-11 copy']).toBe('$400.00');
  });

  // --- service tables --------------------------------------------------------

  it('buckets services by status and funding code into the configured tables', async () => {
    const services = [
      { id: 's1', code: 'HSQ', service: 'Personal care', transactionStatus: 'Delivered - To be claimed and invoiced.', unit: 'Hour', quantity: 2, unitPrice: 60, totalAmount: 120, govSubsidy: 100, participantContribution: 20 },
      { id: 's2', code: 'HSQ', service: 'Refund of March charge', transactionStatus: 'Adjustment - Refund', unit: 'Each', quantity: 1, unitPrice: -10, totalAmount: -10, govSubsidy: -8, participantContribution: -2 },
      { id: 's3', code: 'HSQ', service: 'Cancelled visit', transactionStatus: 'Cancelled - Short notice', unit: 'Hour', quantity: 1, unitPrice: 60, totalAmount: 60, govSubsidy: 60, participantContribution: 0 },
      { id: 's4', code: 'HSQ', service: 'Unknown status', transactionStatus: '', unit: 'Hour', quantity: 1, unitPrice: 1, totalAmount: 1, govSubsidy: 1, participantContribution: 0 },
      { id: 's5', code: 'ATS', service: 'Shower chair', transactionStatus: 'Delivered', committedAtHmForDelivery: 250, unit: 'Item', quantity: 1, unitPrice: 250, totalAmount: 250, govSubsidy: 250, participantContribution: 0 },
      { id: 's6', code: 'ZZZ', service: 'Unmapped code', transactionStatus: 'Delivered', unit: 'Hour', quantity: 1, unitPrice: 5, totalAmount: 5, govSubsidy: 5, participantContribution: 0 },
    ];
    const deps = makeDeps({ fetchServiceItems: vi.fn(async () => services) });

    await handleMonthlyStatementRoute(makeReq(), makeRes(), deps);

    const inputs = inputsFrom(deps);
    const delivered = JSON.parse(inputs['Table P6-1 copy']);
    expect(delivered.map((row) => row[0])).toEqual([
      's1@Australia/Sydney', 's3@Australia/Sydney', 's4@Australia/Sydney',
    ]);
    expect(delivered[0][1]).toBe('Personal care (Hills Grade Care)');
    expect(JSON.parse(inputs['Table P7-1 copy']).map((row) => row[0])).toEqual(['s2@Australia/Sydney']);
    // committedAtHmForDelivery wins over the status.
    expect(JSON.parse(inputs['Table P10-2 copy']).map((row) => row[0])).toEqual(['s5@Australia/Sydney']);
    expect(JSON.parse(inputs['Table P10-1  copy'])[0][1]).toBe('No services recorded for this period');

    // Delivered totals: 120 + 60 + 1 = 181 amount, 100 + 60 + 1 = 161 gov, 20 participant.
    expect(inputs['$P6-1  copy']).toBe('$181.00');
    expect(inputs['$P3-3']).toBe('$181.00');
    expect(inputs['$P6-2 copy']).toBe('$161.00');
    expect(inputs['$P6-3 copy']).toBe('$20.00');
    expect(inputs['$P7-1 copy']).toBe('-$10.00');
  });

  it('pads, truncates and stringifies every table cell', async () => {
    const services = [
      { id: 's1', code: 'HSQ', service: 'Trim me', transactionStatus: 'Delivered', unit: '  Hour  ', quantity: 2, unitPrice: null, totalAmount: 10, govSubsidy: 10, participantContribution: 0 },
    ];
    const deps = makeDeps({
      fetchServiceItems: vi.fn(async () => services),
      buildServiceTableRows: (rows, config) => ({
        // Deliberately short and long rows, plus non-string cells.
        rows: rows.map(() => ['2025-03-01', { name: 'Object cell' }, true, 3, null]),
        totals: { amount: 10, gov: 10, participant: 0 },
      }),
    });

    await handleMonthlyStatementRoute(makeReq(), makeRes(), deps);

    expect(JSON.parse(inputsFrom(deps)['Table P6-1 copy'])).toEqual([
      ['2025-03-01', 'Object cell', 'Yes', '3', '', '', '', ''],
    ]);
  });

  it('replaces an unparsable table payload with a "No data available" row', async () => {
    const deps = makeDeps({
      buildServiceTableRows: () => ({ rows: [], totals: { amount: 0, gov: 0, participant: 0 } }),
      normalizeTableCell: () => { throw new Error('cell exploded'); },
      fetchServiceItems: vi.fn(async () => [
        { id: 's1', code: 'HSQ', transactionStatus: 'Delivered', service: 'x' },
      ]),
    });

    await handleMonthlyStatementRoute(makeReq(), makeRes(), deps);

    expect(JSON.parse(inputsFrom(deps)['Table P6-1 copy'])).toEqual([
      ['', 'No data available', '', '', '', '', '', ''],
    ]);
  });

  it('initialises every template table with an empty-state row', async () => {
    const deps = makeDeps();

    await handleMonthlyStatementRoute(makeReq(), makeRes(), deps);

    const inputs = inputsFrom(deps);
    expect(JSON.parse(inputs['Table P9-1'])).toEqual([
      ['', 'No services recorded for this period', '', '', '', '', '', ''],
    ]);
    expect(JSON.parse(inputs['Table P11-1  copy'])).toEqual([
      ['', 'No services recorded for this period', '', '', '', '', '', ''],
    ]);
  });

  it('summarises care-management hours from the HSCM budget rows', async () => {
    const deps = makeDeps({
      fetchBudgetItems: vi.fn(async () => [
        { categoryCode: 'HSCM', hscmAllocatedTime: '2.5' },
        { categoryCode: 'HSCM', hscmAllocatedTime: 1.25 },
        { categoryCode: 'HSQ', hscmAllocatedTime: 99 },
      ]),
    });

    await handleMonthlyStatementRoute(makeReq(), makeRes(), deps);

    expect(JSON.parse(inputsFrom(deps)['Table P6-1 copy copy copy'])).toEqual([
      ['Care Management', 'Hours', '3.8'],
    ]);
  });

  it('shows the empty-state row when there are no care-management budget rows', async () => {
    const deps = makeDeps({ fetchBudgetItems: vi.fn(async () => [{ categoryCode: 'HSQ' }]) });

    await handleMonthlyStatementRoute(makeReq(), makeRes(), deps);

    expect(JSON.parse(inputsFrom(deps)['Table P6-1 copy copy copy'])).toEqual([
      ['', 'No services recorded for this period', ''],
    ]);
  });

  it('renders with the injected pdfme plugins and the loaded template', async () => {
    const deps = makeDeps();

    await handleMonthlyStatementRoute(makeReq(), makeRes(), deps);

    const call = deps.generate.mock.calls[0][0];
    expect(call.template).toEqual(TEMPLATE_FIXTURE);
    expect(call.plugins).toEqual({
      text: 'text-plugin',
      image: 'image-plugin',
      line: 'line-plugin',
      table: 'table-plugin',
      multiVariableText: 'mvt-plugin',
    });
    expect(deps.enableRepeatHeadOnTables).toHaveBeenCalledWith(call.template);
    expect(deps.ensureMonthlyStatementHeaderFromPage2).toHaveBeenCalledWith(call.template);
    expect(deps.applyTemplateTextDefaults).toHaveBeenCalledWith(call.template, call.inputs[0]);
  });
});
