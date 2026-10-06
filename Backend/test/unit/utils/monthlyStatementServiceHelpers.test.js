import { describe, it, expect } from 'vitest';
import {
  resolveServiceItemFilterDate,
  mapRawServiceItem,
  filterProcessedServiceItems,
} from '../../../src/utils/monthlyStatementServiceHelpers.js';
import {
  ATTRIBUTE_NAMES,
  TRANSACTION_STATUS_USE_ACTUAL_END,
} from '../../../src/constants/monthlyStatementAttributes.js';

// Collaborators copied verbatim from the production caller,
// src/services/monthlyStatementData.js.
const getValueFromFlatData = (item, attributeName) => {
  if (!item?.data) return null;

  const attributeNames = Array.isArray(attributeName) ? attributeName : [attributeName];
  for (const attrName of attributeNames) {
    if (item.data[attrName] !== undefined && item.data[attrName] !== null) {
      return item.data[attrName];
    }
  }

  if (Array.isArray(item.data.values)) {
    for (const attrName of attributeNames) {
      const entry = item.data.values.find((v) => v?.attribute?.name === attrName);
      if (entry?.data !== undefined && entry?.data !== null) {
        return entry.data;
      }
    }
  }

  return null;
};

const getValue = (item, attr) => getValueFromFlatData(item, attr);

const parseDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
};

const extractRefId = (value) => {
  if (!value) return null;
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    if (typeof first === 'object' && first.id) return first.id.toString();
    return first?.toString() ?? null;
  }
  if (typeof value === 'object' && value.id) return value.id.toString();
  return value?.toString() ?? null;
};

const extractAllRefIds = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'object' && v.id ? v.id.toString() : v?.toString()))
      .filter(Boolean);
  }
  if (typeof value === 'object' && value.id) return [value.id.toString()];
  return value ? [value.toString()] : [];
};

const formatStatus = (value) => {
  if (!value) return undefined;
  if (Array.isArray(value) && value.length > 0) {
    return value.map((v) => (typeof v === 'object' && v.name ? v.name : String(v))).filter(Boolean).join(', ');
  }
  if (typeof value === 'object' && value.name) return value.name;
  return String(value);
};

const normalizeString = (v) => (v || '').toString().trim().toLowerCase().replace(/\.+$/, '');

const stripEmoji = (str) =>
  (str || '').replace(/[\u{1F300}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();

const getParticipantName = (profileItem) => {
  if (!profileItem) return null;
  const name = getValueFromFlatData(profileItem, [
    'Full Name/Preferred Name',
    'Preferred Name',
    'First Name',
    'Last Name',
    'Full Name',
    'Name',
  ]);
  if (!name) return null;
  if (typeof name === 'object' && name.name) return name.name;
  return String(name);
};

const getFundingSourceName = (fsItem) => {
  if (!fsItem) return null;
  const name = getValueFromFlatData(fsItem, ['Funding Stream', 'Definition']);
  if (!name) return null;
  const raw = typeof name === 'object' && name.name ? String(name.name).trim() : String(name).trim();
  return stripEmoji(raw) || null;
};

const HELPERS = {
  getValue,
  ATTR: ATTRIBUTE_NAMES,
  formatStatus,
  normalizeString,
  DELIVERED_STATUS: TRANSACTION_STATUS_USE_ACTUAL_END,
  parseDate,
  extractRefId,
  extractAllRefIds,
  getParticipantName,
  getFundingSourceName,
};

/** A synced ISO+ board item: flat `data` map plus the raw `values` array. */
const makeItem = (flatData, extra = {}) => ({
  _id: extra._id ?? '65f0000000000000000000aa',
  itemId: extra.itemId ?? 'item-1',
  workspaceId: 'ws-1',
  boardId: 'board-1',
  folderId: extra.folderId ?? 'folder-shift',
  createdAt: extra.createdAt ?? new Date('2026-03-01T02:00:00.000Z'),
  updatedAt: extra.updatedAt ?? new Date('2026-03-20T02:00:00.000Z'),
  data: {
    ...flatData,
    values: Object.entries(flatData).map(([name, data], index) => ({
      id: `value-${index}`,
      attribute: { id: `attr-${index}`, name },
      data,
    })),
  },
});

const makeProfile = (itemId, fullName) => ({
  itemId,
  workspaceId: 'ws-1',
  boardId: 'board-1',
  folderId: 'folder-profiles',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-05T00:00:00.000Z'),
  data: {
    'Full Name/Preferred Name': fullName,
    values: [
      { id: 'pv0', attribute: { id: 'pa0', name: 'Full Name/Preferred Name' }, data: fullName },
    ],
  },
});

const makeFundingSource = (itemId, stream) => ({
  itemId,
  workspaceId: 'ws-1',
  boardId: 'board-1',
  folderId: 'folder-funding',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-05T00:00:00.000Z'),
  data: {
    'Funding Stream': stream,
    values: [{ id: 'fv0', attribute: { id: 'fa0', name: 'Funding Stream' }, data: stream }],
  },
});

describe('resolveServiceItemFilterDate', () => {
  const scheduledStartDate = new Date('2026-03-10T09:00:00.000Z');
  const actualEndDate = new Date('2026-04-02T17:30:00.000Z');

  it('uses the actual end date when the delivered status opts into it', () => {
    expect(
      resolveServiceItemFilterDate({
        useActualEnd: true,
        statusNorm: 'delivered - to be claimed and invoiced',
        scheduledStartDate,
        actualEndDate,
        item: {},
      }),
    ).toBe(actualEndDate);
  });

  it('returns the actual end date even when it is null, once useActualEnd is set', () => {
    expect(
      resolveServiceItemFilterDate({
        useActualEnd: true,
        statusNorm: 'delivered - to be claimed and invoiced',
        scheduledStartDate,
        actualEndDate: null,
        item: { updatedAt: '2026-03-15T00:00:00.000Z' },
      }),
    ).toBeNull();
  });

  it('uses the scheduled start date for an ordinary status', () => {
    expect(
      resolveServiceItemFilterDate({
        useActualEnd: false,
        statusNorm: 'scheduled',
        scheduledStartDate,
        actualEndDate,
        item: {},
      }),
    ).toBe(scheduledStartDate);
  });

  it('returns null for an ordinary status with no scheduled start, ignoring the actual end', () => {
    expect(
      resolveServiceItemFilterDate({
        useActualEnd: false,
        statusNorm: 'scheduled',
        scheduledStartDate: null,
        actualEndDate,
        item: { updatedAt: '2026-03-15T00:00:00.000Z' },
      }),
    ).toBeNull();
  });

  it.each([
    ['adjustment - previous month', 'adjust'],
    ['refund issued', 'refund'],
    ['charge back', 'charge'],
  ])('treats %s as adjustment-like via the %s keyword', (statusNorm) => {
    expect(
      resolveServiceItemFilterDate({
        useActualEnd: false,
        statusNorm,
        scheduledStartDate: null,
        actualEndDate,
        item: {},
      }),
    ).toBe(actualEndDate);
  });

  it('prefers the scheduled start over the actual end for adjustment-like statuses', () => {
    expect(
      resolveServiceItemFilterDate({
        useActualEnd: false,
        statusNorm: 'adjustment',
        scheduledStartDate,
        actualEndDate,
        item: {},
      }),
    ).toBe(scheduledStartDate);
  });

  it('falls back to updatedAt for an adjustment with no scheduled start or actual end', () => {
    const result = resolveServiceItemFilterDate({
      useActualEnd: false,
      statusNorm: 'adjustment',
      scheduledStartDate: null,
      actualEndDate: null,
      item: { updatedAt: '2026-03-18T04:05:06.000Z', createdAt: '2026-02-01T00:00:00.000Z' },
    });
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe('2026-03-18T04:05:06.000Z');
  });

  it('falls back to createdAt when updatedAt is absent', () => {
    const result = resolveServiceItemFilterDate({
      useActualEnd: false,
      statusNorm: 'refund',
      scheduledStartDate: null,
      actualEndDate: null,
      item: { createdAt: '2026-02-01T07:00:00.000Z' },
    });
    expect(result.toISOString()).toBe('2026-02-01T07:00:00.000Z');
  });

  it('returns null for an adjustment with no dates whatsoever', () => {
    expect(
      resolveServiceItemFilterDate({
        useActualEnd: false,
        statusNorm: 'adjustment',
        scheduledStartDate: null,
        actualEndDate: null,
        item: {},
      }),
    ).toBeNull();
  });
});

describe('mapRawServiceItem', () => {
  it('filters on the actual shift end for the delivered status', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.SCHEDULED_START]: '2026-03-31T22:00:00.000Z',
      [ATTRIBUTE_NAMES.ACTUAL_END]: '2026-04-01T01:00:00.000Z',
      [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: [{ id: 'st-1', name: TRANSACTION_STATUS_USE_ACTUAL_END }],
      [ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME]: 'Mary Chen',
    });

    const mapped = mapRawServiceItem(item, new Map(), new Map(), HELPERS);

    expect(mapped.filterDate.toISOString()).toBe('2026-04-01T01:00:00.000Z');
    expect(mapped.filterDate).toBe(mapped.actualEndDate);
    expect(mapped.statusFormatted).toBe(TRANSACTION_STATUS_USE_ACTUAL_END);
  });

  it('matches the delivered status ignoring case and a trailing full stop', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.SCHEDULED_START]: '2026-03-31T22:00:00.000Z',
      [ATTRIBUTE_NAMES.ACTUAL_END]: '2026-04-01T01:00:00.000Z',
      [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: 'delivered - to be claimed and invoiced',
    });

    const mapped = mapRawServiceItem(item, new Map(), new Map(), HELPERS);
    expect(mapped.filterDate.toISOString()).toBe('2026-04-01T01:00:00.000Z');
  });

  it('filters on the scheduled shift start for every other status', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.SCHEDULED_START]: '2026-03-31T22:00:00.000Z',
      [ATTRIBUTE_NAMES.ACTUAL_END]: '2026-04-01T01:00:00.000Z',
      [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: 'Scheduled',
    });

    const mapped = mapRawServiceItem(item, new Map(), new Map(), HELPERS);
    expect(mapped.filterDate.toISOString()).toBe('2026-03-31T22:00:00.000Z');
    expect(mapped.filterDate).toBe(mapped.scheduledStartDate);
  });

  it('resolves the participant name from the profile map, overriding the item text', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]: [{ id: 'profile-9', name: 'ignored label' }],
      [ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME]: 'Stale Name',
      [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: 'Scheduled',
    });
    const profileMap = new Map([['profile-9', makeProfile('profile-9', 'Aroha Ngata')]]);

    const mapped = mapRawServiceItem(item, profileMap, new Map(), HELPERS);
    expect(mapped.participantName).toBe('Aroha Ngata');
    expect(mapped.profileValue).toEqual([{ id: 'profile-9', name: 'ignored label' }]);
  });

  it('falls back to the item full-name attribute when the profile is not in the map', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]: [{ id: 'profile-missing' }],
      [ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME]: 'Fallback Name',
      [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: 'Scheduled',
    });

    const mapped = mapRawServiceItem(item, new Map(), new Map(), HELPERS);
    expect(mapped.participantName).toBe('Fallback Name');
  });

  it('returns an empty participant name when neither source resolves', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: 'Scheduled' });
    const mapped = mapRawServiceItem(item, new Map(), new Map(), HELPERS);
    expect(mapped.participantName).toBe('');
    expect(mapped.profileValue).toBeNull();
  });

  it('joins every resolvable funding source name and drops the unresolvable ones', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.FUNDING_SOURCE]: [
        { id: 'fs-1', name: 'ref' },
        { id: 'fs-missing', name: 'ref' },
        { id: 'fs-2', name: 'ref' },
      ],
      [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: 'Scheduled',
    });
    const fundingSourceMap = new Map([
      ['fs-1', makeFundingSource('fs-1', '🏠 Home Support Quarterly Budget')],
      ['fs-2', makeFundingSource('fs-2', 'Restorative Care Pathway Budget')],
    ]);

    const mapped = mapRawServiceItem(item, new Map(), fundingSourceMap, HELPERS);
    expect(mapped.fundingSourceIds).toEqual(['fs-1', 'fs-missing', 'fs-2']);
    expect(mapped.fundingSourceResolvedBase).toBe(
      'Home Support Quarterly Budget, Restorative Care Pathway Budget',
    );
  });

  it('returns an empty funding-source label when the item has none', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: 'Scheduled' });
    const mapped = mapRawServiceItem(item, new Map(), new Map(), HELPERS);
    expect(mapped.fundingSourceIds).toEqual([]);
    expect(mapped.fundingSourceResolvedBase).toBe('');
  });

  it('extracts the service plan reference id and keeps the raw item', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.SERVICE_PLAN]: [{ id: 'plan-77', name: 'SP-77' }],
      [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: 'Scheduled',
    });
    const mapped = mapRawServiceItem(item, new Map(), new Map(), HELPERS);
    expect(mapped.servicePlanId).toBe('plan-77');
    expect(mapped.item).toBe(item);
  });

  it('normalises a missing transaction status to an empty string', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.SCHEDULED_START]: '2026-03-05T00:00:00.000Z' });
    const mapped = mapRawServiceItem(item, new Map(), new Map(), HELPERS);
    expect(mapped.statusFormatted).toBe('');
    expect(mapped.filterDate.toISOString()).toBe('2026-03-05T00:00:00.000Z');
  });

  it('keeps the raw scheduled/actual strings alongside the parsed dates', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.SCHEDULED_START]: '2026-03-05T08:00:00.000Z',
      [ATTRIBUTE_NAMES.ACTUAL_END]: 'not a date',
      [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: 'Scheduled',
    });
    const mapped = mapRawServiceItem(item, new Map(), new Map(), HELPERS);
    expect(mapped.scheduledStart).toBe('2026-03-05T08:00:00.000Z');
    expect(mapped.actualEnd).toBe('not a date');
    expect(mapped.actualEndDate).toBeNull();
    expect(mapped.scheduledStartDate.toISOString()).toBe('2026-03-05T08:00:00.000Z');
  });

  it('stringifies a non-string participant name coming from the board', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME]: 12345,
      [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: 'Scheduled',
    });
    const mapped = mapRawServiceItem(item, new Map(), new Map(), HELPERS);
    expect(mapped.participantName).toBe('12345');
  });
});

describe('filterProcessedServiceItems', () => {
  const makeProcessed = (overrides) => ({
    item: makeItem({}, { itemId: overrides.id ?? 'item-x' }),
    scheduledStartDate: overrides.filterDate ?? null,
    actualEndDate: null,
    scheduledStart: null,
    actualEnd: null,
    filterDate: overrides.filterDate ?? null,
    participantName: overrides.participantName ?? '',
    profileValue: overrides.profileValue ?? null,
    statusFormatted: overrides.statusFormatted ?? '',
    servicePlanId: null,
    fundingSourceIds: overrides.fundingSourceIds ?? [],
    fundingSourceResolvedBase: overrides.fundingSourceResolvedBase ?? '',
  });

  it('returns the input untouched when no filters are supplied', () => {
    const processed = [makeProcessed({ participantName: 'A' }), makeProcessed({ participantName: 'B' })];
    expect(filterProcessedServiceItems(processed, {})).toBe(processed);
  });

  it('skips participant filtering for the literal "all"', () => {
    const processed = [makeProcessed({ participantName: 'Aroha' }), makeProcessed({ participantName: 'Bo' })];
    expect(filterProcessedServiceItems(processed, { participantParam: 'all' })).toHaveLength(2);
  });

  it('matches the participant name case-insensitively as a substring', () => {
    const processed = [
      makeProcessed({ participantName: 'Aroha Ngata' }),
      makeProcessed({ participantName: 'Bo Tran' }),
    ];
    const result = filterProcessedServiceItems(processed, { participantParam: 'aroha' });
    expect(result.map((p) => p.participantName)).toEqual(['Aroha Ngata']);
  });

  it('escapes regex metacharacters in the participant parameter', () => {
    const processed = [
      makeProcessed({ participantName: 'A.Smith' }),
      makeProcessed({ participantName: 'AXSmith' }),
    ];
    const result = filterProcessedServiceItems(processed, { participantParam: 'A.Smith' });
    expect(result.map((p) => p.participantName)).toEqual(['A.Smith']);
  });

  it('matches a profile reference held as a plain string id', () => {
    const processed = [
      makeProcessed({ participantName: '', profileValue: 'profile-abc' }),
      makeProcessed({ participantName: '', profileValue: 'profile-zzz' }),
    ];
    const result = filterProcessedServiceItems(processed, { participantParam: 'profile-abc' });
    expect(result).toHaveLength(1);
    expect(result[0].profileValue).toBe('profile-abc');
  });

  it('matches a profile reference held as an array', () => {
    const processed = [
      makeProcessed({ profileValue: ['profile-abc', 'profile-def'] }),
      makeProcessed({ profileValue: ['profile-zzz'] }),
    ];
    const result = filterProcessedServiceItems(processed, { participantParam: 'profile-def' });
    expect(result).toHaveLength(1);
    expect(result[0].profileValue).toEqual(['profile-abc', 'profile-def']);
  });

  it('matches a profile reference held as an object with an id', () => {
    const processed = [
      makeProcessed({ profileValue: { id: 'profile-abc', name: 'Aroha' } }),
      makeProcessed({ profileValue: { id: 'profile-zzz', name: 'Bo' } }),
    ];
    const result = filterProcessedServiceItems(processed, { participantParam: 'profile-abc' });
    expect(result).toHaveLength(1);
    expect(result[0].profileValue.id).toBe('profile-abc');
  });

  it('drops items whose name and profile both fail to match', () => {
    const processed = [makeProcessed({ participantName: 'Bo Tran', profileValue: { id: 'profile-zzz' } })];
    expect(filterProcessedServiceItems(processed, { participantParam: 'Aroha' })).toEqual([]);
  });

  it('includes an item whose filterDate sits exactly on the start boundary', () => {
    const processed = [
      makeProcessed({ id: 'on', filterDate: new Date('2026-03-01T00:00:00.000Z') }),
      makeProcessed({ id: 'before', filterDate: new Date('2026-02-28T23:59:59.999Z') }),
    ];
    const result = filterProcessedServiceItems(processed, { startDate: '2026-03-01T00:00:00.000Z' });
    expect(result.map((p) => p.filterDate.toISOString())).toEqual(['2026-03-01T00:00:00.000Z']);
  });

  it('includes an item whose filterDate sits exactly on the end boundary', () => {
    const processed = [
      makeProcessed({ id: 'on', filterDate: new Date('2026-03-31T23:59:59.999Z') }),
      makeProcessed({ id: 'after', filterDate: new Date('2026-04-01T00:00:00.000Z') }),
    ];
    const result = filterProcessedServiceItems(processed, { endDate: '2026-03-31T23:59:59.999Z' });
    expect(result.map((p) => p.filterDate.toISOString())).toEqual(['2026-03-31T23:59:59.999Z']);
  });

  it('applies both bounds together to keep only in-month items', () => {
    const processed = [
      makeProcessed({ id: 'feb', filterDate: new Date('2026-02-15T00:00:00.000Z') }),
      makeProcessed({ id: 'mar', filterDate: new Date('2026-03-15T00:00:00.000Z') }),
      makeProcessed({ id: 'apr', filterDate: new Date('2026-04-15T00:00:00.000Z') }),
    ];
    const result = filterProcessedServiceItems(processed, {
      startDate: '2026-03-01T00:00:00.000Z',
      endDate: '2026-03-31T23:59:59.999Z',
    });
    expect(result.map((p) => p.filterDate.toISOString())).toEqual(['2026-03-15T00:00:00.000Z']);
  });

  it('drops items with no filterDate once a date bound is applied', () => {
    const processed = [
      makeProcessed({ id: 'none', filterDate: null }),
      makeProcessed({ id: 'mar', filterDate: new Date('2026-03-15T00:00:00.000Z') }),
    ];
    expect(filterProcessedServiceItems(processed, { startDate: '2026-03-01T00:00:00.000Z' })).toHaveLength(1);
    expect(filterProcessedServiceItems(processed, { endDate: '2026-03-31T00:00:00.000Z' })).toHaveLength(1);
  });

  it('keeps items with no filterDate when no date bound is applied', () => {
    const processed = [makeProcessed({ id: 'none', filterDate: null })];
    expect(filterProcessedServiceItems(processed, { participantParam: 'all' })).toHaveLength(1);
  });

  it('filters on an exact transaction status and skips the "all" sentinel in any case', () => {
    const processed = [
      makeProcessed({ statusFormatted: TRANSACTION_STATUS_USE_ACTUAL_END }),
      makeProcessed({ statusFormatted: 'Scheduled' }),
    ];
    expect(
      filterProcessedServiceItems(processed, { transactionStatusFilter: 'Scheduled' }),
    ).toHaveLength(1);
    expect(filterProcessedServiceItems(processed, { transactionStatusFilter: 'ALL' })).toHaveLength(2);
    expect(filterProcessedServiceItems(processed, { transactionStatusFilter: 'all' })).toHaveLength(2);
  });

  it('trims the transaction status filter but still requires an exact match', () => {
    const processed = [makeProcessed({ statusFormatted: 'Scheduled' })];
    expect(filterProcessedServiceItems(processed, { transactionStatusFilter: '  Scheduled  ' })).toHaveLength(1);
    expect(filterProcessedServiceItems(processed, { transactionStatusFilter: 'Sched' })).toHaveLength(0);
  });

  it('filters on the exact resolved funding source label and skips "all"', () => {
    const processed = [
      makeProcessed({ fundingSourceResolvedBase: 'Home Support Quarterly Budget' }),
      makeProcessed({ fundingSourceResolvedBase: 'Restorative Care Pathway Budget' }),
      makeProcessed({ fundingSourceResolvedBase: '' }),
    ];
    expect(
      filterProcessedServiceItems(processed, { fundingSourceFilter: ' Home Support Quarterly Budget ' }),
    ).toHaveLength(1);
    expect(filterProcessedServiceItems(processed, { fundingSourceFilter: 'all' })).toHaveLength(3);
  });

  it('drops items with an empty funding-source label when a funding source is requested', () => {
    const processed = [makeProcessed({ fundingSourceResolvedBase: '' })];
    expect(
      filterProcessedServiceItems(processed, { fundingSourceFilter: 'Home Support Quarterly Budget' }),
    ).toEqual([]);
  });

  it('applies participant, date, status and funding-source filters together', () => {
    const processed = [
      makeProcessed({
        id: 'keep',
        participantName: 'Aroha Ngata',
        filterDate: new Date('2026-03-15T00:00:00.000Z'),
        statusFormatted: 'Scheduled',
        fundingSourceResolvedBase: 'Home Support Quarterly Budget',
      }),
      makeProcessed({
        id: 'wrong-status',
        participantName: 'Aroha Ngata',
        filterDate: new Date('2026-03-16T00:00:00.000Z'),
        statusFormatted: TRANSACTION_STATUS_USE_ACTUAL_END,
        fundingSourceResolvedBase: 'Home Support Quarterly Budget',
      }),
      makeProcessed({
        id: 'wrong-month',
        participantName: 'Aroha Ngata',
        filterDate: new Date('2026-04-16T00:00:00.000Z'),
        statusFormatted: 'Scheduled',
        fundingSourceResolvedBase: 'Home Support Quarterly Budget',
      }),
    ];

    const result = filterProcessedServiceItems(processed, {
      participantParam: 'Aroha',
      startDate: '2026-03-01T00:00:00.000Z',
      endDate: '2026-03-31T23:59:59.999Z',
      transactionStatusFilter: 'Scheduled',
      fundingSourceFilter: 'Home Support Quarterly Budget',
    });

    expect(result).toHaveLength(1);
    expect(result[0].item.itemId).toBe('keep');
  });

  it('does not mutate the array it is given', () => {
    const processed = [
      makeProcessed({ participantName: 'Aroha Ngata' }),
      makeProcessed({ participantName: 'Bo Tran' }),
    ];
    filterProcessedServiceItems(processed, { participantParam: 'Aroha' });
    expect(processed).toHaveLength(2);
  });
});
