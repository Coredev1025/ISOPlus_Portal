import { describe, it, expect, vi } from 'vitest';
import {
  validateNdisExportBusiness,
  filterApprovedMasterItems,
  detectNdisStatusFieldNames,
  applyNdisMasterItemFilters,
  sortNdisMasterItems,
  removeMasterItemsMissingNdisNumber,
  expandMasterItemToClaimRows,
  handleNdisInvoiceCsvExport,
} from '../../../src/utils/exportOptimizedNdisCsvHelpers.js';
import {
  NDIS_MASTERPLAN_ATTR,
  extractRefId as extractNdisRefId,
  extractAllRefIds as extractNdisAllRefIds,
  formatLabelValue as formatNdisLabelValue,
  getValueMulti as getNdisValueMulti,
  formatDdMmYyyy,
  mapNdisClaimCsvQuantityAndHours,
  sanitizeDigits,
  getParticipantDisplayName as getNdisParticipantDisplayName,
  getParticipantNdisNumber,
  mapCancellationReasonCode,
  resolveNdisClaimType,
  resolveCancellationReasonLabel,
  resolveNdisSupportDeliveredDates,
  resolveRefItemDisplayName,
  isCancellationClaimRow,
  isUuidLike as isUuidLikeNdis,
  buildNdisSupportCatalogueForServicePlan,
  collectNdisSupportCatalogueRefIds,
} from '../../../src/utils/ndisServiceRecords.js';

/*
 * These helpers take routes/exportOptimized.js's `exportNdisCsvDeps` object.
 * Everything pure is the real implementation imported above; only Mongo-backed
 * members (the models, bulkFetchItemsFromDB, resolveNdisPricingRuleForServicePlan,
 * getFolderIds) and the very large row builder are replaced, so the row builder's
 * output is an *input* to the code under test rather than a mocked assertion.
 */

const PP_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PP_ID_2 = 'aaaaaaaa-2222-4111-8111-aaaaaaaaaaaa';
const SP_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const SDM_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const CR_ID = 'dddddddd-1111-4111-8111-dddddddddddd';
const ALLOWANCE_ID = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
const SUPPORT_ITEM_ID = 'ffffffff-1111-4111-8111-ffffffffffff';

const pureDeps = {
  NDIS_MASTERPLAN_ATTR,
  extractNdisRefId,
  extractNdisAllRefIds,
  formatNdisLabelValue,
  getNdisValueMulti,
  formatDdMmYyyy,
  mapNdisClaimCsvQuantityAndHours,
  sanitizeDigits,
  getNdisParticipantDisplayName,
  getParticipantNdisNumber,
  mapCancellationReasonCode,
  resolveNdisClaimType,
  resolveCancellationReasonLabel,
  resolveNdisSupportDeliveredDates,
  resolveRefItemDisplayName,
  isCancellationClaimRow,
  isUuidLikeNdis,
  buildNdisSupportCatalogueForServicePlan,
  collectNdisSupportCatalogueRefIds,
};

/** A master-plan (shift) item as stored in Mongo by the sync worker. */
const masterItem = (itemId, data) => ({
  _id: `oid-${itemId}`,
  itemId,
  workspaceId: 'ws-1',
  boardId: 'board-1',
  folderId: 'folder-master-plan',
  name: `Shift ${itemId}`,
  data,
});

const refItem = (itemId, data) => ({ itemId, boardId: 'board-1', data });

describe('validateNdisExportBusiness', () => {
  it('returns the pair when both fields are present', () => {
    expect(validateNdisExportBusiness({ registrationNumber: '4050012345', abn: '12345678901' }))
      .toEqual({ registrationNumber: '4050012345', abn: '12345678901' });
  });

  it('reports the registration id first when it is missing', () => {
    const result = validateNdisExportBusiness({ registrationNumber: '', abn: '12345678901' });

    expect(result.error).toContain('Company Registration ID');
    expect(result.registrationNumber).toBeUndefined();
  });

  it('reports the ABN when only it is missing', () => {
    const result = validateNdisExportBusiness({ registrationNumber: '4050012345', abn: '' });

    expect(result.error).toContain('ABN');
  });

  it('reports the registration id when both are missing', () => {
    expect(validateNdisExportBusiness({ registrationNumber: '', abn: '' }).error)
      .toContain('Company Registration ID');
  });
});

describe('filterApprovedMasterItems', () => {
  it('keeps only items whose timesheet approval reads "approved", ignoring case and padding', () => {
    const items = [
      masterItem('a', { 'Timesheet Approval': 'Approved' }),
      masterItem('b', { 'Timesheet Approval': '  APPROVED  ' }),
      masterItem('c', { 'Timesheet Approval': { name: 'approved' } }),
      masterItem('d', { 'Timesheet Approval': 'Pending Approval' }),
      masterItem('e', { 'Timesheet Approval': null }),
      masterItem('f', {}),
      { itemId: 'g' },
    ];

    const result = filterApprovedMasterItems(items, formatNdisLabelValue, NDIS_MASTERPLAN_ATTR);

    expect(result.map((i) => i.itemId)).toEqual(['a', 'b', 'c']);
  });

  it('keeps a single-entry multi-select whose only label is Approved', () => {
    const items = [masterItem('a', { 'Timesheet Approval': [{ name: 'Approved' }] })];

    expect(filterApprovedMasterItems(items, formatNdisLabelValue, NDIS_MASTERPLAN_ATTR)).toHaveLength(1);
  });

  it('drops a multi-select that joins to more than "Approved"', () => {
    const items = [masterItem('a', { 'Timesheet Approval': [{ name: 'Approved' }, { name: 'Locked' }] })];

    expect(filterApprovedMasterItems(items, formatNdisLabelValue, NDIS_MASTERPLAN_ATTR)).toEqual([]);
  });

  it('returns an empty list for no items', () => {
    expect(filterApprovedMasterItems([], formatNdisLabelValue, NDIS_MASTERPLAN_ATTR)).toEqual([]);
  });
});

describe('detectNdisStatusFieldNames', () => {
  it('returns the Shift Status spellings when any item declares that attribute', () => {
    const items = [
      masterItem('a', { 'Job Status': 'Completed' }),
      masterItem('b', { 'Shift Status': 'Completed' }),
    ];

    expect(detectNdisStatusFieldNames(items)).toEqual(['Shift Status', 'ShiftStatus']);
  });

  it('detects the attribute even when its value is null', () => {
    // The check is on the key, not the value, so an unset Shift Status column counts.
    expect(detectNdisStatusFieldNames([masterItem('a', { 'Shift Status': null })]))
      .toEqual(['Shift Status', 'ShiftStatus']);
  });

  it('falls back to the Job Status spellings when no item declares Shift Status', () => {
    expect(detectNdisStatusFieldNames([masterItem('a', { 'Job Status': 'Completed' })]))
      .toEqual(['Job Status', 'Job status', 'JobStatus']);
  });

  it('falls back to Job Status for an empty list or items without data', () => {
    expect(detectNdisStatusFieldNames([])).toEqual(['Job Status', 'Job status', 'JobStatus']);
    expect(detectNdisStatusFieldNames([{ itemId: 'a' }])).toEqual(['Job Status', 'Job status', 'JobStatus']);
  });
});

describe('applyNdisMasterItemFilters', () => {
  const STATUS_FIELDS = ['Job Status', 'Job status', 'JobStatus'];

  const shift = (itemId, overrides = {}) => masterItem(itemId, {
    'Participant Profile': [{ id: PP_ID }],
    'Job Status': 'Completed',
    'Payment Status': 'Unpaid',
    'Scheduled Shift Start Date & Time': '2026-03-10T09:00:00+11:00',
    'Actual Shift Start Date and Time': '2026-03-10T09:15:00+11:00',
    ...overrides,
  });

  const refItemsMap = new Map([
    [PP_ID, refItem(PP_ID, { 'Full Name/Preferred Name': 'Jane Citizen' })],
    [PP_ID_2, refItem(PP_ID_2, { 'Full Name/Preferred Name': 'Bob Brown' })],
  ]);

  const baseFilters = (overrides = {}) => ({
    participant: '',
    paymentStatusFilter: '',
    jobStatusFilter: '',
    statusFieldAttributeNames: STATUS_FIELDS,
    refItemsMap,
    warn: vi.fn(),
    req: null,
    ...overrides,
  });

  it('keeps every item when no filter is supplied', () => {
    const items = [shift('a'), shift('b'), masterItem('c', {})];

    expect(applyNdisMasterItemFilters(items, baseFilters(), pureDeps).map((i) => i.itemId))
      .toEqual(['a', 'b', 'c']);
  });

  it('matches the participant against the referenced profile name, case-insensitively', () => {
    const items = [shift('a'), shift('b', { 'Participant Profile': [{ id: PP_ID_2 }] })];

    expect(applyNdisMasterItemFilters(items, baseFilters({ participant: 'jane' }), pureDeps)
      .map((i) => i.itemId)).toEqual(['a']);
  });

  it('falls back to the name stored on the shift when the profile does not resolve', () => {
    const items = [
      shift('a', { 'Participant Profile': null, 'Participant Full Name': 'Bob Brown' }),
      shift('b'),
    ];

    expect(applyNdisMasterItemFilters(items, baseFilters({ participant: 'Bob' }), pureDeps)
      .map((i) => i.itemId)).toEqual(['a']);
  });

  it('drops items with no name at all when a participant filter is set', () => {
    const items = [shift('a', { 'Participant Profile': null })];

    expect(applyNdisMasterItemFilters(items, baseFilters({ participant: 'Jane' }), pureDeps)).toEqual([]);
  });

  it('escapes regex metacharacters so the participant matches literally', () => {
    const map = new Map([
      [PP_ID, refItem(PP_ID, { 'Full Name/Preferred Name': 'A.B (Ltd)' })],
      [PP_ID_2, refItem(PP_ID_2, { 'Full Name/Preferred Name': 'AXB (Ltd)' })],
    ]);
    const items = [shift('literal'), shift('wildcard', { 'Participant Profile': [{ id: PP_ID_2 }] })];

    expect(applyNdisMasterItemFilters(
      items, baseFilters({ participant: 'A.B (Ltd)', refItemsMap: map }), pureDeps,
    ).map((i) => i.itemId)).toEqual(['literal']);
  });

  it('warns and skips participant filtering when the name lookup throws', () => {
    const warn = vi.fn();
    const throwingDeps = {
      ...pureDeps,
      getNdisParticipantDisplayName: () => { throw new Error('profile lookup exploded'); },
    };
    const items = [shift('a'), shift('b')];

    const result = applyNdisMasterItemFilters(items, baseFilters({ participant: 'Jane', warn }), throwingDeps);

    expect(result.map((i) => i.itemId)).toEqual(['a', 'b']);
    expect(warn).toHaveBeenCalledWith(
      'Export-Service',
      'Invalid participant regex pattern (NDIS invoice-csv)',
      { participant: 'Jane', error: 'profile lookup exploded' },
      null,
    );
  });

  it('matches payment status exactly, and treats "all" as no filter', () => {
    const items = [shift('a'), shift('b', { 'Payment Status': 'Paid' })];

    expect(applyNdisMasterItemFilters(items, baseFilters({ paymentStatusFilter: 'Paid' }), pureDeps)
      .map((i) => i.itemId)).toEqual(['b']);
    expect(applyNdisMasterItemFilters(items, baseFilters({ paymentStatusFilter: 'paid' }), pureDeps)).toEqual([]);
    expect(applyNdisMasterItemFilters(items, baseFilters({ paymentStatusFilter: 'all' }), pureDeps)
      .map((i) => i.itemId)).toEqual(['a', 'b']);
  });

  it('reads payment status from the alternate spellings', () => {
    const items = [masterItem('a', { PaymentStatus: 'Paid' })];

    expect(applyNdisMasterItemFilters(items, baseFilters({ paymentStatusFilter: 'Paid' }), pureDeps)
      .map((i) => i.itemId)).toEqual(['a']);
  });

  it('matches job status case-insensitively through the detected attribute names', () => {
    const items = [shift('a'), shift('b', { 'Job Status': 'Cancelled' })];

    expect(applyNdisMasterItemFilters(items, baseFilters({ jobStatusFilter: 'COMPLETED' }), pureDeps)
      .map((i) => i.itemId)).toEqual(['a']);
    expect(applyNdisMasterItemFilters(items, baseFilters({ jobStatusFilter: 'all' }), pureDeps)
      .map((i) => i.itemId)).toEqual(['a', 'b']);
  });

  it('uses the Shift Status attribute names when those were detected', () => {
    const items = [
      masterItem('a', { 'Shift Status': 'Completed' }),
      masterItem('b', { 'Shift Status': 'Cancelled' }),
    ];

    expect(applyNdisMasterItemFilters(
      items,
      baseFilters({ jobStatusFilter: 'completed', statusFieldAttributeNames: ['Shift Status', 'ShiftStatus'] }),
      pureDeps,
    ).map((i) => i.itemId)).toEqual(['a']);
  });

  it('filters startDate and endDate on the scheduled start', () => {
    const items = [
      shift('feb', { 'Scheduled Shift Start Date & Time': '2026-02-10T09:00:00+11:00' }),
      shift('mar'),
    ];

    expect(applyNdisMasterItemFilters(items, baseFilters({ startDate: '2026-03-01' }), pureDeps)
      .map((i) => i.itemId)).toEqual(['mar']);
    expect(applyNdisMasterItemFilters(items, baseFilters({ endDate: '2026-03-01' }), pureDeps)
      .map((i) => i.itemId)).toEqual(['feb']);
  });

  it('filters the service delivery window on the actual start', () => {
    const items = [
      shift('a', { 'Actual Shift Start Date and Time': '2026-02-10T09:15:00+11:00' }),
      shift('b'),
    ];

    expect(applyNdisMasterItemFilters(items, baseFilters({ serviceDeliveryStart: '2026-03-01' }), pureDeps)
      .map((i) => i.itemId)).toEqual(['b']);
    expect(applyNdisMasterItemFilters(items, baseFilters({ serviceDeliveryEnd: '2026-03-01' }), pureDeps)
      .map((i) => i.itemId)).toEqual(['a']);
  });

  it('accepts the ampersand spelling of the actual start attribute as a fallback', () => {
    const items = [masterItem('a', { 'Actual Shift Start Date & Time': '2026-03-10T09:15:00+11:00' })];

    expect(applyNdisMasterItemFilters(items, baseFilters({ serviceDeliveryStart: '2026-03-01' }), pureDeps)
      .map((i) => i.itemId)).toEqual(['a']);
  });

  it('prefers the "and" spelling over the ampersand one', () => {
    const items = [masterItem('a', {
      'Actual Shift Start Date and Time': '2026-03-10T09:15:00+11:00',
      'Actual Shift Start Date & Time': '2026-01-01T09:15:00+11:00',
    })];

    expect(applyNdisMasterItemFilters(items, baseFilters({ serviceDeliveryStart: '2026-03-01' }), pureDeps)
      .map((i) => i.itemId)).toEqual(['a']);
  });

  it('excludes items whose date is missing or unparseable once a date filter is set', () => {
    const items = [
      shift('ok'),
      shift('missing', { 'Scheduled Shift Start Date & Time': null }),
      shift('garbage', { 'Scheduled Shift Start Date & Time': 'sometime next week' }),
    ];

    expect(applyNdisMasterItemFilters(items, baseFilters({ startDate: '2026-01-01' }), pureDeps)
      .map((i) => i.itemId)).toEqual(['ok']);
  });

  it('applies every filter conjunctively', () => {
    const items = [
      shift('a'),
      shift('b', { 'Payment Status': 'Paid' }),
      shift('c', { 'Participant Profile': [{ id: PP_ID_2 }] }),
    ];

    const result = applyNdisMasterItemFilters(items, baseFilters({
      participant: 'Jane',
      paymentStatusFilter: 'Unpaid',
      jobStatusFilter: 'completed',
      startDate: '2026-03-01',
      endDate: '2026-03-31',
      serviceDeliveryStart: '2026-03-01',
      serviceDeliveryEnd: '2026-03-31',
    }), pureDeps);

    expect(result.map((i) => i.itemId)).toEqual(['a']);
  });

  it('returns a new array rather than the input', () => {
    const items = [shift('a')];

    expect(applyNdisMasterItemFilters(items, baseFilters(), pureDeps)).not.toBe(items);
  });
});

describe('sortNdisMasterItems', () => {
  const shift = (itemId, scheduled, actual) => masterItem(itemId, {
    'Scheduled Shift Start Date & Time': scheduled,
    'Actual Shift Start Date and Time': actual,
  });

  const a = shift('a', '2026-03-10T09:00:00+11:00', '2026-01-05T09:00:00+11:00');
  const b = shift('b', '2026-01-10T09:00:00+11:00', '2026-03-05T09:00:00+11:00');
  const undated = masterItem('undated', {});

  it('sorts ascending by scheduled start by default', () => {
    expect(sortNdisMasterItems([a, b], 'scheduledServiceDate', 'asc', NDIS_MASTERPLAN_ATTR).map((i) => i.itemId))
      .toEqual(['b', 'a']);
  });

  it('sorts descending when asked', () => {
    expect(sortNdisMasterItems([b, a], 'scheduledServiceDate', 'desc', NDIS_MASTERPLAN_ATTR).map((i) => i.itemId))
      .toEqual(['a', 'b']);
  });

  it('sorts by the actual start when sortBy is serviceDeliveryDate', () => {
    expect(sortNdisMasterItems([a, b], 'serviceDeliveryDate', 'asc', NDIS_MASTERPLAN_ATTR).map((i) => i.itemId))
      .toEqual(['a', 'b']);
  });

  it('falls back to the scheduled start for an unknown sortBy', () => {
    expect(sortNdisMasterItems([a, b], 'somethingElse', 'asc', NDIS_MASTERPLAN_ATTR).map((i) => i.itemId))
      .toEqual(['b', 'a']);
  });

  it('puts undated and unparseable items last in both directions', () => {
    const garbage = shift('garbage', 'sometime next week', null);
    const input = [undated, a, garbage, b];

    expect(sortNdisMasterItems(input, 'scheduledServiceDate', 'asc', NDIS_MASTERPLAN_ATTR).map((i) => i.itemId))
      .toEqual(['b', 'a', 'undated', 'garbage']);
    expect(sortNdisMasterItems(input, 'scheduledServiceDate', 'desc', NDIS_MASTERPLAN_ATTR).map((i) => i.itemId))
      .toEqual(['a', 'b', 'undated', 'garbage']);
  });

  it('reads the ampersand spelling of the actual start as a fallback', () => {
    const alt = masterItem('alt', { 'Actual Shift Start Date & Time': '2026-01-01T09:00:00+11:00' });

    expect(sortNdisMasterItems([a, alt], 'serviceDeliveryDate', 'asc', NDIS_MASTERPLAN_ATTR).map((i) => i.itemId))
      .toEqual(['alt', 'a']);
  });

  it('returns a new array and leaves the input order alone', () => {
    const input = [a, b];
    const result = sortNdisMasterItems(input, 'scheduledServiceDate', 'asc', NDIS_MASTERPLAN_ATTR);

    expect(result).not.toBe(input);
    expect(input.map((i) => i.itemId)).toEqual(['a', 'b']);
  });
});

describe('removeMasterItemsMissingNdisNumber', () => {
  const withProfile = (itemId, profileId, extra = {}) => masterItem(itemId, {
    'Participant Profile': profileId ? [{ id: profileId }] : null,
    ...extra,
  });

  it('returns the same array untouched when every item has an NDIS number', () => {
    const items = [withProfile('a', PP_ID)];
    const refItemsMap = new Map([[PP_ID, refItem(PP_ID, { 'NDIS Number': '430000001' })]]);

    const result = removeMasterItemsMissingNdisNumber(items, refItemsMap, pureDeps);

    expect(result.masterItems).toBe(items);
    expect(result.missingNdis).toEqual([]);
  });

  it('removes items whose profile has no NDIS number and reports them', () => {
    const items = [withProfile('a', PP_ID), withProfile('b', PP_ID_2)];
    const refItemsMap = new Map([
      [PP_ID, refItem(PP_ID, { 'NDIS Number': '430000001', 'Full Name/Preferred Name': 'Jane Citizen' })],
      [PP_ID_2, refItem(PP_ID_2, { 'Full Name/Preferred Name': 'Bob Brown' })],
    ]);

    const result = removeMasterItemsMissingNdisNumber(items, refItemsMap, pureDeps);

    expect(result.masterItems.map((i) => i.itemId)).toEqual(['a']);
    expect(result.missingNdis).toEqual([{ itemId: 'b', participant: 'Bob Brown' }]);
  });

  it('treats an NDIS number of "0" as missing', () => {
    const items = [withProfile('a', PP_ID)];
    const refItemsMap = new Map([[PP_ID, refItem(PP_ID, { 'NDIS Number': '0', 'Full Name/Preferred Name': 'Jane' })]]);

    const result = removeMasterItemsMissingNdisNumber(items, refItemsMap, pureDeps);

    expect(result.masterItems).toEqual([]);
    expect(result.missingNdis).toEqual([{ itemId: 'a', participant: 'Jane' }]);
  });

  it('falls back to the shift participant name, trimmed, when the profile is unresolved', () => {
    const items = [withProfile('a', null, { 'Participant Full Name': '  Bob Brown  ' })];

    const result = removeMasterItemsMissingNdisNumber(items, new Map(), pureDeps);

    expect(result.missingNdis).toEqual([{ itemId: 'a', participant: 'Bob Brown' }]);
  });

  it('reports an empty participant when no name is available anywhere', () => {
    const result = removeMasterItemsMissingNdisNumber([withProfile('a', null)], new Map(), pureDeps);

    expect(result.missingNdis).toEqual([{ itemId: 'a', participant: '' }]);
  });

  it('removes every item that shares a reported itemId', () => {
    const items = [withProfile('dup', null), withProfile('dup', null), withProfile('ok', PP_ID)];
    const refItemsMap = new Map([[PP_ID, refItem(PP_ID, { 'NDIS Number': '430000001' })]]);

    const result = removeMasterItemsMissingNdisNumber(items, refItemsMap, pureDeps);

    expect(result.masterItems.map((i) => i.itemId)).toEqual(['ok']);
    expect(result.missingNdis).toHaveLength(2);
  });

  it('handles an empty list', () => {
    expect(removeMasterItemsMissingNdisNumber([], new Map(), pureDeps)).toEqual({ masterItems: [], missingNdis: [] });
  });
});

describe('expandMasterItemToClaimRows', () => {
  const serviceRows = () => ([
    { code: 'direct_support_time', unit: 'Hour', quantity: 3.25, unitPrice: 67.56, supportNumber: '01_011_0107_1_1', claimType: '' },
    { code: 'direct_support_non_time', unit: 'Each', quantity: 2, unitPrice: 10.5, supportNumber: '01_022_0120_1_1', claimType: '' },
  ]);

  const shift = (overrides = {}) => masterItem('mp-1', {
    'Participant Profile': [{ id: PP_ID }],
    'Service Plan': [{ id: SP_ID }],
    'Job Status': 'Completed',
    'Scheduled Shift Start Date & Time': '2026-03-10T09:00:00+11:00',
    'Scheduled Shift End Date & Time': '2026-03-10T12:00:00+11:00',
    'Actual Shift Start Date and Time': '2026-03-11T09:15:00+11:00',
    'Actual Shift End Date and Time': '2026-03-11T12:30:00+11:00',
    ...overrides,
  });

  const refItemsMap = () => new Map([
    [PP_ID, refItem(PP_ID, { 'Full Name/Preferred Name': 'Jane Citizen', 'NDIS Number': '430 000 001' })],
    [SP_ID, refItem(SP_ID, { 'Direct Support Item Number': [{ id: SUPPORT_ITEM_ID }] })],
    [SDM_ID, refItem(SDM_ID, { Name: 'Telehealth' })],
    [CR_ID, refItem(CR_ID, { 'Cancellation Reason': 'Participant health' })],
    [ALLOWANCE_ID, refItem(ALLOWANCE_ID, { Name: 'Sleepover allowance' })],
    [SUPPORT_ITEM_ID, refItem(SUPPORT_ITEM_ID, { 'Support Item Number': '01_011_0107_1_1' })],
  ]);

  const makeCtx = (overrides = {}) => ({
    workspaceId: 'ws-1',
    boardId: 'board-1',
    refItemsMap: refItemsMap(),
    invoiceNumberMap: new Map([['mp-1', 'INV/2026/001']]),
    business: { headOfficeTimezone: 'Australia/Sydney' },
    registrationNumber: '4050012345',
    abn: '12345678901',
    // Distinctive stand-ins for the two closures the route builds, so the tests
    // prove which value reaches which column. The real implementations are
    // covered end-to-end by the handleNdisInvoiceCsvExport tests below.
    sanitizeClaimReference: (v) => `SANITIZED(${v})`,
    formatCsvNumber: (v, d) => `NUM(${v},${d})`,
    ...overrides,
    deps: {
      ...pureDeps,
      resolveNdisPricingRuleForServicePlan: vi.fn().mockResolvedValue('legacy'),
      buildNdisMasterPlanServiceRows: vi.fn(() => serviceRows()),
      ...(overrides.deps || {}),
    },
  });

  it('maps each service row onto the NDIS claim CSV columns', async () => {
    const ctx = makeCtx();

    const rows = await expandMasterItemToClaimRows(shift(), ctx);

    expect(rows).toEqual([
      {
        RegistrationNumber: '4050012345',
        NDISNumber: '430000001',
        SupportDeliveredFrom: '11/03/2026',
        SupportDeliveredTo: '11/03/2026',
        SupportNumber: '01_011_0107_1_1',
        ClaimReference: 'SANITIZED(INV/2026/001)',
        Quantity: '',
        Hours: '3:18',
        UnitPrice: 'NUM(67.56,2)',
        GSTCode: 'P2',
        ClaimType: '',
        CancellationReason: '',
        'ABN of Support Provider': '12345678901',
      },
      {
        RegistrationNumber: '4050012345',
        NDISNumber: '430000001',
        SupportDeliveredFrom: '11/03/2026',
        SupportDeliveredTo: '11/03/2026',
        SupportNumber: '01_022_0120_1_1',
        ClaimReference: 'SANITIZED(INV/2026/001)',
        Quantity: '2.00',
        Hours: '',
        UnitPrice: 'NUM(10.5,2)',
        GSTCode: 'P2',
        ClaimType: '',
        CancellationReason: '',
        'ABN of Support Provider': '12345678901',
      },
    ]);
  });

  it('returns no rows when the row builder produces none', async () => {
    const ctx = makeCtx({ deps: { buildNdisMasterPlanServiceRows: vi.fn(() => []) } });

    expect(await expandMasterItemToClaimRows(shift(), ctx)).toEqual([]);
  });

  it('passes the resolved participant, plan and timezone to the row builder', async () => {
    const ctx = makeCtx();

    await expandMasterItemToClaimRows(shift(), ctx);

    const args = ctx.deps.buildNdisMasterPlanServiceRows.mock.calls[0][0];
    expect(args.participantName).toBe('Jane Citizen');
    expect(args.participantProfileItem.itemId).toBe(PP_ID);
    expect(args.servicePlanItem.itemId).toBe(SP_ID);
    expect(args.invoiceNumber).toBe('INV/2026/001');
    expect(args.invoicePdfLink).toBeNull();
    expect(args.timeZone).toBe('Australia/Sydney');
    expect(args.pricingRule).toBe('legacy');
    expect(args.cancellationTypeItem).toBeNull();
  });

  it('defaults the timezone to Australia/Sydney when the business has none', async () => {
    const ctx = makeCtx({ business: null });

    const rows = await expandMasterItemToClaimRows(shift(), ctx);

    expect(ctx.deps.buildNdisMasterPlanServiceRows.mock.calls[0][0].timeZone).toBe('Australia/Sydney');
    expect(rows[0].SupportDeliveredFrom).toBe('11/03/2026');
  });

  it('falls back to the participant name stored on the shift', async () => {
    const ctx = makeCtx({ refItemsMap: new Map() });

    await expandMasterItemToClaimRows(
      shift({ 'Participant Profile': null, 'Participant Full Name': '  Bob Brown  ' }), ctx,
    );

    expect(ctx.deps.buildNdisMasterPlanServiceRows.mock.calls[0][0].participantName).toBe('Bob Brown');
  });

  it('falls back to the generated invoice number when no InvoiceNumber row exists', async () => {
    const ctx = makeCtx({ invoiceNumberMap: new Map() });

    const rows = await expandMasterItemToClaimRows(
      shift({ 'Generated NDIS Invoice Number': '  NDIS-9  ' }), ctx,
    );

    expect(rows[0].ClaimReference).toBe('SANITIZED(NDIS-9)');
  });

  it('uses an empty claim reference when neither source has one', async () => {
    const ctx = makeCtx({ invoiceNumberMap: new Map() });

    const rows = await expandMasterItemToClaimRows(shift(), ctx);

    expect(rows[0].ClaimReference).toBe('SANITIZED()');
  });

  it('uses the scheduled window for a cancelled shift', async () => {
    const ctx = makeCtx();

    const rows = await expandMasterItemToClaimRows(shift({ 'Job Status': 'Cancelled' }), ctx);

    expect(rows[0].SupportDeliveredFrom).toBe('10/03/2026');
    expect(rows[0].SupportDeliveredTo).toBe('10/03/2026');
  });

  it('resolves the service delivery mode reference and derives a telehealth claim type', async () => {
    const ctx = makeCtx();

    const rows = await expandMasterItemToClaimRows(shift({ 'Service Delivery Mode': [{ id: SDM_ID }] }), ctx);

    expect(rows[0].ClaimType).toBe('THLT');
    expect(rows[1].ClaimType).toBe('THLT');
    expect(ctx.deps.buildNdisMasterPlanServiceRows.mock.calls[0][0].masterPlanItem.data['Service Delivery Mode'])
      .toBe('Telehealth');
  });

  it('resolves allowance references into labels for the row builder without touching the original item', async () => {
    const ctx = makeCtx();
    const item = shift({ Allowances: [{ id: ALLOWANCE_ID }] });

    await expandMasterItemToClaimRows(item, ctx);

    const passed = ctx.deps.buildNdisMasterPlanServiceRows.mock.calls[0][0].masterPlanItem;
    expect(passed.data.Allowances).toBe('Sleepover allowance');
    expect(passed).not.toBe(item);
    expect(item.data.Allowances).toEqual([{ id: ALLOWANCE_ID }]);
  });

  it('passes the item through unchanged when no label reference resolves', async () => {
    const ctx = makeCtx();
    const item = shift();

    await expandMasterItemToClaimRows(item, ctx);

    expect(ctx.deps.buildNdisMasterPlanServiceRows.mock.calls[0][0].masterPlanItem).toBe(item);
  });

  it('stamps the cancellation reason code on cancellation rows only', async () => {
    const cancellationRows = [
      { code: 'canc_direct_support', unit: 'Hour', quantity: 2, unitPrice: 67.56, supportNumber: '01_011_0107_1_1', claimType: 'CANC' },
      { code: 'direct_support_time', unit: 'Hour', quantity: 1, unitPrice: 67.56, supportNumber: '01_011_0107_1_1', claimType: '' },
    ];
    const ctx = makeCtx({ deps: { buildNdisMasterPlanServiceRows: vi.fn(() => cancellationRows) } });

    const rows = await expandMasterItemToClaimRows(
      shift({ 'Job Status': 'Cancelled', 'Cancellation Reason': [{ id: CR_ID }] }), ctx,
    );

    expect(rows[0].ClaimType).toBe('CANC');
    expect(rows[0].CancellationReason).toBe('NSDH');
    expect(rows[0].Hours).toBe('2:00');
    expect(rows[1].CancellationReason).toBe('');
  });

  it('leaves the cancellation reason empty when no reason is recorded', async () => {
    const cancellationRows = [
      { code: 'canc_direct_support', unit: 'Hour', quantity: 2, unitPrice: 67.56, supportNumber: '01_011_0107_1_1', claimType: 'CANC' },
    ];
    const ctx = makeCtx({ deps: { buildNdisMasterPlanServiceRows: vi.fn(() => cancellationRows) } });

    const rows = await expandMasterItemToClaimRows(shift({ 'Job Status': 'Cancelled' }), ctx);

    expect(rows[0].CancellationReason).toBe('');
  });

  it('emits an empty NDIS number when the profile cannot be resolved', async () => {
    const ctx = makeCtx({ refItemsMap: new Map() });

    const rows = await expandMasterItemToClaimRows(shift(), ctx);

    expect(rows[0].NDISNumber).toBe('');
  });

  it('emits an empty support number when the row carries none', async () => {
    const ctx = makeCtx({
      deps: {
        buildNdisMasterPlanServiceRows: vi.fn(() => [
          { code: 'direct_support_non_time', unit: 'Each', quantity: 1, unitPrice: 5 },
        ]),
      },
    });

    const rows = await expandMasterItemToClaimRows(shift(), ctx);

    expect(rows[0].SupportNumber).toBe('');
    expect(rows[0].Quantity).toBe('1.00');
  });
});

describe('handleNdisInvoiceCsvExport', () => {
  const makeRes = () => {
    const res = {};
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    return res;
  };

  const refRegistry = () => new Map([
    [PP_ID, refItem(PP_ID, { 'Full Name/Preferred Name': 'Jane Citizen', 'NDIS Number': '430 000 001' })],
    [PP_ID_2, refItem(PP_ID_2, { 'Full Name/Preferred Name': 'Bob Brown' })],
    [SP_ID, refItem(SP_ID, { 'Direct Support Item Number': [{ id: SUPPORT_ITEM_ID }] })],
    [SUPPORT_ITEM_ID, refItem(SUPPORT_ITEM_ID, { 'Support Item Number': '01_011_0107_1_1' })],
  ]);

  const masterItems = () => [
    masterItem('mp-1', {
      'Timesheet Approval': 'Approved',
      'Participant Profile': [{ id: PP_ID }],
      'Service Plan': [{ id: SP_ID }],
      'Job Status': 'Completed',
      'Payment Status': 'Unpaid',
      'Scheduled Shift Start Date & Time': '2026-03-10T09:00:00+11:00',
      'Scheduled Shift End Date & Time': '2026-03-10T12:00:00+11:00',
      'Actual Shift Start Date and Time': '2026-03-10T09:15:00+11:00',
      'Actual Shift End Date and Time': '2026-03-10T12:30:00+11:00',
    }),
    masterItem('mp-2', {
      'Timesheet Approval': 'Approved',
      'Participant Profile': [{ id: PP_ID_2 }],
      'Job Status': 'Completed',
      'Scheduled Shift Start Date & Time': '2026-03-11T09:00:00+11:00',
    }),
    masterItem('mp-3', {
      'Timesheet Approval': 'Pending',
      'Participant Profile': [{ id: PP_ID }],
      'Scheduled Shift Start Date & Time': '2026-03-12T09:00:00+11:00',
    }),
  ];

  const exportRows = () => ([
    { code: 'direct_support_time', unit: 'Hour', quantity: 3.25, unitPrice: 67.56, supportNumber: '01_011_0107_1_1', claimType: '' },
    { code: 'direct_support_non_time', unit: 'Each', quantity: 2, unitPrice: 100, supportNumber: '01_022_0120_1_1', claimType: '' },
    { code: 'direct_support_non_time', unit: 'Each', quantity: 1, unitPrice: 10.5, supportNumber: '01_022_0120_1_1', claimType: '' },
  ]);

  const makeDeps = (overrides = {}) => {
    const registry = refRegistry();
    return {
      ...pureDeps,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      Business: {
        findOne: vi.fn(() => ({
          select: vi.fn(() => ({
            lean: vi.fn().mockResolvedValue({
              abn: '12 345 678 901',
              companyRegistrationId: '4-050012345',
              headOfficeTimezone: 'Australia/Sydney',
            }),
          })),
        })),
      },
      Item: { find: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(masterItems()) })) },
      InvoiceNumber: {
        find: vi.fn(() => ({
          lean: vi.fn().mockResolvedValue([{ itemId: 'mp-1', invoiceNumber: 'INV 2026/001!' }]),
        })),
      },
      getFolderIds: vi.fn().mockResolvedValue(['folder-master-plan']),
      bulkFetchItemsFromDB: vi.fn(async (_ws, _board, ids) => new Map(
        ids.filter((id) => registry.has(id)).map((id) => [id, registry.get(id)]),
      )),
      resolveNdisPricingRuleForServicePlan: vi.fn().mockResolvedValue('legacy'),
      buildNdisMasterPlanServiceRows: vi.fn(() => exportRows()),
      ...overrides,
    };
  };

  const makeReq = (query = {}) => ({ params: { workspaceId: 'ws-1', boardId: 'board-1' }, query });

  it('returns the claim rows for approved items with an NDIS number', async () => {
    const res = makeRes();

    await handleNdisInvoiceCsvExport(makeReq(), res, makeDeps());

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.total).toBe(3);
    expect(body.items).toEqual([
      {
        RegistrationNumber: '4050012345',
        NDISNumber: '430000001',
        SupportDeliveredFrom: '10/03/2026',
        SupportDeliveredTo: '10/03/2026',
        SupportNumber: '01_011_0107_1_1',
        ClaimReference: 'INV_2026/001',
        Quantity: '',
        Hours: '3:18',
        UnitPrice: '67.56',
        GSTCode: 'P2',
        ClaimType: '',
        CancellationReason: '',
        'ABN of Support Provider': '12345678901',
      },
      {
        RegistrationNumber: '4050012345',
        NDISNumber: '430000001',
        SupportDeliveredFrom: '10/03/2026',
        SupportDeliveredTo: '10/03/2026',
        SupportNumber: '01_022_0120_1_1',
        ClaimReference: 'INV_2026/001',
        Quantity: '2.00',
        Hours: '',
        UnitPrice: '100',
        GSTCode: 'P2',
        ClaimType: '',
        CancellationReason: '',
        'ABN of Support Provider': '12345678901',
      },
      {
        RegistrationNumber: '4050012345',
        NDISNumber: '430000001',
        SupportDeliveredFrom: '10/03/2026',
        SupportDeliveredTo: '10/03/2026',
        SupportNumber: '01_022_0120_1_1',
        ClaimReference: 'INV_2026/001',
        Quantity: '1.00',
        Hours: '',
        UnitPrice: '10.5',
        GSTCode: 'P2',
        ClaimType: '',
        CancellationReason: '',
        'ABN of Support Provider': '12345678901',
      },
    ]);
    expect(typeof body.exportDurationMs).toBe('number');
  });

  it('drops non-approved items before anything else runs', async () => {
    const res = makeRes();
    const deps = makeDeps();

    await handleNdisInvoiceCsvExport(makeReq(), res, deps);

    // Only mp-1 and mp-2 are approved, so mp-3 never reaches the invoice lookup.
    expect(deps.InvoiceNumber.find).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      boardId: 'board-1',
      itemId: { $in: ['mp-1', 'mp-2'] },
      type: 'PDF',
    });
  });

  it('reports items skipped for a missing NDIS number and warns', async () => {
    const res = makeRes();
    const deps = makeDeps();
    const req = makeReq();

    await handleNdisInvoiceCsvExport(req, res, deps);

    const body = res.json.mock.calls[0][0];
    expect(body.skippedCount).toBe(1);
    expect(body.skipped).toEqual([{ itemId: 'mp-2', participant: 'Bob Brown' }]);
    expect(deps.warn).toHaveBeenCalledWith(
      'Export-Service',
      'Skipping items with missing NDIS number during export',
      { workspaceId: 'ws-1', boardId: 'board-1', skipped: 1 },
      req,
    );
  });

  it('sanitizes the claim reference: spaces to underscores, other punctuation dropped', async () => {
    const res = makeRes();
    const deps = makeDeps({
      InvoiceNumber: {
        find: vi.fn(() => ({
          lean: vi.fn().mockResolvedValue([{ itemId: 'mp-1', invoiceNumber: 'INV 2026/001 (draft)#' }]),
        })),
      },
    });

    await handleNdisInvoiceCsvExport(makeReq(), res, deps);

    expect(res.json.mock.calls[0][0].items[0].ClaimReference).toBe('INV_2026/001_draft');
  });

  it('truncates a claim reference longer than 50 characters', async () => {
    const res = makeRes();
    const deps = makeDeps({
      InvoiceNumber: {
        find: vi.fn(() => ({ lean: vi.fn().mockResolvedValue([{ itemId: 'mp-1', invoiceNumber: 'A'.repeat(60) }]) })),
      },
    });

    await handleNdisInvoiceCsvExport(makeReq(), res, deps);

    expect(res.json.mock.calls[0][0].items[0].ClaimReference).toBe('A'.repeat(50));
  });

  it('blanks a unit price that is not a finite number', async () => {
    const res = makeRes();
    const deps = makeDeps({
      buildNdisMasterPlanServiceRows: vi.fn(() => [
        { code: 'direct_support_non_time', unit: 'Each', quantity: 1, unitPrice: undefined, supportNumber: 'X' },
      ]),
    });

    await handleNdisInvoiceCsvExport(makeReq(), res, deps);

    expect(res.json.mock.calls[0][0].items[0].UnitPrice).toBe('');
  });

  it('exports a null or blank unit price as "0", not as an empty cell', async () => {
    // formatCsvNumber has no nullish guard: Number(null) and Number('') both
    // coerce to 0, so those cells carry a literal 0 into the claim CSV while
    // undefined and NaN come through blank. Documents current behaviour — an
    // empty cell and a 0 mean different things to a claims processor.
    for (const unitPrice of [null, '']) {
      const res = makeRes();
      const deps = makeDeps({
        buildNdisMasterPlanServiceRows: vi.fn(() => [
          { code: 'direct_support_non_time', unit: 'Each', quantity: 1, unitPrice, supportNumber: 'X' },
        ]),
      });

      await handleNdisInvoiceCsvExport(makeReq(), res, deps);

      expect(res.json.mock.calls[0][0].items[0].UnitPrice).toBe('0');
    }
  });

  it('caps the rows at a numeric limit', async () => {
    const res = makeRes();

    await handleNdisInvoiceCsvExport(makeReq({ limit: '2' }), res, makeDeps());

    const body = res.json.mock.calls[0][0];
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it('returns every row for limit "all", a zero limit or a non-numeric limit', async () => {
    for (const limit of ['all', 'ALL', '0', 'lots']) {
      const res = makeRes();
      await handleNdisInvoiceCsvExport(makeReq({ limit }), res, makeDeps());
      expect(res.json.mock.calls[0][0].items).toHaveLength(3);
    }
  });

  it('applies the participant filter before expanding rows', async () => {
    const res = makeRes();

    await handleNdisInvoiceCsvExport(makeReq({ participant: 'Bob' }), res, makeDeps());

    // mp-2 is Bob's, and it is dropped for having no NDIS number.
    const body = res.json.mock.calls[0][0];
    expect(body.items).toEqual([]);
    expect(body.skippedCount).toBe(1);
  });

  it('restricts the item query to the master-plan folders and drops the clause when none match', async () => {
    const withFolders = makeDeps();
    await handleNdisInvoiceCsvExport(makeReq(), makeRes(), withFolders);
    expect(withFolders.getFolderIds).toHaveBeenCalledWith('Master Plan,Shift Planning and Reporting', 'ws-1', 'board-1');
    expect(withFolders.Item.find).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      boardId: 'board-1',
      folderId: { $in: ['folder-master-plan'] },
    });

    const withoutFolders = makeDeps({ getFolderIds: vi.fn().mockResolvedValue([]) });
    await handleNdisInvoiceCsvExport(makeReq(), makeRes(), withoutFolders);
    expect(withoutFolders.Item.find).toHaveBeenCalledWith({ workspaceId: 'ws-1', boardId: 'board-1' });
  });

  it('loads the support catalogue referenced by each service plan', async () => {
    const res = makeRes();
    const deps = makeDeps();

    await handleNdisInvoiceCsvExport(makeReq(), res, deps);

    expect(deps.bulkFetchItemsFromDB).toHaveBeenCalledTimes(2);
    expect(deps.bulkFetchItemsFromDB.mock.calls[1][2]).toEqual([SUPPORT_ITEM_ID]);
  });

  it('rejects a business with no company registration id', async () => {
    const res = makeRes();
    const deps = makeDeps({
      Business: {
        findOne: vi.fn(() => ({
          select: vi.fn(() => ({ lean: vi.fn().mockResolvedValue({ abn: '12 345 678 901' }) })),
        })),
      },
    });

    await handleNdisInvoiceCsvExport(makeReq(), res, deps);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toContain('Company Registration ID');
    expect(deps.Item.find).not.toHaveBeenCalled();
  });

  it('rejects a business with no ABN', async () => {
    const res = makeRes();
    const deps = makeDeps({
      Business: {
        findOne: vi.fn(() => ({
          select: vi.fn(() => ({ lean: vi.fn().mockResolvedValue({ companyRegistrationId: '4-050012345' }) })),
        })),
      },
    });

    await handleNdisInvoiceCsvExport(makeReq(), res, deps);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toContain('ABN');
  });

  it('rejects a business document that does not exist', async () => {
    const res = makeRes();
    const deps = makeDeps({
      Business: { findOne: vi.fn(() => ({ select: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(null) })) })) },
    });

    await handleNdisInvoiceCsvExport(makeReq(), res, deps);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects a non-string boardId with 400 before reading the business', async () => {
    const res = makeRes();
    const deps = makeDeps();

    await handleNdisInvoiceCsvExport(
      { params: { workspaceId: 'ws-1', boardId: { $ne: '' } }, query: {} }, res, deps,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toContain('workspace or board is missing');
    expect(deps.Business.findOne).not.toHaveBeenCalled();
  });

  it('returns 500 and logs when a dependency throws', async () => {
    const res = makeRes();
    const boom = new Error('mongo is down');
    const deps = makeDeps({ getFolderIds: vi.fn().mockRejectedValue(boom) });

    await handleNdisInvoiceCsvExport(makeReq(), res, deps);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].message).toContain('NDIS claim CSV export failed');
    expect(deps.error).toHaveBeenCalledWith(
      'Export-Service', 'Failed to export NDIS invoice CSV', { err: boom }, expect.anything(),
    );
  });

  it('returns an empty export when the board has no approved items', async () => {
    const res = makeRes();
    const deps = makeDeps({ Item: { find: vi.fn(() => ({ lean: vi.fn().mockResolvedValue([]) })) } });

    await handleNdisInvoiceCsvExport(makeReq(), res, deps);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0]).toMatchObject({ items: [], total: 0, skippedCount: 0, skipped: [] });
    expect(deps.warn).not.toHaveBeenCalled();
  });
});
