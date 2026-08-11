import { describe, it, expect, vi } from 'vitest';
import { getNdisInvoiceGeneratorData } from '../../../src/utils/ndisInvoiceGeneratorRouteHelpers.js';
import { bulkFetchReferenceItemsFromDB } from '../../../src/utils/ndisInvoiceGeneratorInvoicing.js';
import { isUuidLike } from '../../../src/utils/ndisServiceRecords.js';
import Item from '../../../src/models/Item.js';
import Business from '../../../src/models/Business.js';
import InvoiceNumber from '../../../src/models/InvoiceNumber.js';

/*
 * getNdisInvoiceGeneratorData() backs GET .../ndis/invoice-generator: it reads
 * every approved Master Plan item on a board, expands each into claim rows,
 * applies the screen's filters and sort, and returns the totals shown above the
 * table.
 *
 * Real Mongo, real models, real row builders. Only the two collaborators the
 * route itself supplies are stubbed: `getFolderIds` (an ISO+ call) and `warn`.
 *
 * Service plan fixtures carry a 'Direct Support Item Number' key so
 * resolveNdisPricingRuleForServicePlan() infers the legacy rule locally rather
 * than calling ISO+ for the board attributes.
 */

const WORKSPACE = '55369';
const BOARD = 'eNiJpH14PN3';
const CATALOGUE_BOARD = 'zzCatalogue';

const SP_ID = '11111111-1111-4111-8111-111111111111';
const PP_ID = '22222222-1111-4111-8111-222222222222';
const PP_ID_2 = '22222222-2222-4111-8111-222222222222';
const SUPPORT_CAT_ID = '66666666-1111-4111-8111-666666666666';

let seq = 0;
const createItem = (itemId, data, overrides = {}) => Item.create({
  workspaceId: WORKSPACE,
  boardId: BOARD,
  folderId: 'folder-master',
  itemId,
  data,
  ...overrides,
});

async function seedServicePlan() {
  await createItem(SUPPORT_CAT_ID, {
    'Support Item Number': '01_011_0107_1_1',
    'Support Item Name': 'Assistance With Self-Care Activities',
  }, { boardId: CATALOGUE_BOARD, folderId: 'folder-cat' });

  await createItem(SP_ID, {
    'Direct Support Item Number': [{ id: SUPPORT_CAT_ID, name: 'Assistance' }],
    'Unit (Direct Support)': 'Hour(H)',
    'Agreed Unit Price for Direct Support ($)': '70.00',
  }, { boardId: CATALOGUE_BOARD, folderId: 'folder-cat' });
}

const seedParticipant = (id = PP_ID, name = 'Samuel Rivers') => createItem(id, {
  'Full Name/Preferred Name': name,
  'NDIS Number': '430123456',
}, { boardId: CATALOGUE_BOARD, folderId: 'folder-cat' });

/** A completed 2.5h shift worth $175.00 at the seeded $70/hr rate. */
const shift = (itemId, overrides = {}, itemOverrides = {}) => createItem(itemId, {
  'Timesheet Approval': 'Approved',
  'Job Status': 'Completed',
  'Payment Status': 'Unpaid',
  'Service Plan': [{ id: SP_ID }],
  'Participant Profile': [{ id: PP_ID }],
  'Scheduled Shift Start Date & Time': '2026-01-14T21:00:00.000Z',
  'Actual Shift Start Date and Time': '2026-01-14T22:00:00.000Z',
  'Actual Shift End Date and Time': '2026-01-15T00:30:00.000Z',
  'Actual Shift Duration(Hr.)': '2.5',
  'Direct Support Value($) - Time Based Support': '175.00',
  ...overrides,
}, itemOverrides);

function makeDeps(overrides = {}) {
  return {
    Item,
    Business,
    InvoiceNumber,
    getFolderIds: vi.fn().mockResolvedValue([]),
    bulkFetchReferenceItemsFromDB,
    isUuidLike,
    warn: vi.fn(),
    ...overrides,
  };
}

const run = (query = {}, deps = makeDeps(), req = null) => getNdisInvoiceGeneratorData(
  { workspaceId: WORKSPACE, boardId: BOARD, query, req },
  deps,
);

describe('empty board', () => {
  // Breaks if the empty case starts throwing or omits a total the screen reads.
  it('returns zeroed totals and the default status field label', async () => {
    await expect(run()).resolves.toEqual({
      items: [],
      total: 0,
      invoiced: 0,
      pending: 0,
      totalAmount: 0,
      totalGovSubsidy: 0,
      totalParticipantContribution: 0,
      statusFieldLabel: 'Job Status',
    });
  });
});

describe('row expansion and totals', () => {
  // Breaks on a wrong per-row amount, a lost total, or a row that stops
  // carrying the participant / item number the table displays.
  it('expands each approved shift into a priced row and sums the amounts', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1');
    await shift('mp-2');

    const result = await run();

    expect(result.total).toBe(2);
    expect(result.pending).toBe(2);
    expect(result.invoiced).toBe(0);
    expect(result.totalAmount).toBe(350);
    expect(result.items.map((r) => r.code)).toEqual(['direct_support_time', 'direct_support_time']);
    expect(result.items[0]).toMatchObject({
      sourceItemId: 'mp-1',
      participant: 'Samuel Rivers',
      supportNumber: '01_011_0107_1_1',
      quantity: 2.5,
      unitPrice: 70,
      totalAmount: 175,
      status: 'pending',
    });
    expect(result.totalGovSubsidy).toBe(0);
    expect(result.totalParticipantContribution).toBe(0);
  });

  // Breaks if the approval gate at the source query goes: unapproved timesheets
  // would appear on the invoice generator and could be invoiced.
  it('drops items whose timesheet is not approved before anything else runs', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1');
    await shift('mp-2', { 'Timesheet Approval': 'Pending' });
    await shift('mp-3', { 'Timesheet Approval': undefined });

    const result = await run();

    expect(result.total).toBe(1);
    expect(result.items[0].sourceItemId).toBe('mp-1');
  });

  // Breaks if a shift stops expanding into several rows: one shift can carry
  // support, travel and allowance lines and each is claimed separately.
  it('expands one shift into several rows and counts each in the totals', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1', { 'Allowances Amount($)': '35.00' });

    const result = await run();

    expect(result.items.map((r) => r.code)).toEqual(['direct_support_time', 'allowances']);
    expect(result.total).toBe(2);
    expect(result.totalAmount).toBe(210);
  });

  // Breaks if the invoice-number join goes: an already-invoiced shift must show
  // as invoiced with its PDF link, or it will be invoiced a second time.
  it('marks rows invoiced from the PDF invoice numbers and carries the pdf link', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1');
    await shift('mp-2');
    await InvoiceNumber.create({
      itemId: 'mp-1',
      workspaceId: WORKSPACE,
      boardId: BOARD,
      invoiceNumber: 'IN-1042',
      type: 'PDF',
      pdfLink: 'https://example.com/in-1042.pdf',
    });
    // A Xero record for the same shift must not count.
    await InvoiceNumber.create({
      itemId: 'mp-2', workspaceId: WORKSPACE, boardId: BOARD, invoiceNumber: 'XR-1', type: 'Xero',
    });

    const result = await run();

    expect(result.invoiced).toBe(1);
    expect(result.pending).toBe(1);
    const invoiced = result.items.find((r) => r.sourceItemId === 'mp-1');
    expect(invoiced.status).toBe('invoiced');
    expect(invoiced.invoiceNumber).toBe('IN-1042');
    expect(invoiced.fileUrl).toBe('https://example.com/in-1042.pdf');
    expect(result.items.find((r) => r.sourceItemId === 'mp-2').status).toBe('pending');
  });
});

describe('status field label detection', () => {
  // Breaks if the detection inverts: the frontend labels its filter column from
  // this value, and the job-status filter reads a different attribute for each.
  it('reports Shift Status when any item carries that column, else Job Status', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1');
    expect((await run()).statusFieldLabel).toBe('Job Status');

    await shift('mp-2', { 'Shift Status': 'Completed' });
    expect((await run()).statusFieldLabel).toBe('Shift Status');
  });
});

describe('filters', () => {
  async function seedTwoParticipants() {
    await seedServicePlan();
    await seedParticipant(PP_ID, 'Samuel Rivers');
    await seedParticipant(PP_ID_2, 'Jane Doe');
    await shift('mp-1');
    await shift('mp-2', { 'Participant Profile': [{ id: PP_ID_2 }] });
  }

  // Breaks if the participant filter stops being a case-insensitive substring
  // match, which is what the search box on the screen promises.
  it('filters by participant name, case-insensitively and on a substring', async () => {
    await seedTwoParticipants();

    expect((await run({ participant: 'samuel' })).items.map((r) => r.participant)).toEqual(['Samuel Rivers']);
    expect((await run({ participant: 'Doe' })).items.map((r) => r.participant)).toEqual(['Jane Doe']);
    expect((await run({ participant: '' })).total).toBe(2);
  });

  // Breaks if the regex escaping goes: a participant name containing "(" would
  // otherwise throw and take the whole request down.
  it('escapes regex metacharacters in the participant term', async () => {
    await seedServicePlan();
    await seedParticipant(PP_ID, 'Rivers (Trust)');
    await shift('mp-1');

    expect((await run({ participant: 'Rivers (Trust)' })).total).toBe(1);
    expect((await run({ participant: 'Rivers [Trust]' })).total).toBe(0);
  });

  // Breaks if the catch goes: a non-string participant param would 500 the
  // request rather than degrading to "no filter".
  it('warns and skips the filter when the participant term cannot be compiled', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1');
    const deps = makeDeps();

    const result = await run({ participant: 12345 }, deps);

    expect(result.total).toBe(1);
    expect(deps.warn).toHaveBeenCalledWith(
      'Items-Service',
      'Invalid participant regex pattern (NDIS invoice-generator)',
      expect.objectContaining({ participant: 12345 }),
      null,
    );
  });

  // Breaks if the payment-status match becomes loose: the filter is an exact,
  // case-sensitive label match.
  it('filters by payment status on an exact label match', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1', { 'Payment Status': 'Paid' });
    await shift('mp-2', { 'Payment Status': 'Unpaid' });

    expect((await run({ paymentStatus: 'Paid' })).total).toBe(1);
    expect((await run({ paymentStatus: 'paid' })).total).toBe(0);
    expect((await run({ paymentStatus: 'all' })).total).toBe(2);
    expect((await run({ paymentStatus: '' })).total).toBe(2);
  });

  // Breaks if the job-status filter stops being case-insensitive, or stops
  // following the detected status column.
  it('filters by job status case-insensitively', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1');
    await shift('mp-2', { 'Job Status': 'In Progress' });

    expect((await run({ jobStatus: 'completed' })).total).toBe(1);
    expect((await run({ jobStatus: 'IN PROGRESS' })).items.map((r) => r.sourceItemId)).toEqual(['mp-2']);
    expect((await run({ jobStatus: 'all' })).total).toBe(2);
    expect((await run({ jobStatus: '' })).total).toBe(2);
  });

  // Breaks if the filter stops following the detected column. Characterizing a
  // sharp edge: one item carrying "Shift Status" switches the whole board to
  // that column, and items that only have "Job Status" then match nothing.
  it('reads the status from whichever column the board was detected as using', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-jobstatus');
    await shift('mp-shiftstatus', { 'Job Status': undefined, 'Shift Status': 'Completed' });

    const result = await run({ jobStatus: 'Completed' });

    expect(result.statusFieldLabel).toBe('Shift Status');
    expect(result.items.map((r) => r.sourceItemId)).toEqual(['mp-shiftstatus']);
  });

  // Breaks if invoiced/pending inverts — the screen's default view is "all",
  // and the pending view is what the user invoices from.
  it('filters by derived invoice status', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1');
    await shift('mp-2');
    await InvoiceNumber.create({
      itemId: 'mp-1', workspaceId: WORKSPACE, boardId: BOARD, invoiceNumber: 'IN-1', type: 'PDF',
    });

    expect((await run({ status: 'invoiced' })).items.map((r) => r.sourceItemId)).toEqual(['mp-1']);
    expect((await run({ status: 'pending' })).items.map((r) => r.sourceItemId)).toEqual(['mp-2']);
    expect((await run({ status: 'all' })).total).toBe(2);
  });

  // Breaks on an off-by-one at either date boundary: both ends are inclusive,
  // and a shift exactly on the boundary belongs in the period.
  it('filters scheduled dates inclusively at both ends', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1', { 'Scheduled Shift Start Date & Time': '2026-01-10T00:00:00.000Z' });
    await shift('mp-2', { 'Scheduled Shift Start Date & Time': '2026-01-20T00:00:00.000Z' });

    expect((await run({ startDate: '2026-01-10T00:00:00.000Z' })).total).toBe(2);
    expect((await run({ startDate: '2026-01-10T00:00:00.001Z' })).total).toBe(1);
    expect((await run({ endDate: '2026-01-20T00:00:00.000Z' })).total).toBe(2);
    expect((await run({ endDate: '2026-01-19T23:59:59.999Z' })).total).toBe(1);
    expect((await run({
      startDate: '2026-01-10T00:00:00.000Z',
      endDate: '2026-01-20T00:00:00.000Z',
    })).total).toBe(2);
  });

  // Breaks if the two date filters stop reading different columns: the
  // scheduled filter reads the scheduled start, the service-delivery filter the
  // actual start.
  it('filters service delivery dates against the actual start', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1', {
      'Scheduled Shift Start Date & Time': '2026-01-10T00:00:00.000Z',
      'Actual Shift Start Date and Time': '2026-02-10T00:00:00.000Z',
      'Actual Shift End Date and Time': '2026-02-10T02:30:00.000Z',
    });

    expect((await run({ serviceDeliveryStart: '2026-02-01T00:00:00.000Z' })).total).toBe(1);
    expect((await run({ serviceDeliveryStart: '2026-03-01T00:00:00.000Z' })).total).toBe(0);
    expect((await run({ serviceDeliveryEnd: '2026-02-10T00:00:00.000Z' })).total).toBe(1);
    expect((await run({ serviceDeliveryEnd: '2026-02-09T00:00:00.000Z' })).total).toBe(0);
    // The scheduled-date filter must not see the actual date.
    expect((await run({ startDate: '2026-02-01T00:00:00.000Z' })).total).toBe(0);
  });

  // Breaks if an item with no date starts passing a date filter, which would
  // put an undated shift into a claim period it does not belong to.
  it('excludes items with a missing or unparseable date once a filter is set', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1', { 'Scheduled Shift Start Date & Time': 'not a date' });
    await shift('mp-2', { 'Scheduled Shift Start Date & Time': undefined });

    expect((await run()).total).toBe(2);
    expect((await run({ startDate: '2020-01-01T00:00:00.000Z' })).total).toBe(0);
    expect((await run({ endDate: '2030-01-01T00:00:00.000Z' })).total).toBe(0);
  });

  // Breaks if the folder narrowing goes: the master plan folder ids scope the
  // query, and without them unrelated board items would be expanded.
  it('scopes the query to the folders ISO+ reports for the master plan', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1');
    await shift('mp-2', {}, { folderId: 'folder-other' });
    const deps = makeDeps({ getFolderIds: vi.fn().mockResolvedValue(['folder-master']) });

    const result = await run({}, deps);

    expect(deps.getFolderIds).toHaveBeenCalledWith(
      'Master Plan,Shift Planning and Reporting', WORKSPACE, BOARD,
    );
    expect(result.items.map((r) => r.sourceItemId)).toEqual(['mp-1']);
  });
});

describe('sorting', () => {
  async function seedThreeDates() {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-mid', { 'Scheduled Shift Start Date & Time': '2026-01-15T00:00:00.000Z' });
    await shift('mp-early', { 'Scheduled Shift Start Date & Time': '2026-01-01T00:00:00.000Z' });
    await shift('mp-late', { 'Scheduled Shift Start Date & Time': '2026-01-31T00:00:00.000Z' });
  }

  // Breaks if the default order flips: the screen lists oldest first.
  it('sorts by scheduled date ascending by default and descending on request', async () => {
    await seedThreeDates();

    expect((await run()).items.map((r) => r.sourceItemId)).toEqual(['mp-early', 'mp-mid', 'mp-late']);
    expect((await run({ sortOrder: 'desc' })).items.map((r) => r.sourceItemId))
      .toEqual(['mp-late', 'mp-mid', 'mp-early']);
  });

  // Breaks if the sort key stops switching: the two columns are different dates
  // and can order the same shifts differently.
  it('sorts by the actual start when sortBy is serviceDeliveryDate', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1', {
      'Scheduled Shift Start Date & Time': '2026-01-01T00:00:00.000Z',
      'Actual Shift Start Date and Time': '2026-02-20T00:00:00.000Z',
      'Actual Shift End Date and Time': '2026-02-20T02:30:00.000Z',
    });
    await shift('mp-2', {
      'Scheduled Shift Start Date & Time': '2026-01-31T00:00:00.000Z',
      'Actual Shift Start Date and Time': '2026-02-01T00:00:00.000Z',
      'Actual Shift End Date and Time': '2026-02-01T02:30:00.000Z',
    });

    expect((await run({ sortBy: 'serviceDeliveryDate' })).items.map((r) => r.sourceItemId))
      .toEqual(['mp-2', 'mp-1']);
    expect((await run()).items.map((r) => r.sourceItemId)).toEqual(['mp-1', 'mp-2']);
  });

  // Breaks if undated rows stop sinking: they must sit at the bottom in BOTH
  // directions, not flip to the top when the order reverses.
  it('always sorts undated items last, in either direction', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-dated', { 'Scheduled Shift Start Date & Time': '2026-01-15T00:00:00.000Z' });
    await shift('mp-undated', { 'Scheduled Shift Start Date & Time': undefined });

    expect((await run()).items.map((r) => r.sourceItemId)).toEqual(['mp-dated', 'mp-undated']);
    expect((await run({ sortOrder: 'desc' })).items.map((r) => r.sourceItemId))
      .toEqual(['mp-dated', 'mp-undated']);
  });
});

describe('pagination', () => {
  // Breaks if the totals start being computed from the page rather than the
  // whole result: the header counts would change as the user pages.
  it('slices the page but reports totals over every row', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1', { 'Scheduled Shift Start Date & Time': '2026-01-01T00:00:00.000Z' });
    await shift('mp-2', { 'Scheduled Shift Start Date & Time': '2026-01-02T00:00:00.000Z' });
    await shift('mp-3', { 'Scheduled Shift Start Date & Time': '2026-01-03T00:00:00.000Z' });

    const page2 = await run({ page: 2, limit: 2 });

    expect(page2.items.map((r) => r.sourceItemId)).toEqual(['mp-3']);
    expect(page2.total).toBe(3);
    expect(page2.totalAmount).toBe(525);

    const page1 = await run({ page: 1, limit: 2 });
    expect(page1.items.map((r) => r.sourceItemId)).toEqual(['mp-1', 'mp-2']);
  });

  // Breaks if "all" stops disabling pagination, which is what the export uses.
  it('returns every row for limit=all or no limit', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1');
    await shift('mp-2');

    expect((await run({ limit: 'all', page: 2 })).items).toHaveLength(2);
    expect((await run({ page: 3 })).items).toHaveLength(2);
  });

  // Breaks if a page beyond the end starts wrapping instead of returning empty.
  it('returns an empty page past the end without changing the totals', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1');

    const result = await run({ page: 5, limit: 10 });

    expect(result.items).toEqual([]);
    expect(result.total).toBe(1);
    expect(result.totalAmount).toBe(175);
  });
});

describe('head office timezone', () => {
  // Breaks if the timezone stops coming from the business record: the shift
  // window printed in the service description is rendered in it, and an hour's
  // drift shows the wrong support times on the invoice.
  it('renders the shift window in the business head office timezone', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1');
    await Business.create({ workspaceId: WORKSPACE, name: 'Fixture Care', headOfficeTimezone: 'Australia/Perth' });

    const result = await run();

    // 2026-01-14T22:00Z is 06:00 in Perth (UTC+8) and 09:00 in Sydney.
    expect(result.items[0].service).toContain('from 15/01/2026, 06:00 am to 15/01/2026, 08:30 am');
  });

  it('defaults to Australia/Sydney when the business has no timezone', async () => {
    await seedServicePlan();
    await seedParticipant();
    await shift('mp-1');

    const result = await run();

    expect(result.items[0].service).toContain('from 15/01/2026, 09:00 am to 15/01/2026, 11:30 am');
  });
});
