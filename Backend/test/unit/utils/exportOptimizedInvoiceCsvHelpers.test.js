import { describe, it, expect, vi } from 'vitest';
import {
  mapRawItemToProcessedInvoiceRow,
  applyInvoiceCsvDateAndStatusFilters,
  sortProcessedInvoiceItems,
  calculateInvoiceCsvTotals,
  collectInvoiceCsvReferenceIds,
  populateInvoiceCsvParticipantNames,
  applyInvoiceCsvParticipantAndFundingFilters,
  loadNestedInvoiceServiceRefs,
  transformInvoiceCsvItem,
  handleInvoiceCsvExport,
} from '../../../src/utils/exportOptimizedInvoiceCsvHelpers.js';

/*
 * These helpers are dependency-injected: routes/exportOptimized.js builds a
 * `deps` object and hands it to every function. The accessors below are copies
 * of that object's simple members, so the helpers run against the real call
 * shapes. Only the four heavyweight service-plan resolvers (covered by
 * exportOptimizedServicePlanHelpers.test.js) and the Mongo-backed
 * bulkFetchItemsFromDB are replaced with stubs.
 */
const ATTRIBUTE_NAMES = {
  SCHEDULED_START: 'Scheduled Shift Start Date & Time',
  ACTUAL_START: 'Actual Shift Start Date & Time',
  ACTUAL_END: 'Actual Shift End Date & Time',
  PARTICIPANT_FULL_NAME: 'Participant Full Name',
  PARTICIPANT_PROFILE: 'Participant Profile',
  SERVICE_PLAN: 'Service Plan',
  SERVICE_PLAN_ID: 'Service Plan ID',
  UNIT: 'Unit',
  QUANTITY: 'Quantity',
  UNIT_PRICE: 'Unit Price ($)',
  TOTAL_AMOUNT: 'Total Amount ($)',
  GOV_SUBSIDY: 'Government Subsidy ($)',
  PARTICIPANT_CONTRIBUTION: 'Participant Contribution ($)',
  ADDITIONAL_NOTES: 'Additional Notes',
  TRANSACTION_STATUS: 'Transaction Status',
  FUNDING_SOURCE: 'Funding Source',
  PAYMENT_STATUS: 'Payment Status',
  DELIVERED_BY: 'Delivered by',
  FULL_NAME: 'Full Name/Preferred Name',
};

const getValue = (item, attributeName) => {
  if (!item?.data) return null;
  return item.data[attributeName] ?? null;
};

const getValueMulti = (item, attributeNames) => {
  if (!item?.data) return null;
  const names = Array.isArray(attributeNames) ? attributeNames : [attributeNames];
  for (const name of names) {
    if (item.data[name] !== undefined && item.data[name] !== null) return item.data[name];
  }
  return null;
};

const parseNumber = (value) => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const normalized = value.replace(/[^0-9.-]/g, '');
    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const parseDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }
  return null;
};

const formatStatus = (value) => {
  if (!value) return undefined;
  if (Array.isArray(value) && value.length > 0) {
    return value.map((entry) => {
      if (typeof entry === 'object' && entry.name) return entry.name;
      return String(entry);
    }).filter(Boolean).join(', ');
  }
  if (typeof value === 'object' && value.name) return value.name;
  if (typeof value === 'string') return value;
  return String(value);
};

const extractRefId = (value) => {
  if (!value) return null;
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    if (typeof first === 'object' && first.id) return first.id.toString();
    if (typeof first === 'string') return first;
    return first?.toString();
  }
  if (typeof value === 'object' && value.id) return value.id.toString();
  if (typeof value === 'string') return value;
  return value?.toString();
};

const extractAllRefIds = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (typeof v === 'object' && v.id) return v.id.toString();
      if (typeof v === 'string') return v;
      return v?.toString();
    }).filter(Boolean);
  }
  if (typeof value === 'object' && value.id) return [value.id.toString()];
  if (typeof value === 'string') return [value];
  return value ? [value.toString()] : [];
};

const getParticipantNameFromProfile = (profileItem) => {
  if (!profileItem) return null;
  const name = getValueMulti(profileItem, [
    'Preferred Name', 'Full Name/Preferred Name', 'Full Name', 'Preferred Name', 'Name',
  ]);
  if (!name) return null;
  if (typeof name === 'object' && name !== null) {
    return name.name ? String(name.name) : String(name);
  }
  return String(name);
};

const getMyAgedCareIdFromProfile = (profileItem) => {
  if (!profileItem) return null;
  const id = getValueMulti(profileItem, ['My Aged Care ID Number', 'My Aged Care ID']);
  if (!id) return null;
  return String(id);
};

const getServiceFromServicePlan = (servicePlanItem) => {
  if (!servicePlanItem) return null;
  const servicePlanIdValue = getValueMulti(servicePlanItem, ['Service Plan ID', 'Service Plan ID']);
  if (!servicePlanIdValue) return null;
  const servicePlanIdStr = String(servicePlanIdValue).trim();
  if (servicePlanIdStr.includes('-')) {
    const parts = servicePlanIdStr.split('-');
    return parts.length >= 2 ? parts.slice(1).join('-').trim() : servicePlanIdStr;
  }
  return servicePlanIdStr;
};

const stripEmojiFromFundingSource = (str) => (str || '')
  .replace(/[\u{1F300}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
  .trim();

/*
 * The source list has three names that resolve to `undefined` (REF_ATTR.FS_TITLE
 * and friends are not defined on REF_ATTR); they can never match, so only the
 * two real names are reproduced here.
 */
const getFundingSourceNameFromItem = (fsItem) => {
  if (!fsItem) return null;
  const name = getValueMulti(fsItem, ['Funding Stream', 'Full Name/Preferred Name']);
  if (!name) return null;
  const raw = (typeof name === 'object' && name !== null)
    ? (name.name ? String(name.name).trim() : String(name).trim())
    : String(name).trim();
  return stripEmojiFromFundingSource(raw) || null;
};

/** Stubs for the resolvers whose own behaviour is covered elsewhere. */
const stubServicePlanResolvers = (overrides = {}) => ({
  getServiceIdentifierFromServicePlan: () => 'HS_DOM_01',
  getItemDescriptionFromServicePlan: () => ({ code: 'IT_001', description: 'Shower chair' }),
  getWraparoundDescriptionFromServicePlan: () => ({ code: 'WR_001', description: 'Wraparound support' }),
  getHealthProfessionalFromServicePlan: () => ({ typeCode: 'PT', typeOther: 'Physiotherapist' }),
  ...overrides,
});

const baseHelpers = {
  getValue,
  ATTRIBUTE_NAMES,
  parseDate,
  parseNumber,
  formatStatus,
  extractRefId,
  extractAllRefIds,
  getParticipantNameFromProfile,
  getMyAgedCareIdFromProfile,
  getFundingSourceNameFromItem,
  getServiceFromServicePlan,
  ...stubServicePlanResolvers(),
};

/** A shift item as stored in Mongo by the sync worker. */
const shiftItem = (itemId, data) => ({
  _id: `oid-${itemId}`,
  itemId,
  workspaceId: 'ws-1',
  boardId: 'board-1',
  folderId: 'folder-master-plan',
  name: `Shift ${itemId}`,
  data,
});

const refItem = (itemId, data) => ({ itemId, boardId: 'board-1', data });

describe('mapRawItemToProcessedInvoiceRow', () => {
  it('projects a fully populated shift item onto the processed row', () => {
    const item = shiftItem('item-a', {
      'Scheduled Shift Start Date & Time': '2026-03-01T09:00:00Z',
      'Actual Shift End Date & Time': '2026-03-01T12:00:00Z',
      'Total Amount ($)': '$150.00',
      'Government Subsidy ($)': '120',
      'Participant Contribution ($)': 30,
      'Transaction Status': { name: 'Delivered - To be claimed and invoiced.' },
      'Payment Status': 'Unpaid',
      'Service Plan': [{ id: 'sp-1' }],
      'Participant Profile': [{ id: 'pp-1' }],
      'Funding Source': [{ id: 'fs-1' }, { id: 'fs-2' }],
    });

    const row = mapRawItemToProcessedInvoiceRow(item, baseHelpers);

    expect(row.item).toBe(item);
    expect(row.scheduledStartDate.toISOString()).toBe('2026-03-01T09:00:00.000Z');
    expect(row.actualEndDate.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(row.participantName).toBe('');
    expect(row.totalAmountNum).toBe(150);
    expect(row.govSubsidyNum).toBe(120);
    expect(row.participantContributionNum).toBe(30);
    expect(row.transactionStatus).toBe('Delivered - To be claimed and invoiced.');
    expect(row.paymentStatus).toBe('Unpaid');
    expect(row.servicePlanId).toBe('sp-1');
    expect(row.participantProfileId).toBe('pp-1');
    expect(row.fundingSourceIds).toEqual(['fs-1', 'fs-2']);
  });

  it('falls back to nulls, zeros and an empty ref list for an item with no data', () => {
    const row = mapRawItemToProcessedInvoiceRow(shiftItem('item-empty', {}), baseHelpers);

    expect(row.scheduledStartDate).toBeNull();
    expect(row.actualEndDate).toBeNull();
    expect(row.totalAmountNum).toBe(0);
    expect(row.govSubsidyNum).toBe(0);
    expect(row.participantContributionNum).toBe(0);
    expect(row.transactionStatus).toBeUndefined();
    expect(row.paymentStatus).toBeUndefined();
    expect(row.servicePlanId).toBeNull();
    expect(row.participantProfileId).toBeNull();
    expect(row.fundingSourceIds).toEqual([]);
  });

  it('nulls a date the source cannot parse instead of keeping an Invalid Date', () => {
    const row = mapRawItemToProcessedInvoiceRow(
      shiftItem('item-a', { 'Scheduled Shift Start Date & Time': 'not a date' }),
      baseHelpers,
    );

    expect(row.scheduledStartDate).toBeNull();
  });

  it('joins a multi-select status into one comma-separated string', () => {
    const row = mapRawItemToProcessedInvoiceRow(
      shiftItem('item-a', { 'Transaction Status': [{ name: 'Claimed' }, { name: 'Invoiced' }] }),
      baseHelpers,
    );

    expect(row.transactionStatus).toBe('Claimed, Invoiced');
  });
});

describe('applyInvoiceCsvDateAndStatusFilters', () => {
  const processed = (overrides) => ({
    scheduledStartDate: null,
    actualEndDate: null,
    transactionStatus: undefined,
    paymentStatus: undefined,
    ...overrides,
  });

  const march = processed({
    id: 'march',
    scheduledStartDate: new Date('2026-03-10T00:00:00Z'),
    actualEndDate: new Date('2026-03-11T00:00:00Z'),
    transactionStatus: 'Claimed',
    paymentStatus: 'Paid',
  });
  const january = processed({
    id: 'january',
    scheduledStartDate: new Date('2026-01-10T00:00:00Z'),
    actualEndDate: new Date('2026-01-11T00:00:00Z'),
    transactionStatus: 'Draft',
    paymentStatus: 'Unpaid',
  });
  const undated = processed({ id: 'undated', transactionStatus: 'Claimed', paymentStatus: 'Paid' });

  it('returns the input untouched when no filter is set', () => {
    const input = [march, january, undated];

    expect(applyInvoiceCsvDateAndStatusFilters(input, {})).toBe(input);
  });

  it('keeps only scheduled dates on or after startDate, dropping undated rows', () => {
    const result = applyInvoiceCsvDateAndStatusFilters([march, january, undated], { startDate: '2026-02-01' });

    expect(result.map((p) => p.id)).toEqual(['march']);
  });

  it('keeps only scheduled dates on or before endDate', () => {
    const result = applyInvoiceCsvDateAndStatusFilters([march, january, undated], { endDate: '2026-02-01' });

    expect(result.map((p) => p.id)).toEqual(['january']);
  });

  it('includes a row falling exactly on the boundary', () => {
    const result = applyInvoiceCsvDateAndStatusFilters([march], {
      startDate: '2026-03-10T00:00:00Z',
      endDate: '2026-03-10T00:00:00Z',
    });

    expect(result.map((p) => p.id)).toEqual(['march']);
  });

  it('filters service delivery on actualEndDate, not scheduledStartDate', () => {
    const mismatched = processed({
      id: 'mismatched',
      scheduledStartDate: new Date('2026-01-01T00:00:00Z'),
      actualEndDate: new Date('2026-06-01T00:00:00Z'),
    });

    expect(applyInvoiceCsvDateAndStatusFilters([mismatched], { serviceDeliveryStart: '2026-05-01' })
      .map((p) => p.id)).toEqual(['mismatched']);
    expect(applyInvoiceCsvDateAndStatusFilters([mismatched], { serviceDeliveryEnd: '2026-05-01' })
      .map((p) => p.id)).toEqual([]);
  });

  it('drops everything when the supplied date is unparseable', () => {
    // new Date('garbage') is an Invalid Date and every comparison against it is false.
    expect(applyInvoiceCsvDateAndStatusFilters([march, january], { startDate: 'garbage' })).toEqual([]);
  });

  it('matches transaction and payment status exactly and case-sensitively', () => {
    expect(applyInvoiceCsvDateAndStatusFilters([march, january], { transactionStatusFilter: 'Claimed' })
      .map((p) => p.id)).toEqual(['march']);
    expect(applyInvoiceCsvDateAndStatusFilters([march, january], { transactionStatusFilter: 'claimed' })).toEqual([]);
    expect(applyInvoiceCsvDateAndStatusFilters([march, january], { paymentStatusFilter: 'Unpaid' })
      .map((p) => p.id)).toEqual(['january']);
  });

  it('treats the sentinel "all" as no status filter', () => {
    const result = applyInvoiceCsvDateAndStatusFilters([march, january], {
      transactionStatusFilter: 'all',
      paymentStatusFilter: 'all',
    });

    expect(result.map((p) => p.id)).toEqual(['march', 'january']);
  });

  it('applies every filter conjunctively', () => {
    const result = applyInvoiceCsvDateAndStatusFilters([march, january, undated], {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      serviceDeliveryStart: '2026-01-01',
      serviceDeliveryEnd: '2026-12-31',
      transactionStatusFilter: 'Claimed',
      paymentStatusFilter: 'Paid',
    });

    expect(result.map((p) => p.id)).toEqual(['march']);
  });
});

describe('sortProcessedInvoiceItems', () => {
  const row = (id, scheduled, actual) => ({
    id,
    scheduledStartDate: scheduled === null ? null : new Date(scheduled),
    actualEndDate: actual === null ? null : new Date(actual),
  });

  const a = row('a', '2026-03-01T00:00:00Z', '2026-01-05T00:00:00Z');
  const b = row('b', '2026-01-01T00:00:00Z', '2026-03-05T00:00:00Z');
  const c = row('c', null, null);

  it('sorts ascending by scheduled start by default', () => {
    expect(sortProcessedInvoiceItems([a, b], undefined, undefined).map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('sorts descending when sortOrder is desc', () => {
    expect(sortProcessedInvoiceItems([b, a], 'scheduledServiceDate', 'desc').map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('sorts by actual end date when sortBy is serviceDeliveryDate', () => {
    expect(sortProcessedInvoiceItems([a, b], 'serviceDeliveryDate', 'asc').map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('falls back to scheduled start for an unknown sortBy', () => {
    expect(sortProcessedInvoiceItems([a, b], 'somethingElse', 'asc').map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('puts null dates last regardless of sort order', () => {
    expect(sortProcessedInvoiceItems([c, a, b], 'scheduledServiceDate', 'asc').map((p) => p.id)).toEqual(['b', 'a', 'c']);
    expect(sortProcessedInvoiceItems([c, a, b], 'scheduledServiceDate', 'desc').map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns a new array and leaves the input order alone', () => {
    const input = [a, b];
    const result = sortProcessedInvoiceItems(input, 'scheduledServiceDate', 'asc');

    expect(result).not.toBe(input);
    expect(input.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('handles an empty list', () => {
    expect(sortProcessedInvoiceItems([], 'scheduledServiceDate', 'asc')).toEqual([]);
  });
});

describe('calculateInvoiceCsvTotals', () => {
  it('sums the three money columns and counts the rows', () => {
    const rows = [
      { totalAmountNum: 150.5, govSubsidyNum: 120.25, participantContributionNum: 30.25 },
      { totalAmountNum: 200, govSubsidyNum: 0, participantContributionNum: 200 },
    ];

    expect(calculateInvoiceCsvTotals(rows)).toEqual({
      totalAmount: 350.5,
      totalGovSubsidy: 120.25,
      totalParticipantContribution: 230.25,
      total: 2,
    });
  });

  it('returns zeros for an empty list', () => {
    expect(calculateInvoiceCsvTotals([])).toEqual({
      totalAmount: 0,
      totalGovSubsidy: 0,
      totalParticipantContribution: 0,
      total: 0,
    });
  });

  it('keeps negative amounts (credit notes) in the sum', () => {
    const rows = [
      { totalAmountNum: 100, govSubsidyNum: 100, participantContributionNum: 0 },
      { totalAmountNum: -40, govSubsidyNum: -40, participantContributionNum: 0 },
    ];

    expect(calculateInvoiceCsvTotals(rows)).toMatchObject({ totalAmount: 60, totalGovSubsidy: 60, total: 2 });
  });
});

describe('collectInvoiceCsvReferenceIds', () => {
  it('collects de-duplicated ids into three sets', () => {
    const rows = [
      { servicePlanId: 'sp-1', participantProfileId: 'pp-1', fundingSourceIds: ['fs-1', 'fs-2'] },
      { servicePlanId: 'sp-1', participantProfileId: 'pp-2', fundingSourceIds: ['fs-2'] },
    ];

    const result = collectInvoiceCsvReferenceIds(rows);

    expect([...result.servicePlanIds]).toEqual(['sp-1']);
    expect([...result.participantProfileIds]).toEqual(['pp-1', 'pp-2']);
    expect([...result.fundingSourceIds]).toEqual(['fs-1', 'fs-2']);
  });

  it('skips null ids and empty funding-source lists', () => {
    const rows = [
      { servicePlanId: null, participantProfileId: null, fundingSourceIds: [] },
      { servicePlanId: '', participantProfileId: 'pp-1', fundingSourceIds: [null, '', 'fs-1'] },
    ];

    const result = collectInvoiceCsvReferenceIds(rows);

    expect(result.servicePlanIds.size).toBe(0);
    expect([...result.participantProfileIds]).toEqual(['pp-1']);
    expect([...result.fundingSourceIds]).toEqual(['fs-1']);
  });

  it('returns three empty sets for no rows', () => {
    const result = collectInvoiceCsvReferenceIds([]);

    expect(result.servicePlanIds.size).toBe(0);
    expect(result.participantProfileIds.size).toBe(0);
    expect(result.fundingSourceIds.size).toBe(0);
  });
});

describe('populateInvoiceCsvParticipantNames', () => {
  it('prefers the referenced profile name over the name stored on the shift', () => {
    const rows = [{
      item: shiftItem('item-a', { 'Participant Full Name': 'Stale Name' }),
      participantProfileId: 'pp-1',
      participantName: '',
    }];
    const refItemsMap = new Map([['pp-1', refItem('pp-1', { 'Full Name/Preferred Name': 'Jane Citizen' })]]);

    populateInvoiceCsvParticipantNames(rows, refItemsMap, baseHelpers);

    expect(rows[0].participantName).toBe('Jane Citizen');
  });

  it('falls back to the shift name when the profile is not in the map', () => {
    const rows = [{
      item: shiftItem('item-a', { 'Participant Full Name': 'Bob Brown' }),
      participantProfileId: 'pp-missing',
      participantName: '',
    }];

    populateInvoiceCsvParticipantNames(rows, new Map(), baseHelpers);

    expect(rows[0].participantName).toBe('Bob Brown');
  });

  it('falls back to the shift name when the profile carries no usable name', () => {
    const rows = [{
      item: shiftItem('item-a', { 'Participant Full Name': 'Bob Brown' }),
      participantProfileId: 'pp-1',
      participantName: '',
    }];
    const refItemsMap = new Map([['pp-1', refItem('pp-1', { 'Some Other Field': 'x' })]]);

    populateInvoiceCsvParticipantNames(rows, refItemsMap, baseHelpers);

    expect(rows[0].participantName).toBe('Bob Brown');
  });

  it('uses the shift name directly when there is no profile reference', () => {
    const rows = [{
      item: shiftItem('item-a', { 'Participant Full Name': 'Bob Brown' }),
      participantProfileId: null,
      participantName: '',
    }];

    populateInvoiceCsvParticipantNames(rows, new Map(), baseHelpers);

    expect(rows[0].participantName).toBe('Bob Brown');
  });

  it('produces an empty string when neither source has a name', () => {
    const rows = [{ item: shiftItem('item-a', {}), participantProfileId: null, participantName: '' }];

    populateInvoiceCsvParticipantNames(rows, new Map(), baseHelpers);

    expect(rows[0].participantName).toBe('');
  });

  it('stringifies an object shift name rather than reading its .name', () => {
    // The fallback is String(getValue(...) || ''), with no object handling.
    const rows = [{
      item: shiftItem('item-a', { 'Participant Full Name': { name: 'Bob Brown' } }),
      participantProfileId: null,
      participantName: '',
    }];

    populateInvoiceCsvParticipantNames(rows, new Map(), baseHelpers);

    expect(rows[0].participantName).toBe('[object Object]');
  });

  it('mutates the rows in place and returns nothing', () => {
    const rows = [{ item: shiftItem('item-a', { 'Participant Full Name': 'Bob' }), participantProfileId: null, participantName: '' }];

    expect(populateInvoiceCsvParticipantNames(rows, new Map(), baseHelpers)).toBeUndefined();
    expect(rows[0].participantName).toBe('Bob');
  });
});

describe('applyInvoiceCsvParticipantAndFundingFilters', () => {
  const rows = [
    { id: 'a', participantName: 'Jane Citizen', fundingSourceIds: ['fs-chsp'] },
    { id: 'b', participantName: 'Bob Brown', fundingSourceIds: ['fs-hcp'] },
    { id: 'c', participantName: '', fundingSourceIds: [] },
  ];
  const refItemsMap = new Map([
    ['fs-chsp', refItem('fs-chsp', { 'Funding Stream': 'CHSP' })],
    ['fs-hcp', refItem('fs-hcp', { 'Funding Stream': 'Home Care Package' })],
  ]);

  it('returns the input untouched when both filters are absent', () => {
    expect(applyInvoiceCsvParticipantAndFundingFilters(rows, {}, refItemsMap, getFundingSourceNameFromItem)).toBe(rows);
  });

  it('matches the participant case-insensitively on a substring', () => {
    const result = applyInvoiceCsvParticipantAndFundingFilters(
      rows, { participant: 'jane' }, refItemsMap, getFundingSourceNameFromItem,
    );

    expect(result.map((p) => p.id)).toEqual(['a']);
  });

  it('treats participant "all" as no filter', () => {
    const result = applyInvoiceCsvParticipantAndFundingFilters(
      rows, { participant: 'all' }, refItemsMap, getFundingSourceNameFromItem,
    );

    expect(result.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('escapes regex metacharacters in the participant name so they match literally', () => {
    const metaRows = [
      { id: 'literal', participantName: 'A.B (Ltd)', fundingSourceIds: [] },
      { id: 'wildcard', participantName: 'AXB (Ltd)', fundingSourceIds: [] },
    ];

    const result = applyInvoiceCsvParticipantAndFundingFilters(
      metaRows, { participant: 'A.B (Ltd)' }, new Map(), getFundingSourceNameFromItem,
    );

    expect(result.map((p) => p.id)).toEqual(['literal']);
  });

  it('filters on the resolved funding source name, matching a substring', () => {
    const result = applyInvoiceCsvParticipantAndFundingFilters(
      rows, { fundingSourceFilter: 'Home Care' }, refItemsMap, getFundingSourceNameFromItem,
    );

    expect(result.map((p) => p.id)).toEqual(['b']);
  });

  it('drops rows whose funding sources all fail to resolve', () => {
    const unresolvable = [{ id: 'x', participantName: 'Jane', fundingSourceIds: ['fs-missing'] }];

    const result = applyInvoiceCsvParticipantAndFundingFilters(
      unresolvable, { fundingSourceFilter: 'CHSP' }, new Map(), getFundingSourceNameFromItem,
    );

    expect(result).toEqual([]);
  });

  it('still matches when only some funding sources resolve', () => {
    // Unresolved ids join as empty strings, so the surviving name is still searchable.
    const mixed = [{ id: 'x', participantName: 'Jane', fundingSourceIds: ['fs-missing', 'fs-chsp'] }];

    const result = applyInvoiceCsvParticipantAndFundingFilters(
      mixed, { fundingSourceFilter: 'CHSP' }, refItemsMap, getFundingSourceNameFromItem,
    );

    expect(result.map((p) => p.id)).toEqual(['x']);
  });

  it('treats funding source "all" as no filter', () => {
    const result = applyInvoiceCsvParticipantAndFundingFilters(
      rows, { fundingSourceFilter: 'all' }, refItemsMap, getFundingSourceNameFromItem,
    );

    expect(result.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('applies both filters together', () => {
    const result = applyInvoiceCsvParticipantAndFundingFilters(
      rows, { participant: 'Bob', fundingSourceFilter: 'CHSP' }, refItemsMap, getFundingSourceNameFromItem,
    );

    expect(result).toEqual([]);
  });
});

describe('loadNestedInvoiceServiceRefs', () => {
  const helpersWithFetch = (bulkFetchItemsFromDB) => ({ getValue, extractAllRefIds, bulkFetchItemsFromDB });

  it('fetches the nested service references and merges them into the map', async () => {
    const refItemsMap = new Map([
      ['sp-1', refItem('sp-1', {
        'Home Support (HS)': [{ id: 'hs-1' }],
        'Health Professional': [{ id: 'hp-1' }],
      })],
    ]);
    const fetched = new Map([
      ['hs-1', refItem('hs-1', { Service: 'Domestic assistance' })],
      ['hp-1', refItem('hp-1', { Service: 'Physio' })],
    ]);
    const bulkFetchItemsFromDB = vi.fn().mockResolvedValue(fetched);

    const result = await loadNestedInvoiceServiceRefs(
      new Set(['sp-1']), refItemsMap, 'ws-1', 'board-1', helpersWithFetch(bulkFetchItemsFromDB),
    );

    expect(bulkFetchItemsFromDB).toHaveBeenCalledTimes(1);
    expect(bulkFetchItemsFromDB.mock.calls[0][0]).toBe('ws-1');
    expect(bulkFetchItemsFromDB.mock.calls[0][1]).toBe('board-1');
    expect([...bulkFetchItemsFromDB.mock.calls[0][2]].sort()).toEqual(['hp-1', 'hs-1']);
    expect(result).toBe(refItemsMap);
    expect(result.get('hs-1')).toEqual(refItem('hs-1', { Service: 'Domestic assistance' }));
    expect(result.get('sp-1')).toBeDefined();
  });

  it('reads all six service reference attributes, including Wraparound', async () => {
    const refItemsMap = new Map([
      ['sp-1', refItem('sp-1', {
        'Home Support (HS)': [{ id: 'r1' }],
        'Assistive Technology (AT) - Short Term': [{ id: 'r2' }],
        'Assistive Technology (AT) - Ongoing': [{ id: 'r3' }],
        'Home Modification (HM)': [{ id: 'r4' }],
        'Health Professional': [{ id: 'r5' }],
        Wraparound: [{ id: 'r6' }],
        'Some Other Reference': [{ id: 'ignored' }],
      })],
    ]);
    const bulkFetchItemsFromDB = vi.fn().mockResolvedValue(new Map());

    await loadNestedInvoiceServiceRefs(
      new Set(['sp-1']), refItemsMap, 'ws-1', 'board-1', helpersWithFetch(bulkFetchItemsFromDB),
    );

    expect([...bulkFetchItemsFromDB.mock.calls[0][2]].sort()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
  });

  it('de-duplicates ids shared by several service plans', async () => {
    const refItemsMap = new Map([
      ['sp-1', refItem('sp-1', { 'Home Support (HS)': [{ id: 'hs-1' }] })],
      ['sp-2', refItem('sp-2', { 'Home Support (HS)': [{ id: 'hs-1' }] })],
    ]);
    const bulkFetchItemsFromDB = vi.fn().mockResolvedValue(new Map());

    await loadNestedInvoiceServiceRefs(
      new Set(['sp-1', 'sp-2']), refItemsMap, 'ws-1', 'board-1', helpersWithFetch(bulkFetchItemsFromDB),
    );

    expect(bulkFetchItemsFromDB.mock.calls[0][2]).toEqual(['hs-1']);
  });

  it('does not hit the database when no service plan has nested references', async () => {
    const refItemsMap = new Map([['sp-1', refItem('sp-1', { 'Service Plan ID': 'SP-1' })]]);
    const bulkFetchItemsFromDB = vi.fn();

    const result = await loadNestedInvoiceServiceRefs(
      new Set(['sp-1']), refItemsMap, 'ws-1', 'board-1', helpersWithFetch(bulkFetchItemsFromDB),
    );

    expect(bulkFetchItemsFromDB).not.toHaveBeenCalled();
    expect(result).toBe(refItemsMap);
  });

  it('skips service plan ids that are missing from the map or carry no data', async () => {
    const refItemsMap = new Map([['sp-2', { itemId: 'sp-2' }]]);
    const bulkFetchItemsFromDB = vi.fn();

    await loadNestedInvoiceServiceRefs(
      new Set(['sp-missing', 'sp-2']), refItemsMap, 'ws-1', 'board-1', helpersWithFetch(bulkFetchItemsFromDB),
    );

    expect(bulkFetchItemsFromDB).not.toHaveBeenCalled();
  });

  it('lets a fetched entry overwrite an existing one with the same id', async () => {
    const refItemsMap = new Map([
      ['sp-1', refItem('sp-1', { 'Home Support (HS)': [{ id: 'hs-1' }] })],
      ['hs-1', refItem('hs-1', { Service: 'stale' })],
    ]);
    const bulkFetchItemsFromDB = vi.fn().mockResolvedValue(
      new Map([['hs-1', refItem('hs-1', { Service: 'fresh' })]]),
    );

    const result = await loadNestedInvoiceServiceRefs(
      new Set(['sp-1']), refItemsMap, 'ws-1', 'board-1', helpersWithFetch(bulkFetchItemsFromDB),
    );

    expect(result.get('hs-1').data.Service).toBe('fresh');
  });
});

describe('transformInvoiceCsvItem', () => {
  const fullShift = () => shiftItem('item-a', {
    'Scheduled Shift Start Date & Time': '2026-03-01T09:00:00Z',
    'Actual Shift End Date & Time': '2026-03-01T12:00:00Z',
    Unit: 'Hour',
    Quantity: '3',
    'Unit Price ($)': '50.00',
    'Total Amount ($)': '$150.00',
    'Government Subsidy ($)': '120',
    'Participant Contribution ($)': '30',
    'Additional Notes': 'Client requested a morning slot',
    'Transaction Status': { name: 'Delivered - To be claimed and invoiced.' },
    'Payment Status': 'Unpaid',
    'Delivered by': 'Associated Provider Pty Ltd',
  });

  const fullProcessed = (item) => ({
    item,
    participantName: 'Jane Citizen',
    servicePlanId: 'sp-1',
    participantProfileId: 'pp-1',
    fundingSourceIds: ['fs-chsp'],
  });

  const fullRefMap = () => new Map([
    ['sp-1', refItem('sp-1', { 'Service Plan ID': 'HS-Domestic Assistance' })],
    ['pp-1', refItem('pp-1', { 'Full Name/Preferred Name': 'Jane Citizen', 'My Aged Care ID Number': 'AC1234567' })],
    ['fs-chsp', refItem('fs-chsp', { 'Funding Stream': '🏠 CHSP' })],
  ]);

  it('produces the full export row for a populated shift', () => {
    const item = fullShift();

    const result = transformInvoiceCsvItem(
      fullProcessed(item), fullRefMap(), new Map([['item-a', 'INV-0001']]), baseHelpers,
    );

    expect(result).toEqual({
      id: 'item-a',
      paymentStatus: 'Unpaid',
      participant: 'Jane Citizen',
      service: 'Domestic Assistance',
      scheduledServiceDate: '2026-03-01',
      serviceDeliveryDate: '2026-03-01',
      unit: 'Hour',
      quantity: 3,
      unitPrice: 50,
      totalAmount: 150,
      govSubsidy: 120,
      participantContribution: 30,
      fundingSource: 'CHSP',
      transactionStatus: 'Delivered - To be claimed and invoiced.',
      notes: 'Client requested a morning slot',
      invoiceNumber: 'INV-0001',
      careRecipientIdentifier: 'AC1234567',
      serviceIdentifier: 'HS_DOM_01',
      deliveredByThirdParty: 'True',
      itemOrWraparound: '',
      itemDescriptionCode: '',
      itemDescription: '',
      wraparoundDescriptionCode: '',
      wraparoundDescription: '',
      prescribedItem: 'N',
      itemPurchasedMethod: undefined,
      loanedByOrganisationName: '',
      loanedByInvoiceNumber: '',
      healthProfessionalTypeCode: 'PT',
      healthProfessionalTypeOther: 'Physiotherapist',
      itemFirstPayment: 'False',
    });
  });

  it('falls back to empty strings, zeros and nulls for a bare shift', () => {
    const item = shiftItem('item-bare', {});

    const result = transformInvoiceCsvItem(
      { item, participantName: '', servicePlanId: null, participantProfileId: null, fundingSourceIds: [] },
      new Map(), new Map(), baseHelpers,
    );

    expect(result).toEqual({
      id: 'item-bare',
      paymentStatus: undefined,
      participant: '',
      service: '',
      scheduledServiceDate: null,
      serviceDeliveryDate: null,
      unit: '',
      quantity: 0,
      unitPrice: 0,
      totalAmount: 0,
      govSubsidy: 0,
      participantContribution: 0,
      fundingSource: '',
      transactionStatus: undefined,
      notes: '',
      invoiceNumber: undefined,
      careRecipientIdentifier: '',
      serviceIdentifier: '',
      deliveredByThirdParty: 'False',
      itemOrWraparound: '',
      itemDescriptionCode: '',
      itemDescription: '',
      wraparoundDescriptionCode: '',
      wraparoundDescription: '',
      prescribedItem: 'N',
      itemPurchasedMethod: undefined,
      loanedByOrganisationName: '',
      loanedByInvoiceNumber: '',
      healthProfessionalTypeCode: '',
      healthProfessionalTypeOther: '',
      itemFirstPayment: 'False',
    });
  });

  it('blanks the service-plan columns when the service plan is not in the ref map', () => {
    const item = fullShift();

    const result = transformInvoiceCsvItem(fullProcessed(item), new Map(), new Map(), baseHelpers);

    expect(result.service).toBe('');
    expect(result.serviceIdentifier).toBe('');
    expect(result.healthProfessionalTypeCode).toBe('');
    expect(result.careRecipientIdentifier).toBe('');
    expect(result.fundingSource).toBe('');
  });

  it('takes the date part before the "T" and before a space', () => {
    const spaced = shiftItem('item-a', {
      'Scheduled Shift Start Date & Time': '2026-03-01 09:00:00',
      'Actual Shift End Date & Time': '2026-03-02T12:00:00+11:00',
    });

    const result = transformInvoiceCsvItem(
      { item: spaced, participantName: '', servicePlanId: null, participantProfileId: null, fundingSourceIds: [] },
      new Map(), new Map(), baseHelpers,
    );

    expect(result.scheduledServiceDate).toBe('2026-03-01');
    expect(result.serviceDeliveryDate).toBe('2026-03-02');
  });

  it('nulls a date that is not a string', () => {
    const dated = shiftItem('item-a', { 'Scheduled Shift Start Date & Time': 20260301 });

    const result = transformInvoiceCsvItem(
      { item: dated, participantName: '', servicePlanId: null, participantProfileId: null, fundingSourceIds: [] },
      new Map(), new Map(), baseHelpers,
    );

    expect(result.scheduledServiceDate).toBeNull();
  });

  it('joins several resolvable funding sources and skips the unresolvable ones', () => {
    const item = fullShift();
    const refMap = fullRefMap();
    refMap.set('fs-hcp', refItem('fs-hcp', { 'Funding Stream': 'Home Care Package' }));

    const result = transformInvoiceCsvItem(
      { ...fullProcessed(item), fundingSourceIds: ['fs-chsp', 'fs-missing', 'fs-hcp'] },
      refMap, new Map(), baseHelpers,
    );

    expect(result.fundingSource).toBe('CHSP, Home Care Package');
  });

  it('flags third-party delivery only when "associated" appears in Delivered by', () => {
    const item = fullShift();
    item.data['Delivered by'] = 'ASSOCIATED provider';
    expect(transformInvoiceCsvItem(fullProcessed(item), fullRefMap(), new Map(), baseHelpers).deliveredByThirdParty)
      .toBe('True');

    item.data['Delivered by'] = 'In-house staff';
    expect(transformInvoiceCsvItem(fullProcessed(item), fullRefMap(), new Map(), baseHelpers).deliveredByThirdParty)
      .toBe('False');
  });

  it('marks an item-unit row as "Item" and carries the item description columns only', () => {
    const item = fullShift();
    item.data.Unit = 'ITEM';

    const result = transformInvoiceCsvItem(fullProcessed(item), fullRefMap(), new Map(), baseHelpers);

    expect(result.itemOrWraparound).toBe('Item');
    expect(result.itemDescriptionCode).toBe('IT_001');
    expect(result.itemDescription).toBe('Shower chair');
    expect(result.wraparoundDescriptionCode).toBe('');
    expect(result.wraparoundDescription).toBe('');
  });

  it('marks a wraparound service as "Wraparound" and carries the wraparound columns only', () => {
    const item = fullShift();
    const refMap = fullRefMap();
    refMap.set('sp-1', refItem('sp-1', { 'Service Plan ID': 'WR-Wraparound Coordination' }));

    const result = transformInvoiceCsvItem(fullProcessed(item), refMap, new Map(), baseHelpers);

    expect(result.service).toBe('Wraparound Coordination');
    expect(result.itemOrWraparound).toBe('Wraparound');
    expect(result.wraparoundDescriptionCode).toBe('WR_001');
    expect(result.wraparoundDescription).toBe('Wraparound support');
    expect(result.itemDescriptionCode).toBe('');
  });

  it('lets the item unit win the label but still fills the wraparound columns', () => {
    // Both branches are evaluated independently, so a wraparound service billed
    // per item is labelled "Item" while keeping its wraparound description.
    const item = fullShift();
    item.data.Unit = 'Item';
    const refMap = fullRefMap();
    refMap.set('sp-1', refItem('sp-1', { 'Service Plan ID': 'WR-Wraparound Coordination' }));

    const result = transformInvoiceCsvItem(fullProcessed(item), refMap, new Map(), baseHelpers);

    expect(result.itemOrWraparound).toBe('Item');
    expect(result.itemDescriptionCode).toBe('IT_001');
    expect(result.wraparoundDescriptionCode).toBe('WR_001');
  });

  it('maps Prescribed Item true, "true" and "Y" to Y and anything else to N', () => {
    const withPrescribed = (value) => {
      const item = fullShift();
      item.data['Prescribed Item'] = value;
      return transformInvoiceCsvItem(fullProcessed(item), fullRefMap(), new Map(), baseHelpers).prescribedItem;
    };

    expect(withPrescribed(true)).toBe('Y');
    expect(withPrescribed('true')).toBe('Y');
    expect(withPrescribed('Y')).toBe('Y');
    expect(withPrescribed('y')).toBe('N');
    expect(withPrescribed('Yes')).toBe('N');
    expect(withPrescribed(false)).toBe('N');
  });

  it('maps Item First Payment from booleans and yes-like strings', () => {
    const withFirstPayment = (value) => {
      const item = fullShift();
      item.data['Item First Payment'] = value;
      return transformInvoiceCsvItem(fullProcessed(item), fullRefMap(), new Map(), baseHelpers).itemFirstPayment;
    };

    expect(withFirstPayment(true)).toBe('True');
    expect(withFirstPayment(false)).toBe('False');
    expect(withFirstPayment(' YES ')).toBe('True');
    expect(withFirstPayment('y')).toBe('True');
    expect(withFirstPayment('true')).toBe('True');
    expect(withFirstPayment('no')).toBe('False');
    expect(withFirstPayment(1)).toBe('False');
  });

  it('maps a purchase method containing "loan" to LOANED and anything else to PURCHASED', () => {
    const withMethod = (value) => {
      const item = fullShift();
      item.data['Item Purchased Method'] = value;
      return transformInvoiceCsvItem(fullProcessed(item), fullRefMap(), new Map(), baseHelpers);
    };

    expect(withMethod('Loan Agreement').itemPurchasedMethod).toBe('LOANED');
    expect(withMethod({ name: 'Purchased outright' }).itemPurchasedMethod).toBe('PURCHASED');
    expect(withMethod('').itemPurchasedMethod).toBeUndefined();
  });

  it('carries the lender columns only for a LOANED item', () => {
    const item = fullShift();
    item.data['If Loaned, Lender Name'] = { name: 'Mobility Hire Co' };
    item.data['If Loaned, Lender Invoice No.'] = 'LEND-77';

    item.data['Item Purchased Method'] = 'Loan';
    const loaned = transformInvoiceCsvItem(fullProcessed(item), fullRefMap(), new Map(), baseHelpers);
    expect(loaned.loanedByOrganisationName).toBe('Mobility Hire Co');
    expect(loaned.loanedByInvoiceNumber).toBe('LEND-77');

    item.data['Item Purchased Method'] = 'Purchased';
    const purchased = transformInvoiceCsvItem(fullProcessed(item), fullRefMap(), new Map(), baseHelpers);
    expect(purchased.loanedByOrganisationName).toBe('');
    expect(purchased.loanedByInvoiceNumber).toBe('');
  });

  it('stringifies a plain-string lender name for a LOANED item', () => {
    const item = fullShift();
    item.data['Item Purchased Method'] = 'Short-term loan';
    item.data['If Loaned, Lender Name'] = 'Mobility Hire Co';

    const result = transformInvoiceCsvItem(fullProcessed(item), fullRefMap(), new Map(), baseHelpers);

    expect(result.loanedByOrganisationName).toBe('Mobility Hire Co');
    expect(result.loanedByInvoiceNumber).toBe('');
  });

  it('keeps values that would need CSV quoting exactly as they are', () => {
    // These helpers emit JSON rows; quoting and escaping happen in the client,
    // so commas, quotes, newlines and a leading "=" must survive untouched.
    const item = fullShift();
    item.data['Additional Notes'] = 'Cancelled, "late notice"\nrebooked';
    item.data.Unit = '=cmd|calc';

    const result = transformInvoiceCsvItem(fullProcessed(item), fullRefMap(), new Map(), baseHelpers);

    expect(result.notes).toBe('Cancelled, "late notice"\nrebooked');
    expect(result.unit).toBe('=cmd|calc');
  });
});

describe('handleInvoiceCsvExport', () => {
  const makeRes = () => {
    const res = {};
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    return res;
  };

  const items = () => [
    shiftItem('item-a', {
      'Scheduled Shift Start Date & Time': '2026-03-01T09:00:00Z',
      'Actual Shift End Date & Time': '2026-03-01T12:00:00Z',
      'Participant Profile': [{ id: 'pp-1' }],
      'Service Plan': [{ id: 'sp-1' }],
      'Funding Source': [{ id: 'fs-chsp' }],
      Unit: 'Hour',
      Quantity: '3',
      'Unit Price ($)': '50',
      'Total Amount ($)': '150',
      'Government Subsidy ($)': '120',
      'Participant Contribution ($)': '30',
      'Transaction Status': 'Claimed',
      'Payment Status': 'Paid',
    }),
    shiftItem('item-b', {
      'Scheduled Shift Start Date & Time': '2026-02-01T09:00:00Z',
      'Participant Full Name': 'Bob Brown',
      Unit: 'Item',
      'Total Amount ($)': '200',
      'Participant Contribution ($)': '200',
      'Transaction Status': 'Draft',
      'Payment Status': 'Unpaid',
    }),
  ];

  const makeDeps = (overrides = {}) => ({
    ...baseHelpers,
    info: vi.fn(),
    error: vi.fn(),
    getFolderIds: vi.fn().mockResolvedValue(['folder-master-plan']),
    Item: { find: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(items()) })) },
    InvoiceNumber: {
      find: vi.fn(() => ({ lean: vi.fn().mockResolvedValue([{ itemId: 'item-a', invoiceNumber: 'INV-0001' }]) })),
    },
    bulkFetchItemsFromDB: vi.fn().mockResolvedValue(new Map([
      ['pp-1', refItem('pp-1', { 'Full Name/Preferred Name': 'Jane Citizen', 'My Aged Care ID Number': 'AC1234567' })],
      ['sp-1', refItem('sp-1', { 'Service Plan ID': 'HS-Domestic Assistance' })],
      ['fs-chsp', refItem('fs-chsp', { 'Funding Stream': 'CHSP' })],
    ])),
    ...overrides,
  });

  const makeReq = (query = {}) => ({ params: { workspaceId: 'ws-1', boardId: 'board-1' }, query });

  it('returns the transformed rows and totals, sorted ascending by scheduled date', async () => {
    const res = makeRes();
    const deps = makeDeps();

    await handleInvoiceCsvExport(makeReq(), res, deps);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.total).toBe(2);
    expect(body.totalAmount).toBe(350);
    expect(body.totalGovSubsidy).toBe(120);
    expect(body.totalParticipantContribution).toBe(230);
    expect(body.items.map((i) => i.id)).toEqual(['item-b', 'item-a']);
    expect(body.items[1]).toMatchObject({
      id: 'item-a',
      participant: 'Jane Citizen',
      service: 'Domestic Assistance',
      careRecipientIdentifier: 'AC1234567',
      fundingSource: 'CHSP',
      invoiceNumber: 'INV-0001',
      scheduledServiceDate: '2026-03-01',
      serviceDeliveryDate: '2026-03-01',
      quantity: 3,
      unitPrice: 50,
    });
    expect(body.items[0]).toMatchObject({
      id: 'item-b',
      participant: 'Bob Brown',
      service: '',
      itemOrWraparound: 'Item',
      invoiceNumber: undefined,
    });
    expect(typeof body.exportDurationMs).toBe('number');
  });

  it('restricts the item query to the master-plan folders', async () => {
    const res = makeRes();
    const deps = makeDeps();

    await handleInvoiceCsvExport(makeReq(), res, deps);

    expect(deps.getFolderIds).toHaveBeenCalledWith('Master Plan,Shift Planning and Reporting', 'ws-1', 'board-1');
    expect(deps.Item.find).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      boardId: 'board-1',
      folderId: { $in: ['folder-master-plan'] },
    });
  });

  it('queries every item on the board when no folder matches', async () => {
    const res = makeRes();
    const deps = makeDeps({ getFolderIds: vi.fn().mockResolvedValue([]) });

    await handleInvoiceCsvExport(makeReq(), res, deps);

    expect(deps.Item.find).toHaveBeenCalledWith({ workspaceId: 'ws-1', boardId: 'board-1' });
  });

  it('recomputes the totals after the participant filter, not before', async () => {
    const res = makeRes();

    await handleInvoiceCsvExport(makeReq({ participant: 'Jane' }), res, makeDeps());

    const body = res.json.mock.calls[0][0];
    expect(body.items.map((i) => i.id)).toEqual(['item-a']);
    expect(body.total).toBe(1);
    expect(body.totalAmount).toBe(150);
    expect(body.totalParticipantContribution).toBe(30);
  });

  it('applies the date and status query filters', async () => {
    const res = makeRes();

    await handleInvoiceCsvExport(makeReq({ startDate: '2026-02-15', paymentStatus: 'Paid' }), res, makeDeps());

    const body = res.json.mock.calls[0][0];
    expect(body.items.map((i) => i.id)).toEqual(['item-a']);
    expect(body.total).toBe(1);
  });

  it('sorts descending when asked', async () => {
    const res = makeRes();

    await handleInvoiceCsvExport(makeReq({ sortOrder: 'desc' }), res, makeDeps());

    expect(res.json.mock.calls[0][0].items.map((i) => i.id)).toEqual(['item-a', 'item-b']);
  });

  it('looks up invoice numbers only for the surviving items', async () => {
    const res = makeRes();
    const deps = makeDeps();

    await handleInvoiceCsvExport(makeReq({ participant: 'Jane' }), res, deps);

    expect(deps.InvoiceNumber.find).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      boardId: 'board-1',
      itemId: { $in: ['item-a'] },
    });
  });

  it('rejects a non-string workspaceId with 400 and touches no collection', async () => {
    const res = makeRes();
    const deps = makeDeps();

    await handleInvoiceCsvExport(
      { params: { workspaceId: { $ne: '' }, boardId: 'board-1' }, query: {} }, res, deps,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toContain('workspace or board is missing');
    expect(deps.Item.find).not.toHaveBeenCalled();
  });

  it('returns 500 and logs when a dependency throws', async () => {
    const res = makeRes();
    const boom = new Error('mongo is down');
    const deps = makeDeps({ getFolderIds: vi.fn().mockRejectedValue(boom) });

    await handleInvoiceCsvExport(makeReq(), res, deps);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].message).toContain('Invoice CSV export failed');
    expect(deps.error).toHaveBeenCalledWith(
      'Export-Service', 'Failed to export invoice CSV', { err: boom }, expect.anything(),
    );
  });

  it('returns an empty export rather than failing when the board has no items', async () => {
    const res = makeRes();
    const deps = makeDeps({ Item: { find: vi.fn(() => ({ lean: vi.fn().mockResolvedValue([]) })) } });

    await handleInvoiceCsvExport(makeReq(), res, deps);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0]).toMatchObject({
      items: [],
      total: 0,
      totalAmount: 0,
      totalGovSubsidy: 0,
      totalParticipantContribution: 0,
    });
  });
});
