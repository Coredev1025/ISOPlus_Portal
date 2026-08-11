import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  getMonthlyStatementData,
  transformMonthlyStatementBudgetItemsBatch,
} from '../../../src/utils/monthlyStatementRouteHelpers.js';
import {
  ATTRIBUTE_NAMES,
  REF_ATTRIBUTE_NAMES,
  BUDGET_CATEGORY_CONFIG,
  BUDGET_CATEGORY_ORDER,
  TRANSACTION_STATUS_USE_ACTUAL_END,
} from '../../../src/constants/monthlyStatementAttributes.js';
import { clearCache, getCachedMSBudget, setCachedMSBudget } from '../../../src/utils/transformCache.js';
import Item from '../../../src/models/Item.js';
import Business from '../../../src/models/Business.js';

// ---------------------------------------------------------------------------
// Collaborators, reproduced from src/routes/items.js (the only caller) minus
// its logging. Everything the module computes — folder mapping, budget and
// service transformation, month filtering, aggregation, pagination and the
// response envelope — runs for real against the in-memory Mongo that
// test/setup.js starts.
// ---------------------------------------------------------------------------

const getValueFromFlatData = (item, attributeName) => {
  if (!item?.data) return null;
  const attributeNames = Array.isArray(attributeName) ? attributeName : [attributeName];
  for (const attrName of attributeNames) {
    if (item.data[attrName] !== undefined && item.data[attrName] !== null) return item.data[attrName];
  }
  if (Array.isArray(item.data.values)) {
    for (const attrName of attributeNames) {
      const entry = item.data.values.find((v) => v.attribute?.name === attrName);
      if (entry?.data !== undefined && entry?.data !== null) return entry.data;
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

const bulkFetchReferenceItemsFromDB = async (workspaceId, boardId, itemIds) => {
  if (!itemIds || itemIds.length === 0) return new Map();
  const uniqueIds = [...new Set(itemIds.filter(Boolean).map((id) => (typeof id === 'object' && id.id ? id.id.toString() : id.toString())))];
  if (uniqueIds.length === 0) return new Map();
  const items = await Item.find({ workspaceId, boardId, itemId: { $in: uniqueIds } }).lean();
  return new Map(items.map((item) => [item.itemId, item]));
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
    const asString = String(servicePlanIdValue).trim();
    if (asString.includes('-')) {
      const parts = asString.split('-');
      const fromId = parts.length >= 2 ? parts.slice(1).join('-').trim() : asString;
      if (fromId) return fromId;
    } else if (asString) {
      return asString;
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
  const name = getValueFromFlatData(fsItem, [REF_ATTRIBUTE_NAMES.FS_NAME, REF_ATTRIBUTE_NAMES.FS_DEFINITION]);
  if (!name) return null;
  const raw = typeof name === 'object' && name.name ? name.name : String(name).trim();
  return stripEmojiFromFundingSource(raw) || null;
};

const isUuidLike = (value) =>
  typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const getReferenceDisplayName = (refItem) => {
  if (!refItem) return '';
  const shortName = getValueFromFlatData(refItem, [
    'Primary Supplement',
    'Name',
    REF_ATTRIBUTE_NAMES.FS_NAME,
    REF_ATTRIBUTE_NAMES.PROFILE_FULL_NAME,
  ]);
  if (shortName) {
    const raw = typeof shortName === 'object' && shortName.name ? shortName.name : String(shortName).trim();
    if (raw) return stripEmojiFromFundingSource(raw);
  }
  return getFundingSourceNameFromItem(refItem) || getParticipantNameFromProfile(refItem) || '';
};

const FOLDERS = [
  { id: 'fld_hsq', name: 'Home Support Quarterly Budget' },
  { id: 'fld_hscm', name: 'Home Support Care Management Budget' },
  { id: 'fld_ats', name: 'Assistive Technology - Short-term Budget' },
  { id: 'fld_shift', name: 'Shift Planning and Reporting' },
  { id: 'fld_profiles', name: 'Participant Profiles' },
];

function makeDeps(overrides = {}) {
  return {
    Item,
    Business,
    getFolder: vi.fn(async () => ({ folder: FOLDERS })),
    bulkFetchReferenceItemsFromDB,
    getValueFromFlatData,
    extractRefId,
    extractAllRefIds,
    getParticipantNameFromProfile,
    getServiceFromServicePlan,
    getFundingSourceNameFromItem,
    stripEmojiFromFundingSource,
    getReferenceDisplayName,
    isUuidLike,
    getCachedMSBudget,
    setCachedMSBudget,
    ATTRIBUTE_NAMES,
    REF_ATTRIBUTE_NAMES,
    BUDGET_CATEGORY_CONFIG,
    BUDGET_CATEGORY_ORDER,
    TRANSACTION_STATUS_USE_ACTUAL_END,
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

// --- fixtures ---------------------------------------------------------------

const A = ATTRIBUTE_NAMES;

function doc(itemId, folderId, data, overrides = {}) {
  return {
    workspaceId: 'ws_1',
    boardId: 'bd_1',
    folderId,
    itemId,
    data,
    createdAt: new Date('2025-03-01T00:00:00.000Z'),
    updatedAt: new Date('2025-03-02T00:00:00.000Z'),
    ...overrides,
  };
}

const SUPPLEMENT_REF_ID = '11111111-1111-4111-8111-111111111111';

/** Home Support quarterly budget row for March 2025. */
const HSQ_BUDGET = doc('bud_hsq', 'fld_hsq', {
  [A.MONTH_LABEL]: 'March',
  [A.YEAR_LABEL]: '2025',
  [A.FY_QUARTER]: 'Q1',
  [A.PARTICIPANT_PROFILE]: ['pp_1'],
  [A.AVAILABLE_FUND_START]: '1000',
  [A.PRIMARY_SUPPLEMENT_AMOUNT]: '200',
  [A.CARRYOVER_FUNDING]: '100',
  [A.PREVIOUS_MONTH_SPENDING]: '-300',
  [A.HOME_SUPPORT_DELIVERED]: '-250',
  [A.HOME_SUPPORT_ADJUSTMENTS]: '-50',
  [A.FUNDING_START_DATE]: '2025-01-01',
  [A.FUNDING_END_DATE]: '2025-03-31',
  'Primary Supplement': [SUPPLEMENT_REF_ID],
});

/** Assistive Technology short-term budget row for March 2025. */
const ATS_BUDGET = doc('bud_ats', 'fld_ats', {
  [A.MONTH_LABEL]: 'March',
  [A.YEAR_LABEL]: '2025',
  [A.PARTICIPANT_PROFILE]: ['pp_1'],
  [A.AVAILABLE_FUND_START]: '500',
  [A.ADDITIONAL_AMOUNT_APPROVED_AT]: '250',
  [A.PREVIOUS_MONTH_SPENDING_ALLOCATED_PERIOD]: '-100',
  'AT - Short-term Delivered During the Month ($-)': '-200',
  [A.COMMITTED_AT_SHORT_TERM]: '-75',
});

/** Care-management ledger row dated inside March 2025. */
const HSCM_BUDGET = doc('bud_hscm', 'fld_hscm', {
  'Associated Participant': ['pp_1'],
  Date: '2025-03-05T00:00:00Z',
  'Transaction Type': 'Allocation',
  'Received Amount ($)': '400',
  [A.ALLOCATED_TIME]: '2.5',
  'Allocated Amount ($-)': '-150',
});

const PROFILE = doc('pp_1', 'fld_profiles', {
  'Full Name/Preferred Name': 'Jane Roe',
  Address: '12 Smith St',
  Suburb: 'Blacktown',
  State: [{ id: 'st1', name: 'NSW' }],
  Postcode: '2148',
  'My Aged Care ID Number': 'AC-9911',
  'Provider ID': 'PRV-PROFILE',
  [A.FUNDING_SOURCE]: ['fs_1'],
});

const FUNDING_SOURCE_HS = doc('fs_1', 'fld_profiles', {
  'Funding Stream': 'Home Support Quarterly Budget',
});
const FUNDING_SOURCE_SUPPLEMENT = doc('fs_2', 'fld_profiles', {
  'Funding Stream': '🏠 Primary Supplement',
});
// resolveReferenceValue only looks a reference up when the raw value is
// UUID-shaped, so the fixture uses a real UUID.
const SUPPLEMENT_REF = doc(SUPPLEMENT_REF_ID, 'fld_profiles', {
  'Primary Supplement': 'Veterans',
});
const SERVICE_PLAN = doc('sp_1', 'fld_profiles', {
  'Service Plan ID': 'SP-Personal Care',
  'Service Category': 'Social Support',
});

/** Delivered shift: filtered on its actual end date, which lands in March. */
const SERVICE_DELIVERED = doc('svc_a', 'fld_shift', {
  [A.SCHEDULED_START]: '2025-02-27T22:00:00Z',
  [A.ACTUAL_END]: '2025-03-01T04:00:00Z',
  [A.TRANSACTION_STATUS]: [{ id: 't1', name: TRANSACTION_STATUS_USE_ACTUAL_END }],
  [A.PARTICIPANT_PROFILE]: ['pp_1'],
  [A.SERVICE_PLAN]: ['sp_1'],
  [A.FUNDING_SOURCE]: ['fs_1'],
  [A.DELIVERED_BY]: 'Company Workforce',
  [A.UNIT]: 'Hour',
  [A.QUANTITY]: '2',
  [A.UNIT_PRICE]: '60',
  [A.TOTAL_AMOUNT]: '120',
  [A.GOV_SUBSIDY]: '100',
  [A.PARTICIPANT_CONTRIBUTION]: '20',
}, { updatedAt: new Date('2025-03-10T00:00:00.000Z') });

/** Scheduled shift: filtered on its scheduled start, even though it ends in April. */
const SERVICE_SCHEDULED = doc('svc_b', 'fld_shift', {
  [A.SCHEDULED_START]: '2025-03-05T09:00:00Z',
  [A.ACTUAL_END]: '2025-04-02T00:00:00Z',
  [A.TRANSACTION_STATUS]: 'Scheduled',
  [A.PARTICIPANT_PROFILE]: ['pp_1'],
  [A.SERVICE_PLAN]: ['sp_1'],
  [A.FUNDING_SOURCE]: ['fs_2'],
  [A.UNIT]: 'Hour',
  [A.QUANTITY]: '1',
  [A.TOTAL_AMOUNT]: '60',
  [A.GOV_SUBSIDY]: '50',
  [A.PARTICIPANT_CONTRIBUTION]: '10',
}, { updatedAt: new Date('2025-03-20T00:00:00.000Z') });

/** Delivered in February: excluded from a March statement. */
const SERVICE_FEBRUARY = doc('svc_c', 'fld_shift', {
  [A.SCHEDULED_START]: '2025-02-20T09:00:00Z',
  [A.ACTUAL_END]: '2025-02-25T09:00:00Z',
  [A.TRANSACTION_STATUS]: [{ id: 't1', name: TRANSACTION_STATUS_USE_ACTUAL_END }],
  [A.PARTICIPANT_PROFILE]: ['pp_1'],
  [A.UNIT]: 'Hour',
  [A.QUANTITY]: '4',
  [A.TOTAL_AMOUNT]: '240',
});

const MARCH_2025_SYDNEY = {
  startDate: '2025-02-28T13:00:00.000Z',
  endDate: '2025-03-31T12:59:59.999Z',
};

const baseArgs = { workspaceId: 'ws_1', boardId: 'bd_1', req: null };

async function seed(docs) {
  await Item.insertMany(docs);
}

function categoryByCode(result, code) {
  return result.budgetCategories.find((category) => category.code === code);
}

beforeEach(() => {
  // The monthly-statement caches live in a module-level Map that outlives a
  // test; a stale entry would satisfy the next test without recomputing.
  clearCache();
});

describe('getMonthlyStatementData', () => {
  it('returns budget rows grouped by folder with the participant and period echoed back', async () => {
    await seed([HSQ_BUDGET, ATS_BUDGET, HSCM_BUDGET, PROFILE, FUNDING_SOURCE_HS, SUPPLEMENT_REF]);
    await Business.create({
      workspaceId: 'ws_1',
      name: 'Hills Grade Care',
      companyRegistrationId: 'PRV-BUSINESS',
      headOfficeTimezone: 'Australia/Sydney',
    });

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025', participant: 'Jane Roe' } },
      makeDeps(),
    );

    // Groups appear in budget-category order (HSQ, HSCM, ATS), not folder or
    // insertion order.
    expect(Object.keys(result.budgetItems.items)).toEqual([
      'Home Support Quarterly Budget',
      'Home Support Care Management Budget',
      'Assistive Technology - Short-term Budget',
    ]);
    expect(result.budgetItems.total).toBe(3);
    expect(result.budgetItems.page).toBe(1);
    expect(result.budgetItems.limit).toBe(3);
    expect(result.month).toBe('March');
    expect(result.monthNumber).toBe('03');
    expect(result.year).toBe('2025');
    expect(result.participant).toBe('Jane Roe');
    expect(result.participantProfile).toBe('Jane Roe');
    expect(result.participantAddress).toBe('12 Smith St');
    expect(result.participantSuburb).toBe('Blacktown');
    expect(result.participantState).toBe('NSW');
    expect(result.participantPostcode).toBe('2148');
    expect(result.myAgedCareIdNumber).toBe('AC-9911');
    expect(result.providerId).toBe('PRV-BUSINESS');
  });

  it('falls back to the profile provider id when the business has none', async () => {
    await seed([HSQ_BUDGET, PROFILE, FUNDING_SOURCE_HS, SUPPLEMENT_REF]);

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025' } },
      makeDeps(),
    );

    expect(result.providerId).toBe('PRV-PROFILE');
  });

  it('computes the home support budget arithmetic from the stored attributes', async () => {
    await seed([HSQ_BUDGET, PROFILE, FUNDING_SOURCE_HS, SUPPLEMENT_REF]);

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025' } },
      makeDeps(),
    );

    const row = result.budgetItems.items['Home Support Quarterly Budget'].items[0];
    // 1000 opening + 200 supplement + 100 carryover - 300 already spent = 1000.
    expect(row.totalAvailableBudget).toBe(1000);
    expect(row.deliveredAmount).toBe(-250);
    expect(row.adjustmentAmount).toBe(-50);
    // 1000 - 250 delivered - 50 adjustments = 700.
    expect(row.remainingBalance).toBe(700);
    expect(row.remainingBalanceEndOfMonth).toBe(700);
    expect(row.primarySupplementLabel).toBe('Veterans');
    expect(row.month).toBe('March');
    expect(row.year).toBe('2025');
    expect(row.participantName).toBe('Jane Roe');

    const hsq = categoryByCode(result, 'HSQ');
    expect(hsq.name).toBe('Home Support Quarterly Budget January ~ March 2025');
    expect(hsq.availableFunds).toBe(1000);
    expect(hsq.remainingBudget).toBe(700);
    expect(hsq.serviceDeliveredAmount).toBe(-250);
    expect(hsq.shouldDisplay).toBe(true);
    expect(hsq.availableBalanceRangeLabel).toBe('2025-01-01 - 2025-03-31');
    expect(hsq.expenditurePeriodLabel).toBe('March 2025');
  });

  it('computes the allocation-period balances for assistive technology', async () => {
    await seed([ATS_BUDGET, PROFILE, FUNDING_SOURCE_HS]);

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025' } },
      makeDeps(),
    );

    const ats = categoryByCode(result, 'ATS');
    // 500 opening + 250 additional approved - 100 already spent = 650.
    expect(ats.availableFunds).toBe(650);
    // 650 - 200 delivered = 450 at end of month; less 75 committed = 375.
    expect(ats.remainingBalanceEndOfMonth).toBe(450);
    expect(ats.remainingBalanceAllocationPeriod).toBe(375);
    expect(ats.remainingBudget).toBe(375);
    expect(ats.committedFunds).toBe(-75);
    expect(ats.serviceDeliveredAmount).toBe(-200);
  });

  it('summarises the care-management ledger row', async () => {
    await seed([HSCM_BUDGET, PROFILE, FUNDING_SOURCE_HS]);

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025' } },
      makeDeps(),
    );

    const row = result.budgetItems.items['Home Support Care Management Budget'].items[0];
    expect(row.categoryCode).toBe('HSCM');
    expect(row.month).toBe('March');
    expect(row.year).toBe('2025');
    expect(row.hscmAllocatedTime).toBe(2.5);
    expect(row.hscmReceivedAmount).toBe(400);
    expect(row.hscmAllocatedAmount).toBe(-150);
    // 400 received - 150 allocated = 250 net.
    expect(row.hscmCurrentBalance).toBe(250);
    expect(row.remainingBalance).toBe(250);

    const hscm = categoryByCode(result, 'HSCM');
    expect(hscm.hscmTotalAllocatedTime).toBe(2.5);
    expect(hscm.hscmTotalReceivedAmount).toBe(400);
    expect(hscm.hscmTotalAllocatedAmount).toBe(-150);
    expect(hscm.hscmItemCount).toBe(1);
  });

  it('returns all seven budget categories in configuration order', async () => {
    await seed([HSQ_BUDGET, PROFILE, FUNDING_SOURCE_HS, SUPPLEMENT_REF]);

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025' } },
      makeDeps(),
    );

    expect(result.budgetCategories.map((category) => category.code)).toEqual(BUDGET_CATEGORY_ORDER);
    expect(result.budgetCategories.map((category) => category.code))
      .toEqual(['HSQ', 'HSCM', 'ATS', 'ATO', 'HMB', 'RCP', 'EOL']);
    const eol = categoryByCode(result, 'EOL');
    expect(eol.availableFunds).toBe(0);
    expect(eol.shouldDisplay).toBe(false);
    expect(eol.fundingEndDate).toBe(new Date(2025, 11, 31).toISOString());
  });

  it.each([
    ['1', { start: 'January', end: 'March' }],
    ['4', { start: 'April', end: 'June' }],
    ['7', { start: 'July', end: 'September' }],
    ['11', { start: 'October', end: 'December' }],
  ])('names the home support quarter for month %s', async (month, quarter) => {
    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { month, year: '2025' } },
      makeDeps(),
    );

    const hsq = categoryByCode(result, 'HSQ');
    expect(hsq.quarterStartMonth).toBe(quarter.start);
    expect(hsq.quarterEndMonth).toBe(quarter.end);
    expect(hsq.name).toBe(`Home Support Quarterly Budget ${quarter.start} ~ ${quarter.end} 2025`);
  });

  it('filters budget rows to the requested month and year', async () => {
    const februaryRow = doc('bud_feb', 'fld_hsq', {
      [A.MONTH_LABEL]: 'February',
      [A.YEAR_LABEL]: '2025',
      [A.PARTICIPANT_PROFILE]: ['pp_1'],
      [A.AVAILABLE_FUND_START]: '900',
    });
    const lastYearRow = doc('bud_2024', 'fld_hsq', {
      [A.MONTH_LABEL]: 'March',
      [A.YEAR_LABEL]: '2024',
      [A.PARTICIPANT_PROFILE]: ['pp_1'],
      [A.AVAILABLE_FUND_START]: '800',
    });
    await seed([HSQ_BUDGET, februaryRow, lastYearRow, PROFILE, FUNDING_SOURCE_HS, SUPPLEMENT_REF]);

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025' } },
      makeDeps(),
    );

    expect(result.budgetItems.total).toBe(1);
    expect(result.budgetItems.items['Home Support Quarterly Budget'].items.map((row) => row.id))
      .toEqual(['bud_hsq']);
  });

  it('matches a budget participant by profile id when the filter contains a hyphen', async () => {
    const otherProfile = doc('pp-2', 'fld_profiles', { 'Full Name/Preferred Name': 'John Doe' });
    const otherRow = doc('bud_other', 'fld_hsq', {
      [A.MONTH_LABEL]: 'March',
      [A.YEAR_LABEL]: '2025',
      [A.PARTICIPANT_PROFILE]: ['pp-2'],
      [A.AVAILABLE_FUND_START]: '10',
    });
    await seed([HSQ_BUDGET, otherRow, PROFILE, otherProfile, FUNDING_SOURCE_HS, SUPPLEMENT_REF]);

    const byId = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025', participant: 'pp-2' } },
      makeDeps(),
    );
    const byName = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025', participant: 'Jane Roe' } },
      makeDeps(),
    );

    expect(byId.budgetItems.total).toBe(1);
    expect(byId.budgetItems.items['Home Support Quarterly Budget'].items[0].id).toBe('bud_other');
    expect(byName.budgetItems.total).toBe(1);
    expect(byName.budgetItems.items['Home Support Quarterly Budget'].items[0].id).toBe('bud_hsq');
  });

  it('paginates each budget folder group independently', async () => {
    const rows = ['a', 'b', 'c'].map((suffix, index) => doc(`bud_${suffix}`, 'fld_hsq', {
      [A.MONTH_LABEL]: 'March',
      [A.YEAR_LABEL]: '2025',
      [A.AVAILABLE_FUND_START]: String((index + 1) * 100),
    }));
    await seed([...rows, HSCM_BUDGET, PROFILE, FUNDING_SOURCE_HS]);

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025', budgetLimit: '2', budgetPage: '2' } },
      makeDeps(),
    );

    const hsqGroup = result.budgetItems.items['Home Support Quarterly Budget'];
    expect(hsqGroup.items).toHaveLength(1);
    expect(hsqGroup.total).toBe(3);
    expect(hsqGroup.page).toBe(2);
    expect(hsqGroup.limit).toBe(2);
    expect(result.budgetItems.total).toBe(4);
    expect(result.budgetItems.limit).toBe(2);
  });

  it('falls back to a limit of 10 for a nonsense budget limit', async () => {
    await seed([HSQ_BUDGET, PROFILE, FUNDING_SOURCE_HS, SUPPLEMENT_REF]);

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025', budgetLimit: 'abc', budgetPage: '0' } },
      makeDeps(),
    );

    expect(result.budgetItems.limit).toBe(10);
    expect(result.budgetItems.page).toBe(1);
  });

  // --- service filtering ------------------------------------------------------

  it('filters delivered shifts on their actual end and other shifts on their scheduled start', async () => {
    await seed([
      SERVICE_DELIVERED, SERVICE_SCHEDULED, SERVICE_FEBRUARY,
      PROFILE, SERVICE_PLAN, FUNDING_SOURCE_HS, FUNDING_SOURCE_SUPPLEMENT,
    ]);

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025', ...MARCH_2025_SYDNEY } },
      makeDeps(),
    );

    expect(result.serviceItems.total).toBe(2);
    expect(result.serviceItems.items.map((service) => service.scheduledStart)).toEqual([
      '2025-03-05T09:00:00Z',
      '2025-02-27T22:00:00Z',
    ]);
  });

  it('drops a delivered shift whose actual end falls after the period', async () => {
    const lateDelivery = doc('svc_late', 'fld_shift', {
      [A.SCHEDULED_START]: '2025-03-30T09:00:00Z',
      [A.ACTUAL_END]: '2025-04-05T09:00:00Z',
      [A.TRANSACTION_STATUS]: TRANSACTION_STATUS_USE_ACTUAL_END,
      [A.UNIT]: 'Hour',
      [A.QUANTITY]: '1',
      [A.TOTAL_AMOUNT]: '60',
    });
    await seed([SERVICE_DELIVERED, lateDelivery, PROFILE, SERVICE_PLAN, FUNDING_SOURCE_HS]);

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025', ...MARCH_2025_SYDNEY } },
      makeDeps(),
    );

    expect(result.serviceItems.total).toBe(1);
    expect(result.summary.totalAmount).toBe(120);
  });

  it('sums the service summary over the filtered shifts only', async () => {
    await seed([
      SERVICE_DELIVERED, SERVICE_SCHEDULED, SERVICE_FEBRUARY,
      PROFILE, SERVICE_PLAN, FUNDING_SOURCE_HS, FUNDING_SOURCE_SUPPLEMENT,
    ]);

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025', ...MARCH_2025_SYDNEY } },
      makeDeps(),
    );

    expect(result.summary).toEqual({
      totalServices: 2,
      totalHours: 3,
      totalAmount: 180,
      govSubsidy: 150,
      participantContribution: 30,
      averageServiceCost: 90,
    });
  });

  it('counts hours only for shifts measured in hours, and averages nothing over no shifts', async () => {
    const itemUnit = doc('svc_item', 'fld_shift', {
      [A.SCHEDULED_START]: '2025-03-06T09:00:00Z',
      [A.UNIT]: 'Item',
      [A.QUANTITY]: '5',
      [A.TOTAL_AMOUNT]: '500',
    });
    await seed([itemUnit, PROFILE]);

    const withShift = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025', ...MARCH_2025_SYDNEY } },
      makeDeps(),
    );
    const withoutShift = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '4', year: '2025', startDate: '2025-04-01T00:00:00Z', endDate: '2025-04-30T00:00:00Z' } },
      makeDeps(),
    );

    expect(withShift.summary.totalHours).toBe(0);
    expect(withShift.summary.averageServiceCost).toBe(500);
    expect(withoutShift.summary).toEqual({
      totalServices: 0,
      totalHours: 0,
      totalAmount: 0,
      govSubsidy: 0,
      participantContribution: 0,
      averageServiceCost: 0,
    });
  });

  it('aggregates service subsidies into the category implied by the notes', async () => {
    const restorative = doc('svc_rcp', 'fld_shift', {
      [A.SCHEDULED_START]: '2025-03-07T09:00:00Z',
      [A.ADDITIONAL_NOTES]: 'Restorative care pathway session',
      [A.UNIT]: 'Hour',
      [A.QUANTITY]: '1',
      [A.TOTAL_AMOUNT]: '80',
      [A.GOV_SUBSIDY]: '70',
      [A.PARTICIPANT_CONTRIBUTION]: '10',
    });
    await seed([restorative, SERVICE_DELIVERED, PROFILE, SERVICE_PLAN, FUNDING_SOURCE_HS]);

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025', ...MARCH_2025_SYDNEY } },
      makeDeps(),
    );

    const rcp = categoryByCode(result, 'RCP');
    expect(rcp.govSubsidyAmount).toBe(70);
    expect(rcp.participantContributionAmount).toBe(10);
    expect(rcp.serviceCount).toBe(1);
    // Subsidies alone do not make a category visible: only budget-side figures
    // count towards shouldDisplay.
    expect(rcp.shouldDisplay).toBe(false);
    const hsq = categoryByCode(result, 'HSQ');
    expect(hsq.govSubsidyAmount).toBe(100);
    expect(hsq.serviceCount).toBe(1);
  });

  it('filters shifts by participant name using a case-insensitive regex', async () => {
    const otherProfile = doc('pp_2', 'fld_profiles', { 'Full Name/Preferred Name': 'John Doe' });
    const otherShift = doc('svc_other', 'fld_shift', {
      [A.SCHEDULED_START]: '2025-03-06T09:00:00Z',
      [A.PARTICIPANT_PROFILE]: ['pp_2'],
      [A.UNIT]: 'Hour',
      [A.QUANTITY]: '1',
      [A.TOTAL_AMOUNT]: '10',
    });
    await seed([SERVICE_DELIVERED, otherShift, PROFILE, otherProfile, SERVICE_PLAN, FUNDING_SOURCE_HS]);

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { participant: 'jane', ...MARCH_2025_SYDNEY } },
      makeDeps(),
    );

    expect(result.serviceItems.total).toBe(1);
    expect(result.serviceItems.items[0].participant).toBe('Jane Roe');
  });

  it('falls back to the participant full name attribute when no profile resolves', async () => {
    const shift = doc('svc_named', 'fld_shift', {
      [A.SCHEDULED_START]: '2025-03-06T09:00:00Z',
      [A.PARTICIPANT_FULL_NAME]: 'Walk-in Client',
      [A.UNIT]: 'Hour',
      [A.QUANTITY]: '1',
      [A.TOTAL_AMOUNT]: '10',
    });
    await seed([shift]);

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { participant: 'Walk-in', ...MARCH_2025_SYDNEY } },
      makeDeps(),
    );

    expect(result.serviceItems.total).toBe(1);
    expect(result.participant).toBe('Walk-in');
  });

  it('filters by transaction status and funding source, ignoring "all"', async () => {
    await seed([
      SERVICE_DELIVERED, SERVICE_SCHEDULED,
      PROFILE, SERVICE_PLAN, FUNDING_SOURCE_HS, FUNDING_SOURCE_SUPPLEMENT,
    ]);

    const byStatus = await getMonthlyStatementData(
      { ...baseArgs, query: { ...MARCH_2025_SYDNEY, serviceTransactionStatus: 'Scheduled' } },
      makeDeps(),
    );
    const byFunding = await getMonthlyStatementData(
      { ...baseArgs, query: { ...MARCH_2025_SYDNEY, serviceFundingSource: 'Home Support Quarterly Budget' } },
      makeDeps(),
    );
    const allFilters = await getMonthlyStatementData(
      { ...baseArgs, query: { ...MARCH_2025_SYDNEY, serviceTransactionStatus: 'all', serviceFundingSource: 'all' } },
      makeDeps(),
    );

    expect(byStatus.serviceItems.total).toBe(1);
    expect(byStatus.serviceItems.items[0].transactionStatus).toBe('Scheduled');
    expect(byFunding.serviceItems.total).toBe(1);
    expect(byFunding.serviceItems.items[0].scheduledStart).toBe('2025-02-27T22:00:00Z');
    expect(allFilters.serviceItems.total).toBe(2);
  });

  it('lists the distinct statuses and funding sources of the filtered shifts, sorted', async () => {
    await seed([
      SERVICE_DELIVERED, SERVICE_SCHEDULED, SERVICE_FEBRUARY,
      PROFILE, SERVICE_PLAN, FUNDING_SOURCE_HS, FUNDING_SOURCE_SUPPLEMENT,
    ]);

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { ...MARCH_2025_SYDNEY } },
      makeDeps(),
    );

    expect(result.serviceItems.distinctTransactionStatuses)
      .toEqual([TRANSACTION_STATUS_USE_ACTUAL_END, 'Scheduled']);
    expect(result.serviceItems.distinctFundingSources)
      .toEqual(['Home Support Quarterly Budget', 'Primary Supplement']);
    expect(result.fundingSources).toEqual(result.serviceItems.distinctFundingSources);
  });

  it('sorts shifts by delivery date in either direction and defaults to most recently updated', async () => {
    await seed([
      SERVICE_DELIVERED, SERVICE_SCHEDULED,
      PROFILE, SERVICE_PLAN, FUNDING_SOURCE_HS, FUNDING_SOURCE_SUPPLEMENT,
    ]);
    const ids = (result) => result.serviceItems.items.map((service) => service.scheduledStart);

    const ascending = await getMonthlyStatementData(
      { ...baseArgs, query: { ...MARCH_2025_SYDNEY, serviceSortBy: 'serviceDeliveryDate', serviceSortOrder: 'asc' } },
      makeDeps(),
    );
    const descending = await getMonthlyStatementData(
      { ...baseArgs, query: { ...MARCH_2025_SYDNEY, serviceSortBy: 'serviceDeliveryDate', serviceSortOrder: 'desc' } },
      makeDeps(),
    );
    const byUpdated = await getMonthlyStatementData(
      { ...baseArgs, query: { ...MARCH_2025_SYDNEY } },
      makeDeps(),
    );

    expect(ids(ascending)).toEqual(['2025-02-27T22:00:00Z', '2025-03-05T09:00:00Z']);
    expect(ids(descending)).toEqual(['2025-03-05T09:00:00Z', '2025-02-27T22:00:00Z']);
    // svc_b was updated later than svc_a, so it leads the default ordering.
    expect(ids(byUpdated)).toEqual(['2025-03-05T09:00:00Z', '2025-02-27T22:00:00Z']);
  });

  it('paginates shifts while keeping the unpaginated total', async () => {
    await seed([
      SERVICE_DELIVERED, SERVICE_SCHEDULED,
      PROFILE, SERVICE_PLAN, FUNDING_SOURCE_HS, FUNDING_SOURCE_SUPPLEMENT,
    ]);

    const result = await getMonthlyStatementData(
      {
        ...baseArgs,
        query: {
          ...MARCH_2025_SYDNEY,
          serviceSortBy: 'scheduledServiceDate',
          servicePage: '2',
          serviceLimit: '1',
        },
      },
      makeDeps(),
    );

    expect(result.serviceItems.items).toHaveLength(1);
    expect(result.serviceItems.items[0].scheduledStart).toBe('2025-03-05T09:00:00Z');
    expect(result.serviceItems.total).toBe(2);
    expect(result.serviceItems.page).toBe(2);
    expect(result.serviceItems.limit).toBe(1);
  });

  it('transforms each returned shift with its resolved service, provider and funding source', async () => {
    await seed([
      SERVICE_DELIVERED, SERVICE_SCHEDULED,
      PROFILE, SERVICE_PLAN, FUNDING_SOURCE_HS, FUNDING_SOURCE_SUPPLEMENT,
    ]);
    await Business.create({ workspaceId: 'ws_1', name: 'Hills Grade Care' });

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { ...MARCH_2025_SYDNEY, serviceSortBy: 'scheduledServiceDate' } },
      makeDeps(),
    );

    const [delivered, scheduled] = result.serviceItems.items;
    expect(delivered).toMatchObject({
      participant: 'Jane Roe',
      service: 'Personal Care',
      serviceProvider: 'Hills Grade Care',
      deliveredBy: 'Company Workforce',
      transactionStatus: TRANSACTION_STATUS_USE_ACTUAL_END,
      unit: 'Hour',
      quantity: 2,
      unitPrice: 60,
      totalAmount: 120,
      govSubsidy: 100,
      participantContribution: 20,
      fundingSource: 'Home Support Quarterly Budget',
      serviceDeliveryDate: '2025-03-01T04:00:00Z',
    });
    // A primary-supplement funding source is suffixed with the service category
    // and stripped of its emoji.
    expect(scheduled.fundingSource).toBe('Primary Supplement - Social Support');
    expect(scheduled.serviceProvider).toBeUndefined();
  });

  // --- error and edge branches -------------------------------------------------

  it('returns a 500 envelope when the budget query fails', async () => {
    const deps = makeDeps({
      Item: { find: () => ({ lean: async () => { throw new Error('budget query died'); } }) },
    });

    const result = await getMonthlyStatementData({ ...baseArgs, query: {} }, deps);

    expect(result).toEqual({
      error: {
        status: 500,
        body: { message: 'Error fetching budget items for monthly statement', error: 'budget query died' },
      },
    });
    expect(deps.error).toHaveBeenCalledWith(
      'Items-Service',
      'Database query error for budget items',
      expect.objectContaining({ message: 'budget query died' }),
      null,
    );
  });

  it('returns a 500 envelope when the service query fails', async () => {
    let call = 0;
    const deps = makeDeps({
      Item: {
        find: () => ({
          lean: async () => {
            call += 1;
            if (call === 1) return [];
            throw new Error('service query died');
          },
        }),
      },
    });

    const result = await getMonthlyStatementData({ ...baseArgs, query: {} }, deps);

    expect(result).toEqual({
      error: {
        status: 500,
        body: { message: 'Error fetching service items for monthly statement', error: 'service query died' },
      },
    });
  });

  it('warns and keeps going when the business record cannot be read', async () => {
    await seed([HSQ_BUDGET, PROFILE, FUNDING_SOURCE_HS, SUPPLEMENT_REF]);
    const deps = makeDeps({
      Business: { findOne: () => ({ select: () => ({ lean: async () => { throw new Error('no business'); } }) }) },
    });

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025' } },
      deps,
    );

    expect(deps.warn).toHaveBeenCalledWith(
      'Items-Service', 'Failed to fetch business name', { message: 'no business', workspaceId: 'ws_1' }, null,
    );
    expect(result.budgetItems.total).toBe(1);
  });

  it('warns and stops filtering by folder when the folder list cannot be fetched', async () => {
    await seed([HSQ_BUDGET, SERVICE_DELIVERED, PROFILE, SERVICE_PLAN, FUNDING_SOURCE_HS, SUPPLEMENT_REF]);
    const deps = makeDeps({ getFolder: vi.fn(async () => { throw new Error('ISO+ unavailable'); }) });

    const result = await getMonthlyStatementData({ ...baseArgs, query: {} }, deps);

    expect(deps.warn).toHaveBeenCalledWith(
      'Items-Service', 'Failed to fetch folders',
      { message: 'ISO+ unavailable', workspaceId: 'ws_1', boardId: 'bd_1' }, null,
    );
    // With no folder ids the queries are unscoped, so every row in the board is
    // treated as both a budget row and a service row.
    expect(result.budgetItems.total).toBe(6);
    expect(result.serviceItems.total).toBe(6);
  });

  it('rejects a workspace id that is not a plain query value', async () => {
    await expect(
      getMonthlyStatementData({ workspaceId: { $ne: '' }, boardId: 'bd_1', query: {}, req: null }, makeDeps()),
    ).rejects.toThrow('Invalid query value: expected a plain string, number, boolean, or bigint.');
  });

  it('defaults the year to the current one when the query omits it', async () => {
    const result = await getMonthlyStatementData({ ...baseArgs, query: { month: '3' } }, makeDeps());

    expect(result.year).toBe(new Date().getFullYear().toString());
    expect(result.month).toBe('March');
  });

  it('leaves the month blank for an unmapped month number', async () => {
    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '13', year: '2025' } },
      makeDeps(),
    );

    expect(result.month).toBe('13');
    expect(result.monthNumber).toBe('13');
    expect(result.budgetItems.total).toBe(0);
  });

  it('takes budget fallbacks from the participant profile funding stream when no budget rows exist', async () => {
    const fundingStream = doc('fs_hs_detail', 'fld_profiles', {
      'Funding Stream': 'Home Support Quarterly Budget',
      'Total Available Budget for Home Support ($)': '$5,000.00',
      'Remaining Home Support Balance as at the End of the Month ($)': '$4,200.00',
      'Funding End Date': '2026-06-30',
    });
    const profile = doc('pp_1', 'fld_profiles', {
      ...PROFILE.data,
      [A.FUNDING_SOURCE]: ['fs_hs_detail'],
    });
    const shift = doc('svc_only', 'fld_shift', {
      [A.SCHEDULED_START]: '2025-03-06T09:00:00Z',
      [A.PARTICIPANT_PROFILE]: ['pp_1'],
      [A.UNIT]: 'Hour',
      [A.QUANTITY]: '1',
      [A.TOTAL_AMOUNT]: '60',
    });
    await seed([shift, profile, fundingStream]);

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025', ...MARCH_2025_SYDNEY } },
      makeDeps(),
    );

    const hsq = categoryByCode(result, 'HSQ');
    expect(hsq.availableFunds).toBe(5000);
    expect(hsq.totalAvailableBudget).toBe(5000);
    expect(hsq.remainingBudget).toBe(4200);
    expect(hsq.fundingEndDate).toBe('2026-06-30');
  });

  it('reuses a cached budget row instead of recomputing it', async () => {
    await seed([HSQ_BUDGET, PROFILE, FUNDING_SOURCE_HS, SUPPLEMENT_REF]);
    setCachedMSBudget('ws_1', 'bd_1', 'bud_hsq', {
      id: 'bud_hsq',
      categoryCode: 'HSQ',
      folderName: 'Home Support Quarterly Budget',
      month: 'March',
      year: '2025',
      totalAvailableBudget: 42,
      remainingBalance: 7,
    });

    const result = await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025' } },
      makeDeps(),
    );

    expect(result.budgetItems.items['Home Support Quarterly Budget'].items[0].totalAvailableBudget).toBe(42);
    expect(categoryByCode(result, 'HSQ').availableFunds).toBe(42);
    expect(categoryByCode(result, 'HSQ').remainingBudget).toBe(7);
  });

  it('logs the reference-fetch counts it used', async () => {
    await seed([
      HSQ_BUDGET, SERVICE_DELIVERED,
      PROFILE, SERVICE_PLAN, FUNDING_SOURCE_HS, SUPPLEMENT_REF,
    ]);
    const deps = makeDeps();

    await getMonthlyStatementData(
      { ...baseArgs, query: { month: '3', year: '2025', ...MARCH_2025_SYDNEY } },
      deps,
    );

    expect(deps.info).toHaveBeenCalledWith(
      'Items-Service',
      'Bulk fetched participant profiles from DB (monthly-statement budget)',
      { profileIds: 1, foundProfiles: 1 },
      null,
    );
    expect(deps.info).toHaveBeenCalledWith(
      'Items-Service',
      'Bulk fetched participant profiles and funding sources from DB (monthly-statement service processing)',
      { profileIds: 1, foundProfiles: 1, fundingSourceIds: 1, foundFundingSources: 1 },
      null,
    );
    expect(deps.info).toHaveBeenCalledWith(
      'Items-Service',
      'Bulk fetched reference items from DB (monthly-statement service)',
      expect.objectContaining({ servicePlans: 1, participantProfiles: 1, fundingSources: 1 }),
      null,
    );
  });
});

describe('transformMonthlyStatementBudgetItemsBatch', () => {
  const folderIdToName = new Map([
    ['fld_hsq', 'Home Support Quarterly Budget'],
    ['fld_hscm', 'Home Support Care Management Budget'],
  ]);
  const folderIdToCode = { fld_hsq: 'HSQ', fld_hscm: 'HSCM' };

  function batchArgs(rawItems, overrides = {}) {
    return {
      rawItems,
      workspaceId: 'ws_batch',
      boardId: 'bd_batch',
      folderIdToName,
      folderIdToCode,
      ATTRIBUTE_NAMES,
      REF_ATTRIBUTE_NAMES,
      BUDGET_CATEGORY_CONFIG,
      headOfficeTimezone: 'Australia/Sydney',
      bulkFetchReferenceItemsFromDB: vi.fn(async () => new Map([
        ['pp_1', PROFILE],
        [SUPPLEMENT_REF_ID, SUPPLEMENT_REF],
      ])),
      extractRefId,
      extractAllRefIds,
      isUuidLike,
      getParticipantNameFromProfile,
      getReferenceDisplayName,
      getValueFromFlatData,
      ...overrides,
    };
  }

  it('transforms a home support row, resolving the participant and supplement label', async () => {
    const [row] = await transformMonthlyStatementBudgetItemsBatch(batchArgs([HSQ_BUDGET]));

    expect(row.id).toBe('bud_hsq');
    expect(row.categoryCode).toBe('HSQ');
    expect(row.folderName).toBe('Home Support Quarterly Budget');
    expect(row.participantName).toBe('Jane Roe');
    expect(row.participantProfileId).toBe('pp_1');
    expect(row.totalAvailableBudget).toBe(1000);
    expect(row.remainingBalance).toBe(700);
    expect(row.primarySupplementLabel).toBe('Veterans');
    expect(row.fundingStartDate).toBe('2025-01-01');
    expect(row.fundingEndDate).toBe('2025-03-31');
  });

  it('transforms a care-management row using the row date for its month and year', async () => {
    const [row] = await transformMonthlyStatementBudgetItemsBatch(batchArgs([HSCM_BUDGET]));

    expect(row.categoryCode).toBe('HSCM');
    expect(row.month).toBe('March');
    expect(row.year).toBe('2025');
    expect(row.hscmTransactionType).toBe('Allocation');
    expect(row.hscmAllocatedTime).toBe(2.5);
    expect(row.remainingBalance).toBe(250);
  });

  it('reads the month and year of a care-management row in the requested timezone', async () => {
    // 2025-03-01T00:00Z is still 28 February in Los Angeles.
    const lateFebruary = doc('bud_tz', 'fld_hscm', {
      Date: '2025-03-01T00:00:00Z',
      'Received Amount ($)': '100',
    });

    const [sydney] = await transformMonthlyStatementBudgetItemsBatch(batchArgs([lateFebruary]));
    const [losAngeles] = await transformMonthlyStatementBudgetItemsBatch(
      batchArgs([lateFebruary], { headOfficeTimezone: 'America/Los_Angeles' }),
    );

    expect(sydney.month).toBe('March');
    expect(losAngeles.month).toBe('February');
  });

  it('collects every referenced participant profile before transforming', async () => {
    const args = batchArgs([HSQ_BUDGET, HSCM_BUDGET]);

    await transformMonthlyStatementBudgetItemsBatch(args);

    // One call for participant profiles, one for the primary supplement refs.
    expect(args.bulkFetchReferenceItemsFromDB).toHaveBeenCalledTimes(2);
    expect(args.bulkFetchReferenceItemsFromDB.mock.calls[0])
      .toEqual(['ws_batch', 'bd_batch', ['pp_1']]);
    expect(args.bulkFetchReferenceItemsFromDB.mock.calls[1])
      .toEqual(['ws_batch', 'bd_batch', [SUPPLEMENT_REF_ID]]);
  });

  it('returns an empty list without touching the database for no rows', async () => {
    const args = batchArgs([]);

    const rows = await transformMonthlyStatementBudgetItemsBatch(args);

    expect(rows).toEqual([]);
    expect(args.bulkFetchReferenceItemsFromDB).toHaveBeenCalledTimes(1);
    expect(args.bulkFetchReferenceItemsFromDB.mock.calls[0][2]).toEqual([]);
  });

  it('honours an injected cache instead of transforming again', async () => {
    const getCached = vi.fn(() => ({ id: 'cached', categoryCode: 'HSQ' }));
    const setCached = vi.fn();

    const rows = await transformMonthlyStatementBudgetItemsBatch(
      batchArgs([HSQ_BUDGET], { getCachedMSBudget: getCached, setCachedMSBudget: setCached }),
    );

    expect(rows).toEqual([{ id: 'cached', categoryCode: 'HSQ' }]);
    expect(setCached).not.toHaveBeenCalled();
  });

  it('falls back to the configured folder name when the folder id is unknown', async () => {
    const orphan = doc('bud_orphan', 'fld_unknown', {
      [A.MONTH_LABEL]: 'March',
      [A.YEAR_LABEL]: '2025',
      [A.AVAILABLE_FUND_START]: '10',
    });

    const [row] = await transformMonthlyStatementBudgetItemsBatch(batchArgs([orphan]));

    expect(row.categoryCode).toBe('HSQ');
    expect(row.folderName).toBe('Home Support Quarterly Budget');
    expect(row.participantName).toBe('');
    expect(row.participantProfileId).toBeNull();
  });
});
