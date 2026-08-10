import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseMonthlyStatementNumberValue,
  normalizeAttributeNames,
  createMonthlyStatementItemAccessors,
  transformMonthlyStatementBudgetItem,
  determineCategoryCodeForBudgetItem,
  determineCategoryCodeForService,
} from '../../../src/utils/monthlyStatementBudgetTransformHelpers.js';
import {
  ATTRIBUTE_NAMES,
  REF_ATTRIBUTE_NAMES,
  BUDGET_CATEGORY_CONFIG,
} from '../../../src/constants/monthlyStatementAttributes.js';

// ---------------------------------------------------------------------------
// Collaborators wired exactly as the production caller wires them
// (src/utils/monthlyStatementRouteHelpers.js -> createItemDataHelpers()).
// ---------------------------------------------------------------------------

const getValueFromItemMulti = (item, attributeNames) => {
  const candidateNames = normalizeAttributeNames(attributeNames);
  if (!item?.data || candidateNames.length === 0) return null;
  for (const name of candidateNames) {
    const value = item.data[name];
    if (value !== undefined && value !== null) return value;
  }
  return null;
};

const accessors = createMonthlyStatementItemAccessors({
  getValueFromItemMulti,
  parseNumberValue: parseMonthlyStatementNumberValue,
});

/** A synced ISO+ budget item: flat `data` map plus the raw `values` array. */
const makeItem = (flatData, extra = {}) => ({
  _id: '65f0000000000000000000ab',
  itemId: extra.itemId ?? 'budget-item-1',
  workspaceId: 'ws-1',
  boardId: 'board-1',
  folderId: extra.folderId ?? 'folder-hsq',
  createdAt: extra.createdAt ?? new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: extra.updatedAt ?? new Date('2026-06-20T00:00:00.000Z'),
  data: {
    ...flatData,
    values: Object.entries(flatData).map(([name, data], index) => ({
      id: `value-${index}`,
      attribute: { id: `attr-${index}`, name },
      data,
    })),
  },
});

const monthLabels = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Copied from createBudgetDateHelpers() in monthlyStatementRouteHelpers.js. */
const makeDateHelpers = (stmtTimezone) => ({
  getMonthLabelFromDate: (dateValue) => {
    if (!dateValue) return '';
    const date = new Date(dateValue);
    if (isNaN(date.getTime())) return '';
    const monthNum = parseInt(
      new Intl.DateTimeFormat('en-AU', { timeZone: stmtTimezone, month: 'numeric' }).format(date),
      10,
    );
    return monthLabels[monthNum - 1] || '';
  },
  getYearFromDate: (dateValue) => {
    if (!dateValue) return '';
    const date = new Date(dateValue);
    if (isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-AU', { timeZone: stmtTimezone, year: 'numeric' }).format(date);
  },
});

const PARTICIPANT_NAMES = {
  'pp-1': 'Margaret Chen',
  'pp-2': 'Ravi Patel',
};

let setCachedMSBudget;
let getCachedMSBudget;

const makeContext = (overrides = {}) => {
  const { getMonthLabelFromDate, getYearFromDate } = makeDateHelpers(
    overrides.timezone ?? 'Australia/Sydney',
  );
  return {
    workspaceId: 'ws-1',
    boardId: 'board-1',
    folderIdToName: overrides.folderIdToName ?? new Map([
      ['folder-hsq', 'Home Support Quarterly Budget'],
      ['folder-hscm', 'Home Support Care Management Budget'],
      ['folder-ats', 'Assistive Technology - Short-term Budget'],
      ['folder-rcp', 'Restorative Care Pathway Budget'],
    ]),
    folderIdToCode: overrides.folderIdToCode ?? {
      'folder-hsq': 'HSQ',
      'folder-hscm': 'HSCM',
      'folder-ats': 'ATS',
      'folder-rcp': 'RCP',
    },
    BUDGET_CATEGORY_CONFIG,
    ATTRIBUTE_NAMES,
    REF_ATTRIBUTE_NAMES,
    accessors,
    getValueFromItemMulti,
    parseNumberValue: parseMonthlyStatementNumberValue,
    resolveParticipantName: (value) => {
      const id = Array.isArray(value) ? value[0] : value;
      return PARTICIPANT_NAMES[id] || '';
    },
    resolveReferenceValue: (value, refMap) => {
      if (!value) return '';
      const id = Array.isArray(value) ? value[0] : value;
      return refMap?.get(id) ?? String(id);
    },
    primarySupplementMap: overrides.primarySupplementMap ?? new Map([['ps-1', 'Veterans']]),
    getCachedMSBudget: overrides.getCachedMSBudget ?? getCachedMSBudget,
    setCachedMSBudget: overrides.setCachedMSBudget ?? setCachedMSBudget,
    getFirstReferenceId: accessors.getFirstReferenceId,
    getNumberFromItem: accessors.getNumberFromItem,
    getMonthLabelFromDate,
    getYearFromDate,
    determineCategoryCodeForBudget: (item) =>
      determineCategoryCodeForBudgetItem(
        item,
        overrides.folderIdToCode ?? {
          'folder-hsq': 'HSQ',
          'folder-hscm': 'HSCM',
          'folder-ats': 'ATS',
          'folder-rcp': 'RCP',
        },
        () => null,
        ATTRIBUTE_NAMES,
      ),
    ...(overrides.extra ?? {}),
  };
};

beforeEach(() => {
  setCachedMSBudget = vi.fn();
  getCachedMSBudget = vi.fn(() => null);
});

// ---------------------------------------------------------------------------

describe('parseMonthlyStatementNumberValue', () => {
  it('treats null and undefined as zero', () => {
    expect(parseMonthlyStatementNumberValue(null)).toBe(0);
    expect(parseMonthlyStatementNumberValue(undefined)).toBe(0);
  });

  it('returns finite numbers unchanged, including zero and negatives', () => {
    expect(parseMonthlyStatementNumberValue(1234.56)).toBe(1234.56);
    expect(parseMonthlyStatementNumberValue(0)).toBe(0);
    expect(parseMonthlyStatementNumberValue(-99.5)).toBe(-99.5);
  });

  it('collapses non-finite numbers to zero', () => {
    expect(parseMonthlyStatementNumberValue(NaN)).toBe(0);
    expect(parseMonthlyStatementNumberValue(Infinity)).toBe(0);
    expect(parseMonthlyStatementNumberValue(-Infinity)).toBe(0);
  });

  it('reads the first entry of an array and recurses into it', () => {
    expect(parseMonthlyStatementNumberValue(['$1,500.25', '$9.99'])).toBe(1500.25);
    expect(parseMonthlyStatementNumberValue([[42]])).toBe(42);
  });

  it('returns zero for an empty array and for non-string non-number values', () => {
    expect(parseMonthlyStatementNumberValue([])).toBe(0);
    expect(parseMonthlyStatementNumberValue({ amount: 12 })).toBe(0);
    expect(parseMonthlyStatementNumberValue(true)).toBe(0);
  });

  it('strips currency symbols, thousands separators and stray text', () => {
    expect(parseMonthlyStatementNumberValue('$1,234.50')).toBe(1234.5);
    expect(parseMonthlyStatementNumberValue(' 2 340.75 AUD ')).toBe(2340.75);
  });

  it('reads parentheses as a negative amount', () => {
    expect(parseMonthlyStatementNumberValue('($250.00)')).toBe(-250);
  });

  it('reads a trailing minus as a negative amount', () => {
    expect(parseMonthlyStatementNumberValue('300.00-')).toBe(-300);
    expect(parseMonthlyStatementNumberValue('300.00- ')).toBe(-300);
  });

  it('normalises the unicode minus signs ISO+ exports produce', () => {
    expect(parseMonthlyStatementNumberValue('−450.10')).toBe(-450.1);
    expect(parseMonthlyStatementNumberValue('–75')).toBe(-75);
  });

  it('leaves an already-negative parenthesised value negative rather than flipping it', () => {
    expect(parseMonthlyStatementNumberValue('(-20)')).toBe(-20);
  });

  it('returns zero for blank and unparseable strings', () => {
    expect(parseMonthlyStatementNumberValue('')).toBe(0);
    expect(parseMonthlyStatementNumberValue('   ')).toBe(0);
    expect(parseMonthlyStatementNumberValue('N/A')).toBe(0);
    expect(parseMonthlyStatementNumberValue('abc-')).toBe(0);
  });
});

describe('normalizeAttributeNames', () => {
  it('keeps only non-blank strings from an array', () => {
    expect(normalizeAttributeNames(['A', '', '  ', null, 7, 'B'])).toEqual(['A', 'B']);
  });

  it('wraps a single non-blank string', () => {
    expect(normalizeAttributeNames('Fund Amount ($)')).toEqual(['Fund Amount ($)']);
  });

  it('returns an empty list for blank, null and non-string input', () => {
    expect(normalizeAttributeNames('   ')).toEqual([]);
    expect(normalizeAttributeNames(null)).toEqual([]);
    expect(normalizeAttributeNames(undefined)).toEqual([]);
    expect(normalizeAttributeNames(42)).toEqual([]);
  });
});

describe('createMonthlyStatementItemAccessors', () => {
  const item = makeItem({
    Amount: '($1,234.50)',
    Month: [{ id: 'o1', name: 'June' }],
    Year: '2026',
    Codes: ['A1', 'A2'],
    Classification: { id: 'c1', name: 'Care Management' },
    'Funding Start Date': '2026-04-01',
    Numeric: 12,
    Empty: [],
    Blank: null,
  });

  it('parses numbers through the injected parseNumberValue', () => {
    expect(accessors.getNumberFromItem(item, 'Amount')).toBe(-1234.5);
    expect(accessors.getNumberFromItem(item, 'Missing')).toBe(0);
  });

  it('falls through a list of candidate attribute names in order', () => {
    expect(accessors.getNumberFromItem(item, ['Missing', 'Amount'])).toBe(-1234.5);
  });

  it('getLabelFromItem reads names from option arrays, option objects and plain strings', () => {
    expect(accessors.getLabelFromItem(item, 'Month')).toBe('June');
    expect(accessors.getLabelFromItem(item, 'Classification')).toBe('Care Management');
    expect(accessors.getLabelFromItem(item, 'Year')).toBe('2026');
    expect(accessors.getLabelFromItem(item, 'Codes')).toBe('A1');
  });

  it('getLabelFromItem returns null for missing values, numbers and empty arrays', () => {
    expect(accessors.getLabelFromItem(item, 'Blank')).toBeNull();
    expect(accessors.getLabelFromItem(item, 'Numeric')).toBeNull();
    expect(accessors.getLabelFromItem(item, 'Empty')).toBeNull();
  });

  it('getDateFromItem accepts only strings', () => {
    expect(accessors.getDateFromItem(item, 'Funding Start Date')).toBe('2026-04-01');
    expect(accessors.getDateFromItem(item, 'Month')).toBeNull();
    expect(accessors.getDateFromItem(item, 'Missing')).toBeNull();
  });

  it('getTextFromItem stringifies, and returns an empty string when absent', () => {
    expect(accessors.getTextFromItem(item, 'Year')).toBe('2026');
    expect(accessors.getTextFromItem(item, 'Numeric')).toBe('12');
    expect(accessors.getTextFromItem(item, 'Codes')).toBe('A1');
    expect(accessors.getTextFromItem(item, 'Missing')).toBe('');
    expect(accessors.getTextFromItem(item, 'Empty')).toBe('');
  });

  it('getFirstReferenceId returns the first id of a reference array or the bare string', () => {
    expect(accessors.getFirstReferenceId(item, 'Codes')).toBe('A1');
    expect(accessors.getFirstReferenceId(item, 'Year')).toBe('2026');
    expect(accessors.getFirstReferenceId(item, 'Classification')).toBeNull();
    expect(accessors.getFirstReferenceId(item, 'Missing')).toBeNull();
  });
});

describe('determineCategoryCodeForBudgetItem', () => {
  const folderIdToCode = { 'folder-ats': 'ATS', 'folder-rcp': 'RCP' };

  it('maps a known folder id to its category code', () => {
    expect(
      determineCategoryCodeForBudgetItem({ folderId: 'folder-ats' }, folderIdToCode, () => null, ATTRIBUTE_NAMES),
    ).toBe('ATS');
    expect(
      determineCategoryCodeForBudgetItem({ folderId: 'folder-rcp' }, folderIdToCode, () => null, ATTRIBUTE_NAMES),
    ).toBe('RCP');
  });

  it('defaults to HSQ for an unmapped folder, a missing folder and a null item', () => {
    expect(
      determineCategoryCodeForBudgetItem({ folderId: 'folder-unknown' }, folderIdToCode, () => null, ATTRIBUTE_NAMES),
    ).toBe('HSQ');
    expect(determineCategoryCodeForBudgetItem({}, folderIdToCode, () => null, ATTRIBUTE_NAMES)).toBe('HSQ');
    expect(determineCategoryCodeForBudgetItem(null, folderIdToCode, () => null, ATTRIBUTE_NAMES)).toBe('HSQ');
  });

  it('still returns HSQ when a funding stream is present (the funding-stream branch is a no-op)', () => {
    const getValueFromFlatData = vi.fn(() => ['fs-assistive-short-term']);
    expect(
      determineCategoryCodeForBudgetItem({ folderId: 'unknown' }, folderIdToCode, getValueFromFlatData, ATTRIBUTE_NAMES),
    ).toBe('HSQ');
    expect(getValueFromFlatData).toHaveBeenCalledWith({ folderId: 'unknown' }, ATTRIBUTE_NAMES.FUNDING_STREAM);
  });
});

describe('determineCategoryCodeForService', () => {
  it('matches restorative care ahead of everything else', () => {
    expect(determineCategoryCodeForService({ fundingSource: 'Restorative Care Pathway' })).toBe('RCP');
    expect(determineCategoryCodeForService({ notes: 'restorative care top-up' })).toBe('RCP');
  });

  it('matches both spellings of end-of-life', () => {
    expect(determineCategoryCodeForService({ fundingSource: 'End-of-Life Pathway' })).toBe('EOL');
    expect(determineCategoryCodeForService({ service: 'End of Life care' })).toBe('EOL');
  });

  it('separates assistive technology short-term from ongoing', () => {
    expect(determineCategoryCodeForService({ fundingSource: 'Assistive Technology - Short-term' })).toBe('ATS');
    expect(determineCategoryCodeForService({ fundingSource: 'Assistive Technology - Ongoing' })).toBe('ATO');
  });

  it('requires both the assistive and the period keyword before choosing ATS or ATO', () => {
    expect(determineCategoryCodeForService({ fundingSource: 'Short-term loan' })).toBe('HSQ');
    expect(determineCategoryCodeForService({ fundingSource: 'Assistive Technology' })).toBe('HSQ');
  });

  it('matches home modification', () => {
    expect(determineCategoryCodeForService({ fundingSource: 'Home Modification Budget' })).toBe('HMB');
  });

  it('matches home support and hsq', () => {
    expect(determineCategoryCodeForService({ fundingSource: 'Home Support Quarterly Budget' })).toBe('HSQ');
    expect(determineCategoryCodeForService({ notes: 'HSQ carryover' })).toBe('HSQ');
  });

  it('searches fundingSource, service and notes together and defaults to HSQ', () => {
    expect(determineCategoryCodeForService({ fundingSource: '', service: '', notes: 'modification of bathroom' })).toBe('HMB');
    expect(determineCategoryCodeForService({ fundingSource: 'Unclassified' })).toBe('HSQ');
    expect(determineCategoryCodeForService({})).toBe('HSQ');
    expect(determineCategoryCodeForService()).toBe('HSQ');
  });

  it('ignores null fields rather than throwing', () => {
    expect(determineCategoryCodeForService({ fundingSource: null, service: undefined, notes: 0 })).toBe('HSQ');
  });
});

describe('transformMonthlyStatementBudgetItem — cache short-circuit', () => {
  it('returns the cached record and skips transformation entirely', () => {
    const cached = { id: 'budget-item-1', categoryCode: 'HSQ', totalAvailableBudget: 4242 };
    const determineCategoryCodeForBudget = vi.fn(() => 'HSQ');
    const item = makeItem({ [ATTRIBUTE_NAMES.AVAILABLE_FUND_START]: 100 });

    const result = transformMonthlyStatementBudgetItem(item, makeContext({
      getCachedMSBudget: vi.fn(() => cached),
      extra: { determineCategoryCodeForBudget },
    }));

    expect(result).toBe(cached);
    expect(determineCategoryCodeForBudget).not.toHaveBeenCalled();
    expect(setCachedMSBudget).not.toHaveBeenCalled();
  });

  it('passes the item id and its updatedAt to the cache lookup, falling back to createdAt', () => {
    const getCached = vi.fn(() => null);
    const withUpdated = makeItem({}, { itemId: 'b-1', updatedAt: new Date('2026-06-20T00:00:00.000Z') });
    const noUpdated = {
      itemId: 'b-2',
      folderId: 'folder-hsq',
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      updatedAt: undefined,
      data: {},
    };

    transformMonthlyStatementBudgetItem(withUpdated, makeContext({ getCachedMSBudget: getCached }));
    transformMonthlyStatementBudgetItem(noUpdated, makeContext({ getCachedMSBudget: getCached }));

    expect(getCached).toHaveBeenNthCalledWith(1, 'ws-1', 'board-1', 'b-1', new Date('2026-06-20T00:00:00.000Z'));
    expect(getCached).toHaveBeenNthCalledWith(2, 'ws-1', 'board-1', 'b-2', new Date('2026-05-05T00:00:00.000Z'));
  });
});

describe('transformMonthlyStatementBudgetItem — Home Support Quarterly (HSQ)', () => {
  const hsqItem = makeItem({
    [ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]: ['pp-1'],
    [ATTRIBUTE_NAMES.AVAILABLE_FUND_START]: '$1,200.00',
    [ATTRIBUTE_NAMES.QUARTERLY_ADJUSTMENT]: '50',
    [ATTRIBUTE_NAMES.PRIMARY_SUPPLEMENT_AMOUNT]: 100,
    [ATTRIBUTE_NAMES.CARRYOVER_FUNDING]: 200,
    [ATTRIBUTE_NAMES.UNSPENT_BUDGET_RETURNED]: '(25)',
    'Commonwealth-held HCP Unspent Funds ($)': 10,
    'Provider-held HCP Unspent Funds ($)': 20,
    'Participant Portion HCP Unspent Funds ($)': 30,
    [ATTRIBUTE_NAMES.PREVIOUS_MONTH_SPENDING]: '-40',
    [ATTRIBUTE_NAMES.HOME_SUPPORT_DELIVERED]: '-300',
    [ATTRIBUTE_NAMES.HOME_SUPPORT_ADJUSTMENTS]: '-5',
    [ATTRIBUTE_NAMES.MONTH_LABEL]: [{ id: 'm6', name: 'June' }],
    [ATTRIBUTE_NAMES.YEAR_LABEL]: '2026',
    [ATTRIBUTE_NAMES.FY_QUARTER]: [{ id: 'q4', name: 'Q4' }],
    [ATTRIBUTE_NAMES.FUNDING_START_DATE]: '2026-04-01',
    [ATTRIBUTE_NAMES.FUNDING_END_DATE]: '2026-06-30',
    [ATTRIBUTE_NAMES.FUND_CLASSIFICATION]: [{ id: 'fc1', name: 'Classification 4' }],
    [ATTRIBUTE_NAMES.FUND_AMOUNT]: '$75.00',
    [ATTRIBUTE_NAMES.FUND_TEXT]: 'HCP Level 4',
    [ATTRIBUTE_NAMES.FUNDING_STREAM]: ['fs-hs'],
    'Primary Supplement': ['ps-1'],
  }, { folderId: 'folder-hsq', itemId: 'hsq-1' });

  it('sums the nine HSQ funding components into totalAvailableBudget', () => {
    const result = transformMonthlyStatementBudgetItem(hsqItem, makeContext());

    // 1200 + 50 + 100 + 200 + 10 + 20 + 30 + (-40) + (-25)
    expect(result.totalAvailableBudget).toBe(1545);
    expect(result.availableFundStart).toBe(1200);
    expect(result.quarterlyAdjustment).toBe(50);
    expect(result.carryoverFunding).toBe(200);
    expect(result.unspentReturned).toBe(-25);
    expect(result.commonwealthUnspent).toBe(10);
    expect(result.providerUnspent).toBe(20);
    expect(result.participantUnspent).toBe(30);
    expect(result.previousMonthSpending).toBe(-40);
  });

  it('prefers the stored Total Available Budget for Home Support over the computed sum', () => {
    const withStoredTotal = makeItem({
      ...Object.fromEntries(Object.entries(hsqItem.data).filter(([key]) => key !== 'values')),
      [ATTRIBUTE_NAMES.TOTAL_AVAILABLE_HOME_SUPPORT]: '$1,600.00',
    }, { folderId: 'folder-hsq', itemId: 'hsq-1' });

    expect(transformMonthlyStatementBudgetItem(withStoredTotal, makeContext()).totalAvailableBudget).toBe(1600);
  });

  it('derives the remaining balance from total + delivered + adjustment when no stored balance exists', () => {
    const result = transformMonthlyStatementBudgetItem(hsqItem, makeContext());

    // max(0, 1545 + (-300) + (-5))
    expect(result.remainingBalanceEndOfMonth).toBe(1240);
    expect(result.remainingBalance).toBe(1240);
    expect(result.deliveredAmount).toBe(-300);
    expect(result.deliveredAmountRaw).toBe(-300);
    expect(result.adjustmentAmount).toBe(-5);
    expect(result).not.toHaveProperty('remainingBalanceAllocationPeriod');
  });

  it('prefers the stored end-of-month balance and floors it at zero', () => {
    const overspent = makeItem({
      [ATTRIBUTE_NAMES.AVAILABLE_FUND_START]: 1000,
      [ATTRIBUTE_NAMES.REMAINING_HOME_SUPPORT_BALANCE]: '($120.00)',
    }, { folderId: 'folder-hsq' });

    const result = transformMonthlyStatementBudgetItem(overspent, makeContext());
    expect(result.remainingBalanceEndOfMonth).toBe(0);
    expect(result.remainingBalance).toBe(0);
  });

  it('carries the labels, dates, participant and reference values through', () => {
    const result = transformMonthlyStatementBudgetItem(hsqItem, makeContext());

    expect(result).toMatchObject({
      id: 'hsq-1',
      categoryCode: 'HSQ',
      folderName: 'Home Support Quarterly Budget',
      participantName: 'Margaret Chen',
      participantProfileId: 'pp-1',
      month: 'June',
      year: '2026',
      quarter: 'Q4',
      fundingStartDate: '2026-04-01',
      fundingEndDate: '2026-06-30',
      primarySupplementLabel: 'Veterans',
      fundClassification: 'Classification 4',
      fundAmount: 75,
      fund: 'HCP Level 4',
      committedFunds: 0,
      fundingStreamId: 'fs-hs',
    });
    expect(result.rawData).toBe(hsqItem.data);
  });

  it('writes the transformed record to the cache under the item id', () => {
    const result = transformMonthlyStatementBudgetItem(hsqItem, makeContext());
    expect(setCachedMSBudget).toHaveBeenCalledWith('ws-1', 'board-1', 'hsq-1', result);
  });

  it('leaves participantProfileId null when the item has no participant reference', () => {
    const orphan = makeItem({ [ATTRIBUTE_NAMES.AVAILABLE_FUND_START]: 10 }, { folderId: 'folder-hsq' });
    const result = transformMonthlyStatementBudgetItem(orphan, makeContext());

    expect(result.participantProfileId).toBeNull();
    expect(result.participantName).toBe('');
  });
});

describe('transformMonthlyStatementBudgetItem — allocation-period categories (ATS)', () => {
  const atsData = {
    [ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]: ['pp-1'],
    [ATTRIBUTE_NAMES.AVAILABLE_FUND_START]: 500,
    [ATTRIBUTE_NAMES.ADDITIONAL_AMOUNT_APPROVED_AT]: 250,
    [ATTRIBUTE_NAMES.PREVIOUS_MONTH_SPENDING]: 999,
    [ATTRIBUTE_NAMES.PREVIOUS_MONTH_SPENDING_ALLOCATED_PERIOD]: '-100',
    'Assistive Technology - Short-term Delivered During the Month ($-)': '-150',
    [ATTRIBUTE_NAMES.COMMITTED_AT_SHORT_TERM]: 75,
  };

  it('uses the allocated-period spending, not the same-quarter spending', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem(atsData, { folderId: 'folder-ats' }),
      makeContext(),
    );
    expect(result.previousMonthSpending).toBe(-100);
  });

  it('falls back to start + supplement + additional approved + allocated spending', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem(atsData, { folderId: 'folder-ats' }),
      makeContext(),
    );
    // 500 + 0 + 250 + (-100)
    expect(result.totalAvailableBudget).toBe(650);
    expect(result.additionalAmountApproved).toBe(250);
  });

  it('prefers the stored AT short-term total budget over the fallback sum', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem({ ...atsData, [REF_ATTRIBUTE_NAMES.TOTAL_BUDGET_AT_SHORT_TERM]: '$900.00' }, { folderId: 'folder-ats' }),
      makeContext(),
    );
    expect(result.totalAvailableBudget).toBe(900);
  });

  it('accepts the "Total Available Fund" alias when the "Total Available Budget" attribute is absent', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem({ ...atsData, [REF_ATTRIBUTE_NAMES.TOTAL_FUND_AT_SHORT_TERM]: 880 }, { folderId: 'folder-ats' }),
      makeContext(),
    );
    expect(result.totalAvailableBudget).toBe(880);
  });

  it('derives the allocation-period balance as end-of-month balance + committed funds', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem(atsData, { folderId: 'folder-ats' }),
      makeContext(),
    );

    // end of month: max(0, 650 + (-150) + 0) = 500; allocation period: max(0, 500 + 75)
    expect(result.remainingBalanceEndOfMonth).toBe(500);
    expect(result.remainingBalanceAllocationPeriod).toBe(575);
    expect(result.remainingBalance).toBe(575);
    expect(result.committedFunds).toBe(75);
    expect(result.deliveredAmount).toBe(-150);
  });

  it('prefers the stored allocation-period balance and floors it at zero', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem({ ...atsData, [REF_ATTRIBUTE_NAMES.REMAINING_AT_SHORT_TERM]: '(-20)' }, { folderId: 'folder-ats' }),
      makeContext(),
    );
    expect(result.remainingBalanceAllocationPeriod).toBe(0);
    expect(result.remainingBalance).toBe(0);
    expect(result.remainingBalanceEndOfMonth).toBe(500);
  });

  it('prefers the stored end-of-month balance for the allocation-period arithmetic', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem(
        { ...atsData, [REF_ATTRIBUTE_NAMES.REMAINING_AT_SHORT_TERM_END_OF_MONTH]: '$400.00' },
        { folderId: 'folder-ats' },
      ),
      makeContext(),
    );
    expect(result.remainingBalanceEndOfMonth).toBe(400);
    expect(result.remainingBalanceAllocationPeriod).toBe(475);
  });

  it('reads the third delivered-amount alias that carries no ($-) suffix', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem(
        {
          [ATTRIBUTE_NAMES.AVAILABLE_FUND_START]: 500,
          'Assistive Technology - Short-term Delivered During the Month': '-60',
        },
        { folderId: 'folder-ats' },
      ),
      makeContext(),
    );
    expect(result.deliveredAmountRaw).toBe(-60);
  });
});

describe('transformMonthlyStatementBudgetItem — pathway categories (RCP)', () => {
  const rcpData = {
    [ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]: ['pp-2'],
    [ATTRIBUTE_NAMES.AVAILABLE_FUND_START]: 800,
    [ATTRIBUTE_NAMES.PRIMARY_SUPPLEMENT_AMOUNT]: 60,
    [ATTRIBUTE_NAMES.PREVIOUS_MONTH_SPENDING_ALLOCATED_PERIOD]: '-90',
    [ATTRIBUTE_NAMES.RESTORATIVE_CARE_DELIVERED]: '-200',
  };

  it('falls back to start + supplement + allocated spending and takes no committed funds', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem(rcpData, { folderId: 'folder-rcp' }),
      makeContext(),
    );

    // 800 + 60 + (-90)
    expect(result.totalAvailableBudget).toBe(770);
    expect(result.committedFunds).toBe(0);
    // max(0, 770 + (-200) + 0)
    expect(result.remainingBalanceEndOfMonth).toBe(570);
    expect(result.remainingBalance).toBe(570);
    expect(result).not.toHaveProperty('remainingBalanceAllocationPeriod');
  });

  it('reads the restorative end-of-month balance from the reference attribute', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem(
        { ...rcpData, [REF_ATTRIBUTE_NAMES.REMAINING_RESTORATIVE_END_OF_MONTH]: '$310.50' },
        { folderId: 'folder-rcp' },
      ),
      makeContext(),
    );
    expect(result.remainingBalanceEndOfMonth).toBe(310.5);
    expect(result.remainingBalance).toBe(310.5);
  });

  it('falls back to the category config folder name when the folder id is unknown', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem(rcpData, { folderId: 'folder-detached' }),
      makeContext({
        folderIdToName: new Map(),
        folderIdToCode: { 'folder-detached': 'RCP' },
      }),
    );
    expect(result.folderName).toBe('Restorative Care Pathway Budget');
    expect(result.categoryCode).toBe('RCP');
  });

  it('leaves the folder name empty when neither the folder map nor the config resolves it', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem(rcpData, { folderId: 'folder-detached' }),
      makeContext({
        folderIdToName: new Map(),
        folderIdToCode: { 'folder-detached': 'ZZZ' },
      }),
    );
    expect(result.folderName).toBe('');
    expect(result.categoryCode).toBe('ZZZ');
  });
});

describe('transformMonthlyStatementBudgetItem — Home Support Care Management (HSCM)', () => {
  const hscmData = {
    'Associated Participant': ['pp-2'],
    Date: '2026-06-30T14:30:00.000Z',
    'Transaction Type': { id: 'tt1', name: 'Allocation' },
    'Received Amount ($)': '$400.00',
    [ATTRIBUTE_NAMES.ALLOCATED_TIME]: 3.5,
    'Allocated Amount ($-)': '-120',
  };

  it('adds received and allocated amounts when no net movement is stored', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem(hscmData, { folderId: 'folder-hscm', itemId: 'hscm-1' }),
      makeContext(),
    );

    // 400 + (-120)
    expect(result.hscmCurrentBalance).toBe(280);
    expect(result.remainingBalance).toBe(280);
    expect(result.hscmReceivedAmount).toBe(400);
    expect(result.hscmAllocatedAmount).toBe(-120);
    expect(result.hscmAllocatedTime).toBe(3.5);
    expect(result.deliveredAmount).toBe(-120);
    expect(result.totalAvailableBudget).toBe(400);
    expect(result.availableFundStart).toBe(400);
  });

  it('prefers a stored non-zero net movement over the received + allocated sum', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem({ ...hscmData, 'Net Movement ($)': '-50' }, { folderId: 'folder-hscm' }),
      makeContext(),
    );

    expect(result.hscmCurrentBalance).toBe(-50);
    expect(result.remainingBalance).toBe(0);
  });

  it('falls back to received + allocated when the stored net movement is exactly zero', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem({ ...hscmData, 'Net Movement ($)': 0 }, { folderId: 'folder-hscm' }),
      makeContext(),
    );
    expect(result.hscmCurrentBalance).toBe(280);
  });

  it('labels the month and year in the statement timezone, not UTC', () => {
    const item = makeItem(hscmData, { folderId: 'folder-hscm' });

    // 2026-06-30T14:30Z is 2026-07-01 00:30 in Sydney (UTC+10)
    const sydney = transformMonthlyStatementBudgetItem(item, makeContext({ timezone: 'Australia/Sydney' }));
    expect(sydney.month).toBe('July');
    expect(sydney.year).toBe('2026');

    const utc = transformMonthlyStatementBudgetItem(item, makeContext({ timezone: 'UTC' }));
    expect(utc.month).toBe('June');
    expect(utc.year).toBe('2026');
  });

  it('returns empty month and year for a missing or malformed date', () => {
    const noDate = transformMonthlyStatementBudgetItem(
      makeItem({ ...hscmData, Date: undefined }, { folderId: 'folder-hscm' }),
      makeContext(),
    );
    expect(noDate.month).toBe('');
    expect(noDate.year).toBe('');
    expect(noDate.hscmDate).toBeNull();

    const badDate = transformMonthlyStatementBudgetItem(
      makeItem({ ...hscmData, Date: 'not-a-date' }, { folderId: 'folder-hscm' }),
      makeContext(),
    );
    expect(badDate.month).toBe('');
    expect(badDate.year).toBe('');
  });

  it('accepts the capitalised "Allocated Time (Hr.)" alias', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem(
        { ...hscmData, [ATTRIBUTE_NAMES.ALLOCATED_TIME]: undefined, 'Allocated Time (Hr.)': 2.25 },
        { folderId: 'folder-hscm' },
      ),
      makeContext(),
    );
    expect(result.hscmAllocatedTime).toBe(2.25);
  });

  it('reads the transaction type from an option object, a plain string and nothing at all', () => {
    const fromObject = transformMonthlyStatementBudgetItem(
      makeItem(hscmData, { folderId: 'folder-hscm' }),
      makeContext(),
    );
    expect(fromObject.hscmTransactionType).toBe('Allocation');

    const fromString = transformMonthlyStatementBudgetItem(
      makeItem({ ...hscmData, 'Transaction Type': 'Adjustment' }, { folderId: 'folder-hscm' }),
      makeContext(),
    );
    expect(fromString.hscmTransactionType).toBe('Adjustment');

    const missing = transformMonthlyStatementBudgetItem(
      makeItem({ ...hscmData, 'Transaction Type': undefined }, { folderId: 'folder-hscm' }),
      makeContext(),
    );
    expect(missing.hscmTransactionType).toBe('');
  });

  it('hard-codes the care-management shape and caches it', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem(hscmData, { folderId: 'folder-hscm', itemId: 'hscm-9' }),
      makeContext(),
    );

    expect(result).toMatchObject({
      id: 'hscm-9',
      categoryCode: 'HSCM',
      folderName: 'Home Support Care Management Budget',
      participantName: 'Ravi Patel',
      participantProfileId: 'pp-2',
      quarter: '',
      fundingStartDate: null,
      fundingEndDate: null,
      quarterlyAdjustment: 0,
      primarySupplementAmount: 0,
      previousMonthSpending: 0,
      adjustmentAmount: 0,
      fundClassification: 'Care Management',
      fundAmount: 0,
      fund: '',
      committedFunds: 0,
      fundingStreamId: null,
      hscmDate: '2026-06-30T14:30:00.000Z',
    });
    expect(setCachedMSBudget).toHaveBeenCalledWith('ws-1', 'board-1', 'hscm-9', result);
  });

  it('takes the care-management path from the folder name even when the folder id is unmapped', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem(hscmData, { folderId: 'folder-detached' }),
      makeContext({
        folderIdToName: new Map(),
        folderIdToCode: { 'folder-detached': 'HSCM' },
      }),
    );
    expect(result.categoryCode).toBe('HSCM');
    expect(result.folderName).toBe('Home Support Care Management Budget');
  });

  it('detects the care-management folder name case-insensitively and keeps the real folder name', () => {
    const result = transformMonthlyStatementBudgetItem(
      makeItem(hscmData, { folderId: 'folder-hscm-lower' }),
      makeContext({
        folderIdToName: new Map([['folder-hscm-lower', 'HOME SUPPORT CARE MANAGEMENT BUDGET — FY26']]),
        folderIdToCode: { 'folder-hscm-lower': 'HSCM' },
      }),
    );
    expect(result.folderName).toBe('HOME SUPPORT CARE MANAGEMENT BUDGET — FY26');
    expect(result.categoryCode).toBe('HSCM');
  });
});
