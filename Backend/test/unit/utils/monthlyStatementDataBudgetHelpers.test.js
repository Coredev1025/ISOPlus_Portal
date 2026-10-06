import { describe, it, expect } from 'vitest';
import {
  getMonthLabelFromDate,
  getYearFromDate,
  transformHscmBudgetItemData,
  transformStandardBudgetItemData,
  transformBudgetItemData,
} from '../../../src/utils/monthlyStatementDataBudgetHelpers.js';
import { getDeliveredAmountForCategoryCode } from '../../../src/utils/monthlyStatementDeliveredHelpers.js';
import { parseFlexibleNumber } from '../../../src/utils/parseFlexibleNumber.js';
import {
  ATTRIBUTE_NAMES,
  FUNDING_SOURCE_TYPES,
} from '../../../src/constants/monthlyStatementAttributes.js';

// Collaborators copied verbatim from the production caller,
// src/services/monthlyStatementData.js (fetchBudgetItems).
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
const parseNumber = parseFlexibleNumber;

const toOutflow = (num) => {
  const n = Number(num);
  if (!Number.isFinite(n) || n === 0) return 0;
  return -Math.abs(n);
};

const isUuidLike = (v) =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

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

const resolveDisplayName = (refItem) => {
  if (!refItem?.data) return '';
  for (const key of ['Funding Stream', 'Primary Supplement', 'Name', 'Full Name/Preferred Name', 'Definition']) {
    const val = getValueFromFlatData(refItem, key);
    if (val) return typeof val === 'object' && val.name ? val.name : String(val);
  }
  return '';
};

const resolveReferenceValue = (value, refMap) => {
  if (!value) return '';
  if (Array.isArray(value)) return value.map((v) => resolveReferenceValue(v, refMap)).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    if (value.name) return value.name;
    if (value.id) return resolveReferenceValue(value.id, refMap);
    return '';
  }
  const str = String(value);
  if (isUuidLike(str) && refMap?.has(str)) return resolveDisplayName(refMap.get(str)) || str;
  return str;
};

const BUDGET_FIELDS = {
  commonwealthUnspent: [
    'Unspent HCP Funds - Commonwealth Portion (Provider-held) ($)',
    'Commonwealth-held HCP Unspent Funds ($)',
  ],
  providerUnspent: [
    'Commonwealth-held HCP Unspent Funds (Notional Home Care Account) ($)',
    'Provider-held HCP Unspent Funds ($)',
  ],
  participantUnspent: [
    'Unspent HCP Funds - Participant Portion (Provider-held) ($)',
    'Participant Portion HCP Unspent Funds ($)',
  ],
};

/** A synced ISO+ budget item: flat `data` map plus the raw `values` array. */
const makeItem = (flatData, extra = {}) => ({
  _id: '65f0000000000000000000dd',
  itemId: extra.itemId ?? 'budget-item-1',
  workspaceId: 'ws-1',
  boardId: 'board-1',
  folderId: extra.folderId ?? 'folder-hsq',
  createdAt: extra.createdAt ?? new Date('2026-03-01T02:00:00.000Z'),
  updatedAt: extra.updatedAt ?? new Date('2026-03-31T02:00:00.000Z'),
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

const PROFILE_MAP = new Map([
  ['profile-1', makeRefItem('profile-1', { 'Full Name/Preferred Name': 'Aroha Ngata' })],
  ['profile-3', makeRefItem('profile-3', { 'Full Name/Preferred Name': 'Bo Tran' })],
]);

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

const resolveParticipant = (item) => {
  const ppId = extractRefId(getValue(item, ATTRIBUTE_NAMES.PARTICIPANT_PROFILE));
  if (ppId) {
    const name = getParticipantName(PROFILE_MAP.get(ppId));
    if (name) return name;
  }
  return getValue(item, ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || '';
};

const resolveParticipantForHSCM = (item) => {
  const ppId = extractRefId(getValue(item, 'Associated Participant'));
  if (ppId) {
    const name = getParticipantName(PROFILE_MAP.get(ppId));
    if (name) return name;
  }
  return getValue(item, ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME) || '';
};

const makeStandardCtx = (code, overrides = {}) => ({
  code,
  folderName: overrides.folderName ?? 'Home Support Quarterly Budget',
  resolveParticipant,
  getValue,
  getValueMulti,
  parseNumber,
  toOutflow,
  extractRefId,
  formatStatus,
  resolveReferenceValue,
  psMap: overrides.psMap ?? new Map(),
  BUDGET_FIELDS,
  getDeliveredAmountForCategoryCode,
  ATTR: ATTRIBUTE_NAMES,
});

const makeHscmCtx = (overrides = {}) => ({
  folderName: overrides.folderName ?? 'Home Support Care Management Budget',
  resolveParticipantForHSCM,
  getValue,
  getValueMulti,
  parseNumber,
  toOutflow,
  extractRefId,
});

describe('getMonthLabelFromDate', () => {
  it('returns the month name for a parseable date', () => {
    expect(getMonthLabelFromDate('2026-03-15T12:00:00')).toBe('March');
    expect(getMonthLabelFromDate('2026-01-01T12:00:00')).toBe('January');
    expect(getMonthLabelFromDate('2026-12-31T12:00:00')).toBe('December');
  });

  it('accepts a Date instance', () => {
    expect(getMonthLabelFromDate(new Date(2026, 6, 4, 12))).toBe('July');
  });

  it('returns an empty string for nullish or empty input', () => {
    expect(getMonthLabelFromDate(null)).toBe('');
    expect(getMonthLabelFromDate(undefined)).toBe('');
    expect(getMonthLabelFromDate('')).toBe('');
    expect(getMonthLabelFromDate(0)).toBe('');
  });

  it('returns an empty string for an unparseable date', () => {
    expect(getMonthLabelFromDate('not-a-date')).toBe('');
    expect(getMonthLabelFromDate('2026-13-45')).toBe('');
  });
});

describe('getYearFromDate', () => {
  it('returns the four-digit year as a string', () => {
    expect(getYearFromDate('2026-03-15T12:00:00')).toBe('2026');
    expect(getYearFromDate(new Date(2025, 11, 31, 12))).toBe('2025');
  });

  it('returns an empty string for nullish or unparseable input', () => {
    expect(getYearFromDate(null)).toBe('');
    expect(getYearFromDate('')).toBe('');
    expect(getYearFromDate('not-a-date')).toBe('');
  });
});

describe('transformHscmBudgetItemData', () => {
  const hscmItem = makeItem(
    {
      'Associated Participant': [{ id: 'profile-3', name: 'ref' }],
      Date: '2026-03-15T12:00:00',
      'Transaction Type': { id: 'tt-1', name: 'Care Management Fee' },
      'Received Amount ($)': '1,000.00',
      'Allocated time (Hr.)': '12.5',
      'Allocated Amount ($-)': '850.25',
      'Net Movement ($)': '149.75',
    },
    { itemId: 'hscm-1', folderId: 'folder-cm' },
  );

  it('maps every HSCM field onto the shared budget shape', () => {
    const result = transformHscmBudgetItemData(hscmItem, makeHscmCtx());

    expect(result.id).toBe('hscm-1');
    expect(result.categoryCode).toBe('HSCM');
    expect(result.folderName).toBe('Home Support Care Management Budget');
    expect(result.participantName).toBe('Bo Tran');
    expect(result.participantProfileId).toBe('profile-3');
    expect(result.month).toBe('March');
    expect(result.year).toBe('2026');
    expect(result.quarter).toBe('');
    expect(result.fundClassification).toBe('Care Management');
    expect(result.hscmDate).toBe('2026-03-15T12:00:00');
    expect(result.hscmTransactionType).toBe('Care Management Fee');
    expect(result.rawData).toBe(hscmItem.data);
    expect(result.updatedAt).toEqual(new Date('2026-03-31T02:00:00.000Z'));
    expect(result.createdAt).toEqual(new Date('2026-03-01T02:00:00.000Z'));
  });

  it('treats the received amount as the available budget and the allocation as an outflow', () => {
    const result = transformHscmBudgetItemData(hscmItem, makeHscmCtx());

    expect(result.totalAvailableBudget).toBe(1000);
    expect(result.availableFundStart).toBe(1000);
    expect(result.hscmReceivedAmount).toBe(1000);
    expect(result.deliveredAmount).toBe(-850.25);
    expect(result.deliveredAmountRaw).toBe(-850.25);
    expect(result.hscmAllocatedAmount).toBe(-850.25);
    expect(result.hscmAllocatedTime).toBe(12.5);
    expect(result.remainingBalance).toBe(149.75);
    expect(result.remainingBalanceEndOfMonth).toBe(149.75);
    expect(result.hscmCurrentBalance).toBe(149.75);
  });

  it('zeroes every field the HSCM shape does not carry', () => {
    const result = transformHscmBudgetItemData(hscmItem, makeHscmCtx());

    expect(result.quarterlyAdjustment).toBe(0);
    expect(result.primarySupplementAmount).toBe(0);
    expect(result.carryoverFunding).toBe(0);
    expect(result.unspentReturned).toBe(0);
    expect(result.commonwealthUnspent).toBe(0);
    expect(result.providerUnspent).toBe(0);
    expect(result.participantUnspent).toBe(0);
    expect(result.previousMonthSpending).toBe(0);
    expect(result.adjustmentAmount).toBe(0);
    expect(result.committedFunds).toBe(0);
    expect(result.fundAmount).toBe(0);
    expect(result.fund).toBe('');
    expect(result.primarySupplementLabel).toBe('');
    expect(result.remainingBalanceAllocationPeriod).toBe(0);
    expect(result.fundingStartDate).toBeNull();
    expect(result.fundingEndDate).toBeNull();
  });

  it('does not clamp a negative net movement', () => {
    const item = makeItem({
      Date: '2026-03-15T12:00:00',
      'Received Amount ($)': '100.00',
      'Allocated Amount ($-)': '250.00',
      'Net Movement ($)': '-150.00',
    });
    const result = transformHscmBudgetItemData(item, makeHscmCtx());
    expect(result.remainingBalance).toBe(-150);
    expect(result.remainingBalanceEndOfMonth).toBe(-150);
    expect(result.hscmCurrentBalance).toBe(-150);
  });

  it('keeps a zero balance as zero rather than falling back', () => {
    const item = makeItem({
      Date: '2026-03-15T12:00:00',
      'Received Amount ($)': '0.00',
      'Allocated Amount ($-)': '0.00',
      'Net Movement ($)': '0',
    });
    const result = transformHscmBudgetItemData(item, makeHscmCtx());
    expect(result.remainingBalance).toBe(0);
    expect(result.hscmCurrentBalance).toBe(0);
    expect(result.deliveredAmount).toBe(0);
    expect(result.totalAvailableBudget).toBe(0);
  });

  it('falls back to a default folder name when none is supplied', () => {
    const result = transformHscmBudgetItemData(hscmItem, makeHscmCtx({ folderName: '' }));
    expect(result.folderName).toBe('Home Support Care Management Budget');
  });

  it('reads the allocated time under the alternate capitalisation', () => {
    const item = makeItem({ Date: '2026-03-15T12:00:00', 'Allocated Time (Hr.)': '3.25' });
    expect(transformHscmBudgetItemData(item, makeHscmCtx()).hscmAllocatedTime).toBe(3.25);
  });

  it('formats the transaction type from an object, a string, an array or nothing', () => {
    const asString = makeItem({ Date: '2026-03-15T12:00:00', 'Transaction Type': 'Deposit' });
    expect(transformHscmBudgetItemData(asString, makeHscmCtx()).hscmTransactionType).toBe('Deposit');

    const asArray = makeItem({ Date: '2026-03-15T12:00:00', 'Transaction Type': ['Deposit'] });
    expect(transformHscmBudgetItemData(asArray, makeHscmCtx()).hscmTransactionType).toBe('Deposit');

    const missing = makeItem({ Date: '2026-03-15T12:00:00' });
    expect(transformHscmBudgetItemData(missing, makeHscmCtx()).hscmTransactionType).toBe('');
  });

  it('leaves the month, year and date blank when the Date attribute is absent', () => {
    const item = makeItem({ 'Received Amount ($)': '10.00' });
    const result = transformHscmBudgetItemData(item, makeHscmCtx());
    expect(result.month).toBe('');
    expect(result.year).toBe('');
    expect(result.hscmDate).toBeNull();
  });

  it('nulls the participant profile id when there is no associated participant', () => {
    const item = makeItem({
      Date: '2026-03-15T12:00:00',
      [ATTRIBUTE_NAMES.PARTICIPANT_FULL_NAME]: 'Walk-in Client',
    });
    const result = transformHscmBudgetItemData(item, makeHscmCtx());
    expect(result.participantProfileId).toBeNull();
    expect(result.participantName).toBe('Walk-in Client');
  });
});

describe('transformStandardBudgetItemData — Home Support quarterly (HSQ)', () => {
  const hsqData = {
    [ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]: [{ id: 'profile-1', name: 'ref' }],
    Month: [{ id: 'm-3', name: 'March' }],
    Year: '2026',
    'FY Quarter': 'Q3',
    'Funding Start Date': '2026-01-01',
    'Funding End Date': '2026-03-31',
    'Available Fund at the Start of the Month ($)': '1,000.00',
    'Classification Quarterly Budget Adjustment ($)': '200.00',
    'Primary Supplement ($)': '150.00',
    'Carryover Funding from the Previous Quarter ($)': '300.00',
    'Unspent HCP Funds - Commonwealth Portion (Provider-held) ($)': '50.00',
    // Only the second provider-unspent alias is present, exercising the fallthrough.
    'Provider-held HCP Unspent Funds ($)': '25.00',
    'Unspent HCP Funds - Participant Portion (Provider-held) ($)': '25.00',
    'Spending from Previous Month(s) within same Quarter ($)': '400.00',
    // Decoy: the allocated-period figure must not be used for HSQ.
    'Spending from Previous Month(s) within Allocated Period ($)': '999.00',
    // Only the ASCII-hyphen alias is present, exercising the fallthrough.
    'Unspent Budget at the End of the Quarter - Returned ($-)': '-100.00',
    'Home Support Delivered During the Month ($-)': '1,200.50',
    'Adjustments from Previous Months [Charges($-)/Refund($)]': '-50.00',
  };

  it('sums the nine components into the total available budget', () => {
    const result = transformStandardBudgetItemData(makeItem(hsqData), makeStandardCtx('HSQ'));

    // 1000 + 200 + 150 + 300 + 50 + 25 + 25 + 400 + (-100)
    expect(result.totalAvailableBudget).toBe(2050);
    expect(result.availableFundStart).toBe(1000);
    expect(result.quarterlyAdjustment).toBe(200);
    expect(result.primarySupplementAmount).toBe(150);
    expect(result.carryoverFunding).toBe(300);
    expect(result.commonwealthUnspent).toBe(50);
    expect(result.providerUnspent).toBe(25);
    expect(result.participantUnspent).toBe(25);
    expect(result.unspentReturned).toBe(-100);
  });

  it('uses the same-quarter spending figure, not the allocated-period one', () => {
    const result = transformStandardBudgetItemData(makeItem(hsqData), makeStandardCtx('HSQ'));
    expect(result.previousMonthSpending).toBe(400);
  });

  it('records the delivered amount as an outflow and the adjustment as signed', () => {
    const result = transformStandardBudgetItemData(makeItem(hsqData), makeStandardCtx('HSQ'));
    expect(result.deliveredAmountRaw).toBe(-1200.5);
    expect(result.deliveredAmount).toBe(-1200.5);
    expect(result.adjustmentAmount).toBe(-50);
  });

  it('computes the closing balance as budget + delivered + adjustment', () => {
    const result = transformStandardBudgetItemData(makeItem(hsqData), makeStandardCtx('HSQ'));
    // 2050 + (-1200.50) + (-50)
    expect(result.remainingBalanceEndOfMonth).toBe(799.5);
    expect(result.remainingBalance).toBe(799.5);
  });

  it('omits the allocation-period balance entirely for HSQ', () => {
    const result = transformStandardBudgetItemData(makeItem(hsqData), makeStandardCtx('HSQ'));
    expect('remainingBalanceAllocationPeriod' in result).toBe(false);
    expect(result.committedFunds).toBe(0);
  });

  it('prefers the board-supplied total over the computed sum', () => {
    const item = makeItem({
      ...hsqData,
      'Total Available Budget for Home Support ($)': '5,000.00',
    });
    const result = transformStandardBudgetItemData(item, makeStandardCtx('HSQ'));
    expect(result.totalAvailableBudget).toBe(5000);
    // 5000 + (-1200.50) + (-50)
    expect(result.remainingBalance).toBe(3749.5);
  });

  it('falls back to the computed sum when the board total is zero', () => {
    const item = makeItem({ ...hsqData, 'Total Available Budget for Home Support ($)': '0.00' });
    const result = transformStandardBudgetItemData(item, makeStandardCtx('HSQ'));
    expect(result.totalAvailableBudget).toBe(2050);
  });

  it('prefers the board-supplied closing balance and clamps it at zero', () => {
    const item = makeItem({
      ...hsqData,
      'Remaining Home Support Balance as at the End of the Month ($)': '-25.00',
    });
    const result = transformStandardBudgetItemData(item, makeStandardCtx('HSQ'));
    expect(result.remainingBalanceEndOfMonth).toBe(0);
    expect(result.remainingBalance).toBe(0);
  });

  it('clamps an overspent computed closing balance at zero', () => {
    const item = makeItem({
      'Total Available Budget for Home Support ($)': '100.00',
      'Home Support Delivered During the Month ($-)': '500.00',
    });
    const result = transformStandardBudgetItemData(item, makeStandardCtx('HSQ'));
    expect(result.deliveredAmountRaw).toBe(-500);
    expect(result.remainingBalanceEndOfMonth).toBe(0);
  });

  it('carries the labels, dates and identifiers through', () => {
    const result = transformStandardBudgetItemData(
      makeItem(hsqData, { itemId: 'hsq-9' }),
      makeStandardCtx('HSQ'),
    );

    expect(result.id).toBe('hsq-9');
    expect(result.categoryCode).toBe('HSQ');
    expect(result.folderName).toBe('Home Support Quarterly Budget');
    expect(result.participantName).toBe('Aroha Ngata');
    expect(result.participantProfileId).toBe('profile-1');
    expect(result.month).toBe('March');
    expect(result.year).toBe('2026');
    expect(result.quarter).toBe('Q3');
    expect(result.fundingStartDate).toBe('2026-01-01');
    expect(result.fundingEndDate).toBe('2026-03-31');
  });

  it('leaves month and year undefined but quarter, fund and classification empty when absent', () => {
    const result = transformStandardBudgetItemData(
      makeItem({ 'Available Fund at the Start of the Month ($)': '10.00' }),
      makeStandardCtx('HSQ'),
    );
    expect(result.month).toBeUndefined();
    expect(result.year).toBeUndefined();
    expect(result.quarter).toBe('');
    expect(result.fund).toBe('');
    expect(result.fundClassification).toBe('');
    expect(result.participantProfileId).toBeNull();
    expect(result.fundingStartDate).toBeNull();
  });

  it('reads the fund amount under either spelling of the attribute', () => {
    const spaced = makeItem({ 'Fund Amount ($)': '1,500.00' });
    expect(transformStandardBudgetItemData(spaced, makeStandardCtx('HSQ')).fundAmount).toBe(1500);

    const unspaced = makeItem({ 'Fund Amount($)': '750.25' });
    expect(transformStandardBudgetItemData(unspaced, makeStandardCtx('HSQ')).fundAmount).toBe(750.25);
  });

  it('resolves a uuid primary-supplement reference through the supplied map', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const psMap = new Map([[uuid, makeRefItem(uuid, { 'Primary Supplement': 'Veterans' })]]);
    const item = makeItem({ 'Primary Supplement': uuid });

    expect(
      transformStandardBudgetItemData(item, makeStandardCtx('HSQ', { psMap })).primarySupplementLabel,
    ).toBe('Veterans');
    expect(
      transformStandardBudgetItemData(item, makeStandardCtx('HSQ')).primarySupplementLabel,
    ).toBe(uuid);
  });

  it('returns the raw funding stream value and the raw data map untouched', () => {
    const item = makeItem({ 'Funding Stream': [{ id: 'fs-1', name: 'Home Care Package' }] });
    const result = transformStandardBudgetItemData(item, makeStandardCtx('HSQ'));
    expect(result.fundingStreamId).toEqual([{ id: 'fs-1', name: 'Home Care Package' }]);
    expect(result.rawData).toBe(item.data);
  });
});

describe('transformStandardBudgetItemData — Assistive Technology short-term (ATS)', () => {
  const atsData = {
    'Available Fund at the Start of the Month ($)': '500.00',
    'Primary Supplement ($)': '100.00',
    'Additional amount approved (AT high tier) ($)': '250.00',
    'Spending from Previous Month(s) within Allocated Period ($)': '75.00',
    // Decoy: the same-quarter figure must not be used for ATS.
    'Spending from Previous Month(s) within same Quarter ($)': '999.00',
    'AT - Short-term Delivered During the Month ($-)': '300.00',
    'Committed AT Short-term Funds - to be delivered ($-)': '200.00',
  };

  it('adds the AT high-tier approval into the computed total', () => {
    const result = transformStandardBudgetItemData(makeItem(atsData), makeStandardCtx('ATS'));
    // 500 + 100 + 250 + 75
    expect(result.totalAvailableBudget).toBe(925);
    expect(result.additionalAmountApproved).toBe(250);
    expect(result.previousMonthSpending).toBe(75);
  });

  it('derives the closing and allocation-period balances from the committed funds', () => {
    const result = transformStandardBudgetItemData(makeItem(atsData), makeStandardCtx('ATS'));

    expect(result.deliveredAmountRaw).toBe(-300);
    expect(result.committedFunds).toBe(-200);
    // 925 - 300 + 0
    expect(result.remainingBalanceEndOfMonth).toBe(625);
    // 625 - 200
    expect(result.remainingBalanceAllocationPeriod).toBe(425);
    expect(result.remainingBalance).toBe(425);
  });

  it('prefers board-supplied balances over the derived ones', () => {
    const item = makeItem({
      ...atsData,
      'Remaining AT - Short-term Balance as at the End of the Month ($)': '700.00',
      'Remaining AT - Short-term Balance for Allocation Period ($)': '450.00',
    });
    const result = transformStandardBudgetItemData(item, makeStandardCtx('ATS'));
    expect(result.remainingBalanceEndOfMonth).toBe(700);
    expect(result.remainingBalanceAllocationPeriod).toBe(450);
    expect(result.remainingBalance).toBe(450);
  });

  it('clamps a negative board-supplied allocation-period balance at zero', () => {
    const item = makeItem({
      ...atsData,
      'Remaining AT - Short-term Balance for Allocation Period ($)': '-40.00',
    });
    expect(
      transformStandardBudgetItemData(item, makeStandardCtx('ATS')).remainingBalanceAllocationPeriod,
    ).toBe(0);
  });

  it('accepts either alias for the board-supplied total', () => {
    const primary = makeItem({
      ...atsData,
      'Total Available Budget for Assistive Technology - Short-term ($)': '1,800.00',
      'Total Available Fund for AT - Short-term ($)': '1,111.00',
    });
    expect(transformStandardBudgetItemData(primary, makeStandardCtx('ATS')).totalAvailableBudget).toBe(1800);

    const alias = makeItem({ ...atsData, 'Total Available Fund for AT - Short-term ($)': '1,111.00' });
    expect(transformStandardBudgetItemData(alias, makeStandardCtx('ATS')).totalAvailableBudget).toBe(1111);
  });
});

describe('transformStandardBudgetItemData — AT ongoing (ATO) and home modification (HMB)', () => {
  it('excludes the AT high-tier approval from the ATO total', () => {
    const item = makeItem({
      'Available Fund at the Start of the Month ($)': '800.00',
      'Primary Supplement ($)': '50.00',
      'Spending from Previous Month(s) within Allocated Period ($)': '25.00',
      // Present but must not be added for ATO.
      'Additional amount approved (AT high tier) ($)': '1,000.00',
      'AT - Ongoing Delivered During the Month ($-)': '175.00',
      'Committed AT Ongoing Funds - to be delivered ($-)': '100.00',
    });
    const result = transformStandardBudgetItemData(item, makeStandardCtx('ATO'));

    // 800 + 50 + 25
    expect(result.totalAvailableBudget).toBe(875);
    expect(result.additionalAmountApproved).toBe(1000);
    expect(result.deliveredAmountRaw).toBe(-175);
    expect(result.committedFunds).toBe(-100);
    // 875 - 175 = 700; 700 - 100 = 600
    expect(result.remainingBalanceEndOfMonth).toBe(700);
    expect(result.remainingBalanceAllocationPeriod).toBe(600);
    expect(result.remainingBalance).toBe(600);
  });

  it('reads the ATO total from the un-hyphenated fund alias', () => {
    const item = makeItem({ 'Total Available Fund for AT Ongoing ($)': '2,400.00' });
    expect(transformStandardBudgetItemData(item, makeStandardCtx('ATO')).totalAvailableBudget).toBe(2400);
  });

  it('uses the home-modification attributes for HMB', () => {
    const item = makeItem({
      'Total Available Fund for HM ($)': '3,000.00',
      'Home Modification Delivered During the Month ($-)': '1,250.00',
      'Committed HM Funds - to be delivered ($-)': '500.00',
      'Remaining HM Balance as at the End of the Month ($)': '1,750.00',
      'Remaining HM Balance for Allocation Period ($)': '1,250.00',
    });
    const result = transformStandardBudgetItemData(item, makeStandardCtx('HMB'));

    expect(result.totalAvailableBudget).toBe(3000);
    expect(result.deliveredAmountRaw).toBe(-1250);
    expect(result.committedFunds).toBe(-500);
    expect(result.remainingBalanceEndOfMonth).toBe(1750);
    expect(result.remainingBalanceAllocationPeriod).toBe(1250);
    expect(result.remainingBalance).toBe(1250);
  });
});

describe('transformStandardBudgetItemData — pathway budgets (RCP, EOL)', () => {
  it('computes the restorative care total without the AT high-tier approval', () => {
    const item = makeItem({
      'Available Fund at the Start of the Month ($)': '400.00',
      'Spending from Previous Month(s) within Allocated Period ($)': '100.00',
      // Present but must not be added for RCP.
      'Additional amount approved (AT high tier) ($)': '500.00',
      'Restorative Care Delivered During the Month ($-)': '120.00',
    });
    const result = transformStandardBudgetItemData(item, makeStandardCtx('RCP'));

    // 400 + 0 + 100
    expect(result.totalAvailableBudget).toBe(500);
    expect(result.deliveredAmountRaw).toBe(-120);
    expect(result.remainingBalanceEndOfMonth).toBe(380);
    expect(result.remainingBalance).toBe(380);
  });

  it('has no allocation-period balance and no committed funds for RCP', () => {
    const item = makeItem({ 'Available Fund at the Start of the Month ($)': '400.00' });
    const result = transformStandardBudgetItemData(item, makeStandardCtx('RCP'));
    expect('remainingBalanceAllocationPeriod' in result).toBe(false);
    expect(result.committedFunds).toBe(0);
  });

  it('reads the restorative-care-specific closing balance attribute', () => {
    const item = makeItem({
      'Available Fund at the Start of the Month ($)': '400.00',
      'Remaining Restorative Care Balance as at the End of the Month ($)': '333.00',
      // Decoy: the Home Support attribute must be ignored for RCP.
      'Remaining Home Support Balance as at the End of the Month ($)': '111.00',
    });
    expect(transformStandardBudgetItemData(item, makeStandardCtx('RCP')).remainingBalance).toBe(333);
  });

  it('reads the end-of-life-specific attributes for EOL', () => {
    const item = makeItem({
      'Total Available Fund for End-of-Life Care ($)': '2,000.00',
      'End-of-Life Care Delivered During the Month ($-)': '640.40',
      'Remaining End-of-Life Care Balance as at the End of the Month ($)': '1,359.60',
    });
    const result = transformStandardBudgetItemData(item, makeStandardCtx('EOL'));

    expect(result.totalAvailableBudget).toBe(2000);
    expect(result.deliveredAmountRaw).toBe(-640.4);
    expect(result.remainingBalance).toBe(1359.6);
    expect('remainingBalanceAllocationPeriod' in result).toBe(false);
  });
});

describe('transformStandardBudgetItemData — unmapped category code', () => {
  it('treats an unknown code like Home Support without the quarterly sum', () => {
    const item = makeItem({
      'Available Fund at the Start of the Month ($)': '750.00',
      'Classification Quarterly Budget Adjustment ($)': '200.00',
      'Spending from Previous Month(s) within same Quarter ($)': '25.00',
      'Home Support Delivered During the Month ($-)': '250.00',
      'Committed AT Short-term Funds - to be delivered ($-)': '999.00',
    });
    const result = transformStandardBudgetItemData(item, makeStandardCtx('ZZZ'));

    expect(result.categoryCode).toBe('ZZZ');
    expect(result.totalAvailableBudget).toBe(750);
    expect(result.deliveredAmountRaw).toBe(-250);
    expect(result.committedFunds).toBe(0);
    expect(result.previousMonthSpending).toBe(25);
    expect(result.remainingBalanceEndOfMonth).toBe(500);
    expect('remainingBalanceAllocationPeriod' in result).toBe(false);
  });

  it('falls back to a zero total when the opening fund is missing', () => {
    const result = transformStandardBudgetItemData(makeItem({ Month: 'March' }), makeStandardCtx('ZZZ'));
    expect(result.totalAvailableBudget).toBe(0);
    expect(result.remainingBalanceEndOfMonth).toBe(0);
  });
});

describe('transformBudgetItemData — routing', () => {
  const baseCtx = {
    ...makeStandardCtx('HSQ'),
    resolveParticipantForHSCM,
    folderIdToCode: { 'folder-hsq': 'HSQ', 'folder-ats': 'ATS', 'folder-cm': 'HSCM' },
    folderIdToName: new Map([
      ['folder-hsq', FUNDING_SOURCE_TYPES.HOME_SUPPORT],
      ['folder-ats', FUNDING_SOURCE_TYPES.ASSISTIVE_TECH_SHORT],
      ['folder-cm', 'Home Support Care Management Budget'],
    ]),
  };

  it('routes a care-management folder to the HSCM shape', () => {
    const item = makeItem(
      {
        'Associated Participant': [{ id: 'profile-3', name: 'ref' }],
        Date: '2026-03-15T12:00:00',
        'Received Amount ($)': '900.00',
        'Allocated Amount ($-)': '400.00',
        'Net Movement ($)': '500.00',
      },
      { folderId: 'folder-cm' },
    );
    const result = transformBudgetItemData(item, baseCtx);

    expect(result.categoryCode).toBe('HSCM');
    expect(result.folderName).toBe('Home Support Care Management Budget');
    expect(result.hscmReceivedAmount).toBe(900);
    expect(result.deliveredAmount).toBe(-400);
    expect(result.remainingBalance).toBe(500);
  });

  it('matches the care-management folder name case-insensitively', () => {
    const ctx = {
      ...baseCtx,
      folderIdToCode: { 'folder-cm': 'HSQ' },
      folderIdToName: new Map([['folder-cm', '2026 HOME SUPPORT CARE MANAGEMENT BUDGET (AC)']]),
    };
    const item = makeItem({ Date: '2026-03-15T12:00:00' }, { folderId: 'folder-cm' });
    const result = transformBudgetItemData(item, ctx);

    expect(result.categoryCode).toBe('HSCM');
    expect(result.folderName).toBe('2026 HOME SUPPORT CARE MANAGEMENT BUDGET (AC)');
  });

  it('routes any other folder to the standard shape with its mapped code', () => {
    const item = makeItem(
      {
        'Available Fund at the Start of the Month ($)': '500.00',
        'Primary Supplement ($)': '100.00',
        'Additional amount approved (AT high tier) ($)': '250.00',
        'Spending from Previous Month(s) within Allocated Period ($)': '75.00',
      },
      { folderId: 'folder-ats' },
    );
    const result = transformBudgetItemData(item, baseCtx);

    expect(result.categoryCode).toBe('ATS');
    expect(result.folderName).toBe(FUNDING_SOURCE_TYPES.ASSISTIVE_TECH_SHORT);
    expect(result.totalAvailableBudget).toBe(925);
  });

  it('defaults an unmapped folder to HSQ with an empty folder name', () => {
    const item = makeItem(
      { 'Available Fund at the Start of the Month ($)': '600.00' },
      { folderId: 'folder-unknown' },
    );
    const result = transformBudgetItemData(item, baseCtx);

    expect(result.categoryCode).toBe('HSQ');
    expect(result.folderName).toBe('');
    expect(result.totalAvailableBudget).toBe(600);
  });
});
