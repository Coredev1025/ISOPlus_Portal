import { describe, it, expect, beforeEach } from 'vitest';
import {
  formatMonthlyStatementStatus,
  transformMonthlyStatementServiceItem,
} from '../../../src/utils/monthlyStatementServiceTransformHelpers.js';
import { clearCache } from '../../../src/utils/transformCache.js';
import {
  ATTRIBUTE_NAMES,
  REF_ATTRIBUTE_NAMES,
  TRANSACTION_STATUS_USE_ACTUAL_END,
} from '../../../src/constants/monthlyStatementAttributes.js';

// Collaborators copied verbatim from the production caller chain
// (src/routes/items.js, which supplies `deps` to monthlyStatementRouteHelpers).
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
    return value
      .map((v) => {
        if (typeof v === 'object' && v.id) return v.id.toString();
        if (typeof v === 'string') return v;
        return v?.toString();
      })
      .filter(Boolean);
  }
  if (typeof value === 'object' && value.id) return [value.id.toString()];
  if (typeof value === 'string') return [value];
  return value ? [value.toString()] : [];
};

const getParticipantNameFromProfile = (profileItem) => {
  if (!profileItem) return null;
  const name = getValueFromFlatData(profileItem, [
    REF_ATTRIBUTE_NAMES.PROFILE_FULL_NAME,
    REF_ATTRIBUTE_NAMES.PROFILE_PREFERRED_NAME,
    REF_ATTRIBUTE_NAMES.PROFILE_FIRST_NAME,
    REF_ATTRIBUTE_NAMES.PROFILE_LAST_NAME,
  ]);
  if (!name) return null;
  if (typeof name === 'object' && name.name) return name.name;
  return String(name);
};

const getServiceFromServicePlan = (servicePlanItem) => {
  if (!servicePlanItem) return null;
  const servicePlanIdValue = getValueFromFlatData(servicePlanItem, REF_ATTRIBUTE_NAMES.SERVICE_PLAN_ID);
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
  const serviceAttr = getValueFromFlatData(servicePlanItem, [REF_ATTRIBUTE_NAMES.SERVICE, 'Service']);
  if (serviceAttr) {
    if (typeof serviceAttr === 'object' && serviceAttr.name) return serviceAttr.name;
    return String(serviceAttr).trim();
  }
  return null;
};

const stripEmojiFromFundingSource = (str) =>
  (str || '').replace(/[\u{1F300}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();

const getFundingSourceNameFromItem = (fsItem) => {
  if (!fsItem) return null;
  const name = getValueFromFlatData(fsItem, [
    REF_ATTRIBUTE_NAMES.FS_NAME,
    REF_ATTRIBUTE_NAMES.FS_DEFINITION,
  ]);
  if (!name) return null;
  const raw = typeof name === 'object' && name.name ? name.name : String(name).trim();
  return stripEmojiFromFundingSource(raw) || null;
};

const DEPS = {
  extractRefId,
  extractAllRefIds,
  getParticipantNameFromProfile,
  getServiceFromServicePlan,
  getValueFromFlatData,
  getFundingSourceNameFromItem,
  stripEmojiFromFundingSource,
};

let itemCounter = 0;
/** A synced ISO+ service item: flat `data` map plus the raw `values` array. */
const makeItem = (flatData, extra = {}) => ({
  _id: '65f0000000000000000000bb',
  itemId: extra.itemId ?? `service-item-${++itemCounter}`,
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

const makeContext = (overrides = {}) => ({
  workspaceId: 'ws-1',
  boardId: 'board-1',
  msRefItemsMap: overrides.msRefItemsMap ?? new Map(),
  businessProfile: 'businessProfile' in overrides ? overrides.businessProfile : { name: 'Hills Grade Care Pty Ltd' },
  ATTRIBUTE_NAMES,
  deps: DEPS,
});

beforeEach(() => {
  clearCache();
});

describe('formatMonthlyStatementStatus', () => {
  it('returns undefined for every falsy value', () => {
    expect(formatMonthlyStatementStatus(null)).toBeUndefined();
    expect(formatMonthlyStatementStatus(undefined)).toBeUndefined();
    expect(formatMonthlyStatementStatus('')).toBeUndefined();
    expect(formatMonthlyStatementStatus(0)).toBeUndefined();
    expect(formatMonthlyStatementStatus(false)).toBeUndefined();
  });

  it('joins the names of an array of status options', () => {
    expect(
      formatMonthlyStatementStatus([
        { id: 'o1', name: TRANSACTION_STATUS_USE_ACTUAL_END },
        { id: 'o2', name: 'Invoiced' },
      ]),
    ).toBe('Delivered - To be claimed and invoiced., Invoiced');
  });

  it('joins an array of plain strings and drops empty entries', () => {
    expect(formatMonthlyStatementStatus(['Scheduled', '', 'Invoiced'])).toBe('Scheduled, Invoiced');
  });

  it('stringifies array entries that carry no name', () => {
    expect(formatMonthlyStatementStatus([{ id: 'o1' }])).toBe('[object Object]');
  });

  it('returns an empty string for an empty array rather than undefined', () => {
    expect(formatMonthlyStatementStatus([])).toBe('');
  });

  it('returns the name of a single status object', () => {
    expect(formatMonthlyStatementStatus({ id: 'o1', name: 'Scheduled' })).toBe('Scheduled');
  });

  it('returns a string status unchanged', () => {
    expect(formatMonthlyStatementStatus('Scheduled')).toBe('Scheduled');
  });

  it('stringifies any other truthy value', () => {
    expect(formatMonthlyStatementStatus(42)).toBe('42');
    expect(formatMonthlyStatementStatus(true)).toBe('true');
  });
});

describe('transformMonthlyStatementServiceItem — delivered-by split', () => {
  it('resolves company workforce deliveries to the business name', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.DELIVERED_BY]: 'Company Workforce' });
    const result = transformMonthlyStatementServiceItem(item, makeContext());
    expect(result.deliveredBy).toBe('Company Workforce');
    expect(result.serviceProvider).toBe('Hills Grade Care Pty Ltd');
  });

  it('matches company workforce case-insensitively and as a substring', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.DELIVERED_BY]: 'Delivered by company workforce' });
    const result = transformMonthlyStatementServiceItem(item, makeContext());
    expect(result.serviceProvider).toBe('Hills Grade Care Pty Ltd');
  });

  it('leaves the provider undefined for company workforce when there is no business profile', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.DELIVERED_BY]: 'Company Workforce' });
    const result = transformMonthlyStatementServiceItem(item, makeContext({ businessProfile: null }));
    expect(result.deliveredBy).toBe('Company Workforce');
    expect(result.serviceProvider).toBeUndefined();
  });

  it('resolves associated-provider deliveries via the Business/Individual attribute', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.DELIVERED_BY]: { id: 'db-2', name: 'Associated Providers' },
      [ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER]: [{ id: 'provider-5', name: 'ref' }],
    });
    const msRefItemsMap = new Map([
      ['provider-5', makeRefItem('provider-5', { 'Business/Individual': 'Coastal Allied Health' })],
    ]);
    const result = transformMonthlyStatementServiceItem(item, makeContext({ msRefItemsMap }));
    expect(result.deliveredBy).toBe('Associated Providers');
    expect(result.serviceProvider).toBe('Coastal Allied Health');
  });

  // Characterizes a real defect: only a single {id,name} object is unwrapped. An
  // array-valued "Delivered by" — the shape every other reference attribute uses —
  // stringifies to '[object Object]' and so matches neither delivered-by bucket.
  it('degrades an array-valued Delivered by to "[object Object]" and loses the provider', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.DELIVERED_BY]: [{ id: 'db-2', name: 'Associated Providers' }],
      [ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER]: [{ id: 'provider-5', name: 'ref' }],
    });
    const msRefItemsMap = new Map([
      ['provider-5', makeRefItem('provider-5', { 'Business/Individual': 'Coastal Allied Health' })],
    ]);
    const result = transformMonthlyStatementServiceItem(item, makeContext({ msRefItemsMap }));
    expect(result.deliveredBy).toBe('[object Object]');
    expect(result.serviceProvider).toBeUndefined();
  });

  it('falls back to the associated-provider reference id when the ref item is missing', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.DELIVERED_BY]: 'Associated Providers',
      [ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER]: [{ id: 'provider-missing', name: 'ref' }],
    });
    const result = transformMonthlyStatementServiceItem(item, makeContext());
    expect(result.serviceProvider).toBe('provider-missing');
  });

  it('falls back to the reference id when Business/Individual is an empty string', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.DELIVERED_BY]: 'Associated Providers',
      [ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER]: [{ id: 'provider-6', name: 'ref' }],
    });
    const msRefItemsMap = new Map([
      ['provider-6', makeRefItem('provider-6', { 'Business/Individual': '' })],
    ]);
    const result = transformMonthlyStatementServiceItem(item, makeContext({ msRefItemsMap }));
    expect(result.serviceProvider).toBe('provider-6');
  });

  it('reads the name out of an object-valued Business/Individual', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.DELIVERED_BY]: 'Associated Providers',
      [ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER]: [{ id: 'provider-7', name: 'ref' }],
    });
    const msRefItemsMap = new Map([
      ['provider-7', makeRefItem('provider-7', { 'Business/Individual': { id: 'bi-1', name: 'Business' } })],
    ]);
    const result = transformMonthlyStatementServiceItem(item, makeContext({ msRefItemsMap }));
    expect(result.serviceProvider).toBe('Business');
  });

  it('leaves the provider undefined for associated delivery with no provider reference', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.DELIVERED_BY]: 'Associated Providers' });
    const result = transformMonthlyStatementServiceItem(item, makeContext());
    expect(result.serviceProvider).toBeUndefined();
  });

  it('leaves the provider undefined for a delivered-by value in neither bucket', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.DELIVERED_BY]: 'Third Party Contractor',
      [ATTRIBUTE_NAMES.ASSOCIATED_PROVIDER]: [{ id: 'provider-5', name: 'ref' }],
    });
    const msRefItemsMap = new Map([
      ['provider-5', makeRefItem('provider-5', { 'Business/Individual': 'Coastal Allied Health' })],
    ]);
    const result = transformMonthlyStatementServiceItem(item, makeContext({ msRefItemsMap }));
    expect(result.deliveredBy).toBe('Third Party Contractor');
    expect(result.serviceProvider).toBeUndefined();
  });

  it('returns a null delivered-by when the attribute is absent', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 1 });
    const result = transformMonthlyStatementServiceItem(item, makeContext());
    expect(result.deliveredBy).toBeNull();
    expect(result.serviceProvider).toBeUndefined();
  });
});

describe('transformMonthlyStatementServiceItem — participant, service and funding source', () => {
  it('prefers the participant profile name over the item full-name attribute', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME]: 'Stale Name',
      [ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]: [{ id: 'profile-1', name: 'ref' }],
    });
    const msRefItemsMap = new Map([
      ['profile-1', makeRefItem('profile-1', { 'Full Name/Preferred Name': 'Aroha Ngata' })],
    ]);
    const result = transformMonthlyStatementServiceItem(item, makeContext({ msRefItemsMap }));
    expect(result.participant).toBe('Aroha Ngata');
  });

  it('keeps the item full-name when the profile carries no name', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME]: 'Fallback Name',
      [ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]: [{ id: 'profile-2', name: 'ref' }],
    });
    const msRefItemsMap = new Map([['profile-2', makeRefItem('profile-2', { Suburb: 'Katoomba' })]]);
    const result = transformMonthlyStatementServiceItem(item, makeContext({ msRefItemsMap }));
    expect(result.participant).toBe('Fallback Name');
  });

  it('returns an empty participant name when nothing resolves', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 1 });
    const result = transformMonthlyStatementServiceItem(item, makeContext());
    expect(result.participant).toBe('');
  });

  it('derives the service from the part of the Service Plan ID after the first dash', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.SERVICE_PLAN]: [{ id: 'plan-1', name: 'ref' }] });
    const msRefItemsMap = new Map([
      ['plan-1', makeRefItem('plan-1', { 'Service Plan ID': 'SP001- Domestic Assistance' })],
    ]);
    const result = transformMonthlyStatementServiceItem(item, makeContext({ msRefItemsMap }));
    expect(result.service).toBe('Domestic Assistance');
  });

  it('leaves the service null when there is no service plan reference', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 1 });
    const result = transformMonthlyStatementServiceItem(item, makeContext());
    expect(result.service).toBeNull();
  });

  it('joins funding source names and skips ids that do not resolve', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.FUNDING_SOURCE]: [
        { id: 'fs-1', name: 'ref' },
        { id: 'fs-missing', name: 'ref' },
        { id: 'fs-2', name: 'ref' },
      ],
    });
    const msRefItemsMap = new Map([
      ['fs-1', makeRefItem('fs-1', { 'Funding Stream': '🏠 Home Support Quarterly Budget' })],
      ['fs-2', makeRefItem('fs-2', { 'Funding Stream': 'Restorative Care Pathway Budget' })],
    ]);
    const result = transformMonthlyStatementServiceItem(item, makeContext({ msRefItemsMap }));
    expect(result.fundingSource).toBe('Home Support Quarterly Budget, Restorative Care Pathway Budget');
  });

  it('appends the emoji-stripped service category to a primary supplement funding source', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.SERVICE_PLAN]: [{ id: 'plan-2', name: 'ref' }],
      [ATTRIBUTE_NAMES.FUNDING_SOURCE]: [{ id: 'fs-3', name: 'ref' }],
    });
    const msRefItemsMap = new Map([
      [
        'plan-2',
        makeRefItem('plan-2', {
          'Service Plan ID': 'SP002- Personal Care',
          'Service Category': '🏠 Home Support',
        }),
      ],
      ['fs-3', makeRefItem('fs-3', { 'Funding Stream': 'Primary Supplement' })],
    ]);
    const result = transformMonthlyStatementServiceItem(item, makeContext({ msRefItemsMap }));
    expect(result.fundingSource).toBe('Primary Supplement - Home Support');
  });

  it('appends the service category for unspent HCP funding sources too', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.SERVICE_PLAN]: [{ id: 'plan-3', name: 'ref' }],
      [ATTRIBUTE_NAMES.FUNDING_SOURCE]: [{ id: 'fs-4', name: 'ref' }],
    });
    const msRefItemsMap = new Map([
      ['plan-3', makeRefItem('plan-3', { 'Service Category': 'Nursing' })],
      ['fs-4', makeRefItem('fs-4', { 'Funding Stream': 'Unspent HCP - Participant Portion' })],
    ]);
    const result = transformMonthlyStatementServiceItem(item, makeContext({ msRefItemsMap }));
    expect(result.fundingSource).toBe('Unspent HCP - Participant Portion - Nursing');
  });

  it('does not append the service category to an ordinary funding source', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.SERVICE_PLAN]: [{ id: 'plan-4', name: 'ref' }],
      [ATTRIBUTE_NAMES.FUNDING_SOURCE]: [{ id: 'fs-5', name: 'ref' }],
    });
    const msRefItemsMap = new Map([
      ['plan-4', makeRefItem('plan-4', { 'Service Category': 'Home Support' })],
      ['fs-5', makeRefItem('fs-5', { 'Funding Stream': 'Home Support Quarterly Budget' })],
    ]);
    const result = transformMonthlyStatementServiceItem(item, makeContext({ msRefItemsMap }));
    expect(result.fundingSource).toBe('Home Support Quarterly Budget');
  });

  it('leaves the funding source undefined when the attribute is absent or unresolvable', () => {
    const none = transformMonthlyStatementServiceItem(makeItem({ Quantity: 1 }), makeContext());
    expect(none.fundingSource).toBeUndefined();

    const unresolvable = transformMonthlyStatementServiceItem(
      makeItem({ [ATTRIBUTE_NAMES.FUNDING_SOURCE]: [{ id: 'fs-nope', name: 'ref' }] }),
      makeContext(),
    );
    expect(unresolvable.fundingSource).toBeUndefined();
  });
});

describe('transformMonthlyStatementServiceItem — dates, quantities and money', () => {
  it('mirrors the scheduled start and actual end into every alias field', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.SCHEDULED_START]: '2026-03-31T22:00:00.000Z',
      [ATTRIBUTE_NAMES.ACTUAL_END]: '2026-04-01T01:00:00.000Z',
      [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: [{ id: 's1', name: TRANSACTION_STATUS_USE_ACTUAL_END }],
    });
    const result = transformMonthlyStatementServiceItem(item, makeContext());

    expect(result.scheduledStart).toBe('2026-03-31T22:00:00.000Z');
    expect(result.scheduledServiceDate).toBe('2026-03-31T22:00:00.000Z');
    expect(result.scheduledShiftStart).toBe('2026-03-31T22:00:00.000Z');
    expect(result.scheduledShiftStartDateTime).toBe('2026-03-31T22:00:00.000Z');
    expect(result.actualEnd).toBe('2026-04-01T01:00:00.000Z');
    expect(result.actualShiftEndDateTime).toBe('2026-04-01T01:00:00.000Z');
    expect(result.serviceDeliveryDate).toBe('2026-04-01T01:00:00.000Z');
    expect(result.transactionStatus).toBe(TRANSACTION_STATUS_USE_ACTUAL_END);
  });

  it('nulls the dates when the attributes are absent or empty', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.SCHEDULED_START]: '' });
    const result = transformMonthlyStatementServiceItem(item, makeContext());
    expect(result.scheduledStart).toBeNull();
    expect(result.actualEnd).toBeNull();
    expect(result.transactionStatus).toBeUndefined();
  });

  it('carries numeric money fields through unchanged', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.QUANTITY]: 2.5,
      [ATTRIBUTE_NAMES.UNIT_PRICE]: 68.4,
      [ATTRIBUTE_NAMES.TOTAL_AMOUNT]: 171,
      [ATTRIBUTE_NAMES.GOV_SUBSIDY]: 153.9,
      [ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION]: 17.1,
    });
    const result = transformMonthlyStatementServiceItem(item, makeContext());
    expect(result.quantity).toBe(2.5);
    expect(result.unitPrice).toBe(68.4);
    expect(result.totalAmount).toBe(171);
    expect(result.govSubsidy).toBe(153.9);
    expect(result.participantContribution).toBe(17.1);
  });

  it('parses plain numeric strings but zeroes anything Number() cannot read', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.QUANTITY]: '3',
      [ATTRIBUTE_NAMES.UNIT_PRICE]: '68.40',
      [ATTRIBUTE_NAMES.TOTAL_AMOUNT]: '$1,234.56',
      [ATTRIBUTE_NAMES.GOV_SUBSIDY]: '(100)',
    });
    const result = transformMonthlyStatementServiceItem(item, makeContext());
    expect(result.quantity).toBe(3);
    expect(result.unitPrice).toBe(68.4);
    // Number('$1,234.56') and Number('(100)') are both NaN, so `|| 0` wins.
    expect(result.totalAmount).toBe(0);
    expect(result.govSubsidy).toBe(0);
  });

  it('zeroes every money field when the attributes are missing', () => {
    const result = transformMonthlyStatementServiceItem(makeItem({ Unit: 'Each' }), makeContext());
    expect(result.quantity).toBe(0);
    expect(result.unitPrice).toBe(0);
    expect(result.totalAmount).toBe(0);
    expect(result.govSubsidy).toBe(0);
    expect(result.participantContribution).toBe(0);
  });

  it('preserves a negative amount (a refund line)', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.TOTAL_AMOUNT]: -85.5,
      [ATTRIBUTE_NAMES.QUANTITY]: -1,
    });
    const result = transformMonthlyStatementServiceItem(item, makeContext());
    expect(result.totalAmount).toBe(-85.5);
    expect(result.quantity).toBe(-1);
  });

  it('defaults the unit to Hour when absent or empty', () => {
    expect(transformMonthlyStatementServiceItem(makeItem({ Quantity: 1 }), makeContext()).unit).toBe('Hour');
    expect(
      transformMonthlyStatementServiceItem(makeItem({ [ATTRIBUTE_NAMES.UNIT]: '' }), makeContext()).unit,
    ).toBe('Hour');
    expect(
      transformMonthlyStatementServiceItem(makeItem({ [ATTRIBUTE_NAMES.UNIT]: 'Each' }), makeContext()).unit,
    ).toBe('Each');
  });

  it('distinguishes an absent committed AT-HM value from a zero one', () => {
    expect(
      transformMonthlyStatementServiceItem(makeItem({ Quantity: 1 }), makeContext()).committedAtHmForDelivery,
    ).toBeUndefined();
    expect(
      transformMonthlyStatementServiceItem(
        makeItem({ [ATTRIBUTE_NAMES.COMMITTED_AT_HM]: 0 }),
        makeContext(),
      ).committedAtHmForDelivery,
    ).toBe(0);
    expect(
      transformMonthlyStatementServiceItem(
        makeItem({ [ATTRIBUTE_NAMES.COMMITTED_AT_HM]: '1250.75' }),
        makeContext(),
      ).committedAtHmForDelivery,
    ).toBe(1250.75);
    expect(
      transformMonthlyStatementServiceItem(
        makeItem({ [ATTRIBUTE_NAMES.COMMITTED_AT_HM]: 'n/a' }),
        makeContext(),
      ).committedAtHmForDelivery,
    ).toBe(0);
  });

  it('distinguishes an absent allocated time from a zero one', () => {
    expect(
      transformMonthlyStatementServiceItem(makeItem({ Quantity: 1 }), makeContext()).allocatedTime,
    ).toBeUndefined();
    expect(
      transformMonthlyStatementServiceItem(
        makeItem({ [ATTRIBUTE_NAMES.ALLOCATED_TIME]: 0 }),
        makeContext(),
      ).allocatedTime,
    ).toBe(0);
    expect(
      transformMonthlyStatementServiceItem(
        makeItem({ [ATTRIBUTE_NAMES.ALLOCATED_TIME]: '1.75' }),
        makeContext(),
      ).allocatedTime,
    ).toBe(1.75);
  });

  it('defaults the notes to an empty string', () => {
    expect(transformMonthlyStatementServiceItem(makeItem({ Quantity: 1 }), makeContext()).notes).toBe('');
    expect(
      transformMonthlyStatementServiceItem(
        makeItem({ [ATTRIBUTE_NAMES.ADDITIONAL_NOTES]: 'Client rescheduled' }),
        makeContext(),
      ).notes,
    ).toBe('Client rescheduled');
  });

  it('reads only the flat data map, ignoring the raw values[] array', () => {
    const item = {
      itemId: 'values-only-item',
      workspaceId: 'ws-1',
      boardId: 'board-1',
      folderId: 'folder-shift-planning',
      createdAt: new Date('2026-03-01T02:00:00.000Z'),
      updatedAt: new Date('2026-03-20T02:00:00.000Z'),
      data: {
        values: [
          { id: 'v0', attribute: { id: 'a0', name: ATTRIBUTE_NAMES.QUANTITY }, data: 4 },
          { id: 'v1', attribute: { id: 'a1', name: ATTRIBUTE_NAMES.UNIT }, data: 'Each' },
        ],
      },
    };
    const result = transformMonthlyStatementServiceItem(item, makeContext());
    expect(result.quantity).toBe(0);
    expect(result.unit).toBe('Hour');
  });

  it('handles an item with no data at all', () => {
    const item = { itemId: 'empty-item', updatedAt: new Date('2026-03-20T02:00:00.000Z') };
    const result = transformMonthlyStatementServiceItem(item, makeContext());
    expect(result.participant).toBe('');
    expect(result.quantity).toBe(0);
    expect(result.unit).toBe('Hour');
    expect(result.deliveredBy).toBeNull();
  });
});

describe('transformMonthlyStatementServiceItem — caching', () => {
  it('returns the cached object on a second call and does not recompute', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 2 }, { itemId: 'cached-item' });
    const first = transformMonthlyStatementServiceItem(item, makeContext());
    expect(first.quantity).toBe(2);

    const changed = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 99 }, { itemId: 'cached-item' });
    const second = transformMonthlyStatementServiceItem(changed, makeContext());

    expect(second).toBe(first);
    expect(second.quantity).toBe(2);
  });

  it('recomputes when the item was updated after the cache entry was written', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 2 }, { itemId: 'busted-item' });
    const first = transformMonthlyStatementServiceItem(item, makeContext());

    const newer = makeItem(
      { [ATTRIBUTE_NAMES.QUANTITY]: 99 },
      { itemId: 'busted-item', updatedAt: new Date(Date.now() + 60_000) },
    );
    const second = transformMonthlyStatementServiceItem(newer, makeContext());

    expect(second).not.toBe(first);
    expect(second.quantity).toBe(99);
  });

  it('keys the cache per workspace and board', () => {
    const item = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 2 }, { itemId: 'scoped-item' });
    transformMonthlyStatementServiceItem(item, makeContext());

    const otherBoard = makeItem({ [ATTRIBUTE_NAMES.QUANTITY]: 7 }, { itemId: 'scoped-item' });
    const result = transformMonthlyStatementServiceItem(otherBoard, {
      ...makeContext(),
      boardId: 'board-2',
    });
    expect(result.quantity).toBe(7);
  });
});
