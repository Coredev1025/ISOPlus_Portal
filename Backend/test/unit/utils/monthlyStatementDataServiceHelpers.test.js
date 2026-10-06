import { describe, it, expect } from 'vitest';
import { transformProcessedServiceItem } from '../../../src/utils/monthlyStatementDataServiceHelpers.js';
import { parseFlexibleNumber } from '../../../src/utils/parseFlexibleNumber.js';
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
const getValueMulti = (item, attrs) => getValueFromFlatData(item, attrs);

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

const formatStatus = (value) => {
  if (!value) return undefined;
  if (Array.isArray(value) && value.length > 0) {
    return value.map((v) => (typeof v === 'object' && v.name ? v.name : String(v))).filter(Boolean).join(', ');
  }
  if (typeof value === 'object' && value.name) return value.name;
  return String(value);
};

const stripEmoji = (str) =>
  (str || '').replace(/[\u{1F300}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();

const getServiceFromServicePlan = (servicePlanItem) => {
  if (!servicePlanItem) return null;

  const servicePlanIdValue = getValueFromFlatData(servicePlanItem, [
    ATTRIBUTE_NAMES.SERVICE_PLAN_ID,
    'Service Plan ID',
  ]);
  if (servicePlanIdValue) {
    const servicePlanIdStr = String(servicePlanIdValue).trim();
    if (servicePlanIdStr.includes('-')) {
      const parts = servicePlanIdStr.split('-');
      const fromId = parts.length >= 2 ? parts.slice(1).join('-').trim() : servicePlanIdStr;
      if (fromId) return fromId;
    } else if (servicePlanIdStr) {
      return servicePlanIdStr;
    }
  }

  const serviceAttr = getValueFromFlatData(servicePlanItem, ['Service']);
  if (serviceAttr) {
    if (typeof serviceAttr === 'object' && serviceAttr.name) return serviceAttr.name;
    return String(serviceAttr).trim();
  }
  return null;
};

const getFundingSourceName = (fsItem) => {
  if (!fsItem) return null;
  const name = getValueFromFlatData(fsItem, ['Funding Stream', 'Definition']);
  if (!name) return null;
  const raw = typeof name === 'object' && name.name ? String(name.name).trim() : String(name).trim();
  return stripEmoji(raw) || null;
};

const BASE_HELPERS = {
  getValue,
  getValueMulti,
  ATTR: ATTRIBUTE_NAMES,
  formatStatus,
  parseNumber: parseFlexibleNumber,
  getServiceFromServicePlan,
  getValueFromFlatData,
  extractRefId,
  getFundingSourceName,
  stripEmoji,
};

/** A synced ISO+ service item: flat `data` map plus the raw `values` array. */
const makeItem = (flatData, extra = {}) => ({
  _id: '65f0000000000000000000cc',
  itemId: extra.itemId ?? 'service-item-1',
  workspaceId: 'ws-1',
  boardId: 'board-1',
  folderId: 'folder-shift-planning',
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

const makeRefItem = (itemId, flatData) => ({
  itemId,
  workspaceId: 'ws-1',
  boardId: 'board-1',
  folderId: 'folder-refs',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-05T00:00:00.000Z'),
  data: {
    ...flatData,
    values: Object.entries(flatData).map(([name, data], index) => ({
      id: `rv-${index}`,
      attribute: { id: `ra-${index}`, name },
      data,
    })),
  },
});

/** Mirrors the record mapRawServiceItem produces and fetchServiceItems passes on. */
const makeProcessed = (item, overrides = {}) => ({
  item,
  scheduledStartDate: overrides.scheduledStartDate ?? null,
  actualEndDate: overrides.actualEndDate ?? null,
  scheduledStart: overrides.scheduledStart ?? null,
  actualEnd: overrides.actualEnd ?? null,
  filterDate: overrides.filterDate ?? null,
  participantName: overrides.participantName ?? '',
  profileValue: overrides.profileValue ?? null,
  statusFormatted: overrides.statusFormatted ?? '',
  servicePlanId: overrides.servicePlanId ?? null,
  fundingSourceIds: overrides.fundingSourceIds ?? [],
  fundingSourceResolvedBase: overrides.fundingSourceResolvedBase ?? '',
});

const transform = (p, refMap = new Map(), businessProfile = { name: 'Hills Grade Care Pty Ltd' }) =>
  transformProcessedServiceItem(p, refMap, businessProfile, {
    ...BASE_HELPERS,
    item: p.item,
    scheduledStart: p.scheduledStart,
    actualEnd: p.actualEnd,
    participantName: p.participantName,
  });

describe('transformProcessedServiceItem — identity and passthrough', () => {
  it('carries the item id, participant name and timestamps through', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 1 }, { itemId: 'svc-42' });
    const result = transform(makeProcessed(item, { participantName: 'Aroha Ngata' }));

    expect(result.id).toBe('svc-42');
    expect(result.participant).toBe('Aroha Ngata');
    expect(result.updatedAt).toEqual(new Date('2026-03-20T02:00:00.000Z'));
    expect(result.createdAt).toEqual(new Date('2026-03-01T02:00:00.000Z'));
  });

  it('mirrors the scheduled start and actual end into every alias field', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 1 });
    const result = transform(
      makeProcessed(item, {
        scheduledStart: '2026-03-31T22:00:00.000Z',
        actualEnd: '2026-04-01T01:00:00.000Z',
      }),
    );

    expect(result.scheduledStart).toBe('2026-03-31T22:00:00.000Z');
    expect(result.scheduledServiceDate).toBe('2026-03-31T22:00:00.000Z');
    expect(result.scheduledShiftStart).toBe('2026-03-31T22:00:00.000Z');
    expect(result.scheduledShiftStartDateTime).toBe('2026-03-31T22:00:00.000Z');
    expect(result.actualEnd).toBe('2026-04-01T01:00:00.000Z');
    expect(result.actualShiftEndDateTime).toBe('2026-04-01T01:00:00.000Z');
    expect(result.serviceDeliveryDate).toBe('2026-04-01T01:00:00.000Z');
  });

  it('formats the transaction status from the item, joining a multi-select', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: [
        { id: 's1', name: TRANSACTION_STATUS_USE_ACTUAL_END },
        { id: 's2', name: 'Invoiced' },
      ],
    });
    const result = transform(makeProcessed(item));
    expect(result.transactionStatus).toBe('Delivered - To be claimed and invoiced., Invoiced');
  });

  it('leaves the transaction status undefined when the attribute is absent', () => {
    const result = transform(makeProcessed(makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 1 })));
    expect(result.transactionStatus).toBeUndefined();
  });

  it('reads attributes out of the raw values[] array when the flat key is missing', () => {
    const item = {
      itemId: 'svc-values-only',
      workspaceId: 'ws-1',
      boardId: 'board-1',
      folderId: 'folder-shift-planning',
      createdAt: new Date('2026-03-01T02:00:00.000Z'),
      updatedAt: new Date('2026-03-20T02:00:00.000Z'),
      data: {
        values: [
          { id: 'v0', attribute: { id: 'a0', name: ATTRIBUTE_NAMES.QUANTITY }, data: '4' },
          { id: 'v1', attribute: { id: 'a1', name: ATTRIBUTE_NAMES.UNIT }, data: 'Each' },
        ],
      },
    };
    const result = transform(makeProcessed(item));
    expect(result.quantity).toBe(4);
    expect(result.unit).toBe('Each');
  });
});

describe('transformProcessedServiceItem — delivered-by split', () => {
  it('resolves company workforce deliveries to the business name', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.DELIVERED_BY]: 'Company Workforce' });
    const result = transform(makeProcessed(item));
    expect(result.deliveredBy).toBe('Company Workforce');
    expect(result.serviceProvider).toBe('Hills Grade Care Pty Ltd');
  });

  it('leaves the provider undefined for company workforce with no business profile', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.DELIVERED_BY]: 'Company Workforce' });
    expect(transform(makeProcessed(item), new Map(), null).serviceProvider).toBeUndefined();
    expect(transform(makeProcessed(item), new Map(), { name: '' }).serviceProvider).toBeUndefined();
  });

  it('resolves associated-provider deliveries via the Business/Individual attribute', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.DELIVERED_BY]: { id: 'db-2', name: 'Associated Providers' },
      [ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER]: [{ id: 'provider-5', name: 'ref' }],
    });
    const refMap = new Map([
      ['provider-5', makeRefItem('provider-5', { 'Business/Individual': 'Coastal Allied Health' })],
    ]);
    const result = transform(makeProcessed(item), refMap);
    expect(result.deliveredBy).toBe('Associated Providers');
    expect(result.serviceProvider).toBe('Coastal Allied Health');
  });

  it('falls back to the associated-provider reference id when the ref item or value is missing', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.DELIVERED_BY]: 'Associated Providers',
      [ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER]: [{ id: 'provider-6', name: 'ref' }],
    });
    expect(transform(makeProcessed(item)).serviceProvider).toBe('provider-6');

    const blank = new Map([['provider-6', makeRefItem('provider-6', { 'Business/Individual': '' })]]);
    expect(transform(makeProcessed(item), blank).serviceProvider).toBe('provider-6');
  });

  it('leaves the provider undefined for associated delivery with no provider reference', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.DELIVERED_BY]: 'Associated Providers' });
    expect(transform(makeProcessed(item)).serviceProvider).toBeUndefined();
  });

  it('leaves the provider undefined for a delivered-by value in neither bucket', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.DELIVERED_BY]: 'Third Party Contractor',
      [ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER]: [{ id: 'provider-5', name: 'ref' }],
    });
    const refMap = new Map([
      ['provider-5', makeRefItem('provider-5', { 'Business/Individual': 'Coastal Allied Health' })],
    ]);
    const result = transform(makeProcessed(item), refMap);
    expect(result.deliveredBy).toBe('Third Party Contractor');
    expect(result.serviceProvider).toBeUndefined();
  });

  it('returns a null delivered-by when the attribute is absent', () => {
    const result = transform(makeProcessed(makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 1 })));
    expect(result.deliveredBy).toBeNull();
    expect(result.serviceProvider).toBeUndefined();
  });

  // Characterizes a real defect: only a single {id,name} object is unwrapped, so an
  // array-valued "Delivered by" stringifies and matches neither bucket.
  it('degrades an array-valued Delivered by to "[object Object]"', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.DELIVERED_BY]: [{ id: 'db-2', name: 'Associated Providers' }],
      [ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER]: [{ id: 'provider-5', name: 'ref' }],
    });
    const result = transform(makeProcessed(item));
    expect(result.deliveredBy).toBe('[object Object]');
    expect(result.serviceProvider).toBeUndefined();
  });
});

describe('transformProcessedServiceItem — service plan, category and funding source', () => {
  it('derives the service from the part of the Service Plan ID after the first dash', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 1 });
    const refMap = new Map([
      ['plan-1', makeRefItem('plan-1', { 'Service Plan ID': 'SP001- Domestic Assistance' })],
    ]);
    const result = transform(makeProcessed(item, { servicePlanId: 'plan-1' }), refMap);
    expect(result.service).toBe('Domestic Assistance');
  });

  it('falls back to the plan Service attribute when there is no Service Plan ID', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 1 });
    const refMap = new Map([['plan-2', makeRefItem('plan-2', { Service: '  Personal Care  ' })]]);
    const result = transform(makeProcessed(item, { servicePlanId: 'plan-2' }), refMap);
    expect(result.service).toBe('Personal Care');
  });

  it('returns an empty service string when the plan is missing from the ref map', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 1 });
    expect(transform(makeProcessed(item, { servicePlanId: 'plan-missing' })).service).toBe('');
    expect(transform(makeProcessed(item)).service).toBe('');
  });

  it('reads the service category off the service plan and trims it', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 1 });
    const refMap = new Map([
      ['plan-3', makeRefItem('plan-3', { 'Service Category': '  Home Support  ' })],
    ]);
    const result = transform(makeProcessed(item, { servicePlanId: 'plan-3' }), refMap);
    expect(result.serviceCategory).toBe('Home Support');
  });

  it('reads the name from an object-valued service category', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 1 });
    const refMap = new Map([
      ['plan-4', makeRefItem('plan-4', { 'Service Category': { id: 'sc-1', name: 'Nursing' } })],
    ]);
    const result = transform(makeProcessed(item, { servicePlanId: 'plan-4' }), refMap);
    expect(result.serviceCategory).toBe('Nursing');
  });

  it('returns an empty service category when there is no service plan', () => {
    const result = transform(makeProcessed(makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 1 })));
    expect(result.serviceCategory).toBe('');
  });

  it('joins funding source names and skips ids that do not resolve', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 1 });
    const refMap = new Map([
      ['fs-1', makeRefItem('fs-1', { 'Funding Stream': '🏠 Home Support Quarterly Budget' })],
      ['fs-2', makeRefItem('fs-2', { 'Funding Stream': 'Restorative Care Pathway Budget' })],
    ]);
    const result = transform(
      makeProcessed(item, { fundingSourceIds: ['fs-1', 'fs-missing', 'fs-2'] }),
      refMap,
    );
    expect(result.fundingSource).toBe('Home Support Quarterly Budget, Restorative Care Pathway Budget');
  });

  it('appends the emoji-stripped service category to a primary supplement funding source', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 1 });
    const refMap = new Map([
      ['plan-5', makeRefItem('plan-5', { 'Service Category': '🏠 Home Support' })],
      ['fs-3', makeRefItem('fs-3', { 'Funding Stream': 'Primary Supplement' })],
    ]);
    const result = transform(
      makeProcessed(item, { servicePlanId: 'plan-5', fundingSourceIds: ['fs-3'] }),
      refMap,
    );
    expect(result.fundingSource).toBe('Primary Supplement - Home Support');
  });

  it('appends the service category for unspent home care package sources too', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 1 });
    const refMap = new Map([
      ['plan-6', makeRefItem('plan-6', { 'Service Category': 'Nursing' })],
      ['fs-4', makeRefItem('fs-4', { 'Funding Stream': 'Unspent Home Care Package Funds' })],
    ]);
    const result = transform(
      makeProcessed(item, { servicePlanId: 'plan-6', fundingSourceIds: ['fs-4'] }),
      refMap,
    );
    expect(result.fundingSource).toBe('Unspent Home Care Package Funds - Nursing');
  });

  it('does not append the service category to an ordinary funding source', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 1 });
    const refMap = new Map([
      ['plan-7', makeRefItem('plan-7', { 'Service Category': 'Home Support' })],
      ['fs-5', makeRefItem('fs-5', { 'Funding Stream': 'Home Support Quarterly Budget' })],
    ]);
    const result = transform(
      makeProcessed(item, { servicePlanId: 'plan-7', fundingSourceIds: ['fs-5'] }),
      refMap,
    );
    expect(result.fundingSource).toBe('Home Support Quarterly Budget');
  });

  it('leaves the funding source undefined when there are no ids or none resolve', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 1 });
    expect(transform(makeProcessed(item)).fundingSource).toBeUndefined();
    expect(
      transform(makeProcessed(item, { fundingSourceIds: ['fs-nope'] })).fundingSource,
    ).toBeUndefined();
  });
});

describe('transformProcessedServiceItem — quantities and money', () => {
  it('parses currency-formatted strings through the flexible number parser', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.QUANTITY]: '2.5',
      [ATTRIBUTE_NAMES.UNIT_PRICE]: '$68.40',
      [ATTRIBUTE_NAMES.TOTAL_AMOUNT]: '$1,234.56',
      [ATTRIBUTE_NAMES.GOV_SUBSIDY]: '1,111.10',
      [ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION]: '123.46',
    });
    const result = transform(makeProcessed(item));
    expect(result.quantity).toBe(2.5);
    expect(result.unitPrice).toBe(68.4);
    expect(result.totalAmount).toBe(1234.56);
    expect(result.govSubsidy).toBe(1111.1);
    expect(result.participantContribution).toBe(123.46);
  });

  it('reads a parenthesised amount as negative', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.TOTAL_AMOUNT]: '($85.50)' });
    expect(transform(makeProcessed(item)).totalAmount).toBe(-85.5);
  });

  it('keeps a negative amount negative (a refund line)', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.TOTAL_AMOUNT]: -85.5,
      [ATTRIBUTE_NAMES.GOV_SUBSIDY]: '-76.95',
    });
    const result = transform(makeProcessed(item));
    expect(result.totalAmount).toBe(-85.5);
    expect(result.govSubsidy).toBe(-76.95);
  });

  it('zeroes every money field when the attributes are missing or unparseable', () => {
    const result = transform(makeProcessed(makeItem({ [ATTRIBUTE_NAMES.UNIT]: 'Each' })));
    expect(result.quantity).toBe(0);
    expect(result.unitPrice).toBe(0);
    expect(result.totalAmount).toBe(0);
    expect(result.govSubsidy).toBe(0);
    expect(result.participantContribution).toBe(0);

    const junk = transform(makeProcessed(makeItem({ [ATTRIBUTE_NAMES.TOTAL_AMOUNT]: 'n/a' })));
    expect(junk.totalAmount).toBe(0);
  });

  it('defaults the unit to Hour when absent or empty', () => {
    expect(transform(makeProcessed(makeItem({ Quantity: 1 }))).unit).toBe('Hour');
    expect(transform(makeProcessed(makeItem({ [ATTRIBUTE_NAMES.UNIT]: '' }))).unit).toBe('Hour');
    expect(transform(makeProcessed(makeItem({ [ATTRIBUTE_NAMES.UNIT]: 'Each' }))).unit).toBe('Each');
  });

  it('distinguishes an absent committed AT-HM value from a zero one', () => {
    expect(
      transform(makeProcessed(makeItem({ Quantity: 1 }))).committedAtHmForDelivery,
    ).toBeUndefined();
    expect(
      transform(makeProcessed(makeItem({ [ATTRIBUTE_NAMES.COMMITTED_AT_HM]: 0 }))).committedAtHmForDelivery,
    ).toBe(0);
    expect(
      transform(makeProcessed(makeItem({ [ATTRIBUTE_NAMES.COMMITTED_AT_HM]: 1250.75 })))
        .committedAtHmForDelivery,
    ).toBe(1250.75);
    // Number(), not the flexible parser, is used here: a formatted string zeroes out.
    expect(
      transform(makeProcessed(makeItem({ [ATTRIBUTE_NAMES.COMMITTED_AT_HM]: '$1,250.75' })))
        .committedAtHmForDelivery,
    ).toBe(0);
  });

  it('reads the allocated time under either capitalisation of the attribute', () => {
    expect(
      transform(makeProcessed(makeItem({ 'Allocated time (Hr.)': 1.75 }))).allocatedTime,
    ).toBe(1.75);
    expect(
      transform(makeProcessed(makeItem({ 'Allocated Time (Hr.)': '2.25' }))).allocatedTime,
    ).toBe(2.25);
  });

  it('distinguishes an absent allocated time from a zero one', () => {
    expect(transform(makeProcessed(makeItem({ Quantity: 1 }))).allocatedTime).toBeUndefined();
    expect(transform(makeProcessed(makeItem({ 'Allocated time (Hr.)': 0 }))).allocatedTime).toBe(0);
    expect(transform(makeProcessed(makeItem({ 'Allocated time (Hr.)': 'n/a' }))).allocatedTime).toBe(0);
  });

  it('defaults the notes to an empty string', () => {
    expect(transform(makeProcessed(makeItem({ Quantity: 1 }))).notes).toBe('');
    expect(
      transform(makeProcessed(makeItem({ [ATTRIBUTE_NAMES.ADDITIONAL_NOTES]: 'Client rescheduled' }))).notes,
    ).toBe('Client rescheduled');
  });
});
