import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ATTRIBUTE_NAMES, REF_ATTRIBUTE_NAMES } from '../../../src/constants/monthlyStatementAttributes.js';
import { extractRefId } from '../../../src/utils/ndisServiceRecords.js';
import {
  buildStatementPermutations,
  buildStatementPermutationsFixture,
  pickerYears,
  BOARD_PARTICIPANTS,
  SERVICE_FOLDER,
  PROFILE_FOLDER,
  SAH_BOARD,
} from '../../fixtures/generators/statementPermutations.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, '../../fixtures');
const load = (name) => JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8'));

// A fixed range, so the assertions below describe one known matrix rather than
// whatever the calendar says today. The default range is asserted separately.
const YEARS = [2022, 2023, 2024, 2025, 2026];
const items = buildStatementPermutations({ years: YEARS });

const PARTICIPANT_COUNT = Object.values(BOARD_PARTICIPANTS).flat().length;
const SAH_PARTICIPANT_COUNT = BOARD_PARTICIPANTS[SAH_BOARD].length;
const BUDGET_STREAM_COUNT = 6;
const BUDGET_FOLDERS = [
  'Home Support Quarterly Budget',
  'Assistive Technology - Short-term Budget',
  'Assistive Technology - Ongoing Budget',
  'Home Modification Budget',
  'Restorative Care Pathway Budget',
  'End-of-Life Pathway Budget',
];

const serviceRows = items.filter((item) => item.folderId === SERVICE_FOLDER);
const budgetRows = items.filter((item) => BUDGET_FOLDERS.includes(item.folderId));

const refMap = new Map(items.map((item) => [item.itemId, item]));
const nameOf = (item) => {
  const refId = extractRefId(item.data[ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]);
  const profile = refId ? refMap.get(refId) : null;
  return profile ? String(profile.data[REF_ATTRIBUTE_NAMES.PROFILE_FULL_NAME] ?? '') : '';
};

describe('statement-permutation generator: coverage', () => {
  // The generator's own loop bounds are the coverage guarantee — re-walking
  // board x participant x year x month here would only re-implement them. The
  // counts are what an outside reader can check independently.
  it('emits one service row per board x participant x picker-year x month', () => {
    expect(serviceRows).toHaveLength(PARTICIPANT_COUNT * YEARS.length * 12);
    // and each of those permutations is distinct, so nothing collapsed.
    const slots = new Set(serviceRows.map(
      (item) => `${nameOf(item)}|${String(item.data[ATTRIBUTE_NAMES.SCHEDULED_START]).slice(0, 7)}`,
    ));
    expect(slots.size).toBe(serviceRows.length);
  });

  it('emits one budget row per SaH participant x stream x picker-year x month', () => {
    expect(budgetRows)
      .toHaveLength(SAH_PARTICIPANT_COUNT * BUDGET_STREAM_COUNT * YEARS.length * 12);
    const slots = new Set(budgetRows.map(
      (item) => `${nameOf(item)}|${item.data.Year}|${item.data.Month}|${item.folderId}`,
    ));
    expect(slots.size).toBe(budgetRows.length);
  });

  it('scales with the requested year range and defaults to the picker window', () => {
    const oneYear = buildStatementPermutations({ years: [2030] });
    expect(oneYear.filter((i) => i.folderId === SERVICE_FOLDER))
      .toHaveLength(PARTICIPANT_COUNT * 12);

    // currentYear-4 … currentYear, which is what retired the hand-regeneration
    // chore the committed JSON carried.
    const currentYear = new Date().getFullYear();
    expect(pickerYears()).toEqual([
      currentYear - 4, currentYear - 3, currentYear - 2, currentYear - 1, currentYear,
    ]);
    expect(buildStatementPermutations().filter((i) => i.folderId === SERVICE_FOLDER))
      .toHaveLength(PARTICIPANT_COUNT * 5 * 12);
  });

  it('is deterministic: the same inputs produce byte-identical items', () => {
    expect(JSON.stringify(buildStatementPermutations({ years: YEARS })))
      .toBe(JSON.stringify(items));
  });
});

describe('statement-permutation generator: row shape', () => {
  it('renders one participant-month as a statement line would need it', () => {
    const row = serviceRows.find(
      (item) => nameOf(item) === 'Jane Smith'
        && String(item.data[ATTRIBUTE_NAMES.SCHEDULED_START]).startsWith('2022-01-'),
    );

    expect(row.boardId).toBe(SAH_BOARD);
    expect(row.folderId).toBe(SERVICE_FOLDER);
    expect(row.data).toMatchObject({
      [ATTRIBUTE_NAMES.SCHEDULED_START]: '2022-01-10T10:00:00+10:00',
      [ATTRIBUTE_NAMES.ACTUAL_END]: '2022-01-10T11:30:00+10:00',
      [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: 'Delivered - To be claimed and invoiced.',
      [ATTRIBUTE_NAMES.UNIT]: 'Hours',
      [ATTRIBUTE_NAMES.QUANTITY]: 1.5,
      [ATTRIBUTE_NAMES.UNIT_PRICE]: 82,
      [ATTRIBUTE_NAMES.TOTAL_AMOUNT]: 123,
      // 90/10, the split the statement summary renders.
      [ATTRIBUTE_NAMES.GOV_SUBSIDY]: 110.7,
      [ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION]: 12.3,
    });
    expect(refMap.get(extractRefId(row.data[ATTRIBUTE_NAMES.SERVICE_PLAN])).data)
      .toEqual({ Service: 'General house cleaning', 'Service ID/Item ID': 'SERV-0001' });
    expect(refMap.get(extractRefId(row.data[ATTRIBUTE_NAMES.FUNDING_SOURCE])).data)
      .toEqual({ [ATTRIBUTE_NAMES.FUNDING_STREAM]: 'Restorative Care Pathway' });
  });

  it('gives every service row the fields a statement line renders', () => {
    for (const item of serviceRows) {
      expect(Number(item.data[ATTRIBUTE_NAMES.TOTAL_AMOUNT]), item.itemId).toBeGreaterThan(0);
      expect(Number(item.data[ATTRIBUTE_NAMES.GOV_SUBSIDY]), item.itemId).toBeGreaterThan(0);
      expect(item.data[ATTRIBUTE_NAMES.TRANSACTION_STATUS], item.itemId).toBeTruthy();
      expect(item.data[ATTRIBUTE_NAMES.ACTUAL_END], item.itemId).toBeTruthy();
      expect(extractRefId(item.data[ATTRIBUTE_NAMES.FUNDING_SOURCE]), item.itemId).toBeTruthy();
      expect(refMap.has(extractRefId(item.data[ATTRIBUTE_NAMES.SERVICE_PLAN])), item.itemId)
        .toBe(true);
      expect(refMap.has(extractRefId(item.data[ATTRIBUTE_NAMES.PARTICIPANT_PROFILE])), item.itemId)
        .toBe(true);
    }
  });

  it('renders one participant-month-stream as a Budget Mini Chart would need it', () => {
    const row = budgetRows.find(
      (item) => nameOf(item) === 'Jane Smith'
        && item.data.Year === '2022'
        && item.data.Month === 'January'
        && item.folderId === 'Home Support Quarterly Budget',
    );

    expect(row.boardId).toBe(SAH_BOARD);
    expect(row.data).toMatchObject({
      [ATTRIBUTE_NAMES.FY_QUARTER]: 'Q1',
      [ATTRIBUTE_NAMES.FUND_CLASSIFICATION]: 'Home Support Quarterly',
      [ATTRIBUTE_NAMES.QUARTERLY_BUDGET]: 5010,
      [ATTRIBUTE_NAMES.FUND_AMOUNT]: 5010,
      // 80% of the budget is still available at the start of the month.
      [ATTRIBUTE_NAMES.AVAILABLE_FUND_START]: 4008,
      [ATTRIBUTE_NAMES.CARRYOVER_FUNDING]: 0,
      [ATTRIBUTE_NAMES.PREVIOUS_MONTH_SPENDING]: 501,
      [ATTRIBUTE_NAMES.FUNDING_START_DATE]: '2022-01-01',
      [ATTRIBUTE_NAMES.FUNDING_END_DATE]: '2022-12-31',
    });
  });

  it('gives every budget row a positive, chartable amount', () => {
    for (const item of budgetRows) {
      expect(Number(item.data[ATTRIBUTE_NAMES.QUARTERLY_BUDGET]), item.itemId).toBeGreaterThan(0);
      expect(Number(item.data[ATTRIBUTE_NAMES.AVAILABLE_FUND_START]), item.itemId)
        .toBeGreaterThan(0);
      expect(item.data[ATTRIBUTE_NAMES.FY_QUARTER], item.itemId).toMatch(/^Q[1-4]$/);
    }
  });
});

describe('statement-permutation generator: fixture invariants', () => {
  it('uses real folder names as folderIds so the offline folder filters engage', () => {
    // getFolderOffline serves name === folderId; these are the names the
    // statement and invoice-generator routes filter on.
    for (const item of items) {
      if (ATTRIBUTE_NAMES.SCHEDULED_START in item.data) {
        expect(item.folderId, item.itemId).toBe(SERVICE_FOLDER);
      } else if (item.data[REF_ATTRIBUTE_NAMES.PROFILE_FULL_NAME]) {
        expect(item.folderId, item.itemId).toBe(PROFILE_FOLDER);
      }
    }
    expect(new Set(budgetRows.map((item) => item.folderId))).toEqual(new Set(BUDGET_FOLDERS));
  });

  it('never approves a timesheet, so no invoice path can ever bill these rows', () => {
    for (const item of items) {
      expect('Timesheet Approval' in item.data, item.itemId).toBe(false);
    }
  });

  it('is data only: no schedules, no settings, no invoice numbers', () => {
    const fixture = buildStatementPermutationsFixture({ years: YEARS });
    expect(fixture.scheduledJobs).toBeUndefined();
    expect(fixture.automationSettings).toBeUndefined();
    expect(fixture.invoiceNumbers).toBeUndefined();
    expect(fixture.business.workspaceId).toBe('55390');
    expect(fixture.items).toHaveLength(items.length);
  });
});

// One place, not three. Every fixture used to carry its own copy of this check
// against some subset of the others, so a new fixture could collide with one
// nobody had thought to compare it against. Loading both 55390 fixtures at once
// is supported, so disjoint ids are a real requirement, not hygiene.
describe('fixture itemIds are unique and pairwise disjoint', () => {
  const SOURCES = {
    'ndis-quote-board.json': load('ndis-quote-board.json').items,
    'care-management-automation.json': load('care-management-automation.json').items,
    'care-management-55390-full.json': load('care-management-55390-full.json').items,
    'generators/statementPermutations.mjs': items,
  };
  const names = Object.keys(SOURCES);

  it.each(names)('%s has no duplicate itemIds of its own', (name) => {
    const ids = SOURCES[name].map((item) => item.itemId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  const pairs = names.flatMap(
    (a, i) => names.slice(i + 1).map((b) => [a, b]),
  );

  it.each(pairs)('%s shares no itemId with %s', (a, b) => {
    const left = new Set(SOURCES[a].map((item) => item.itemId));
    const collisions = SOURCES[b].map((item) => item.itemId).filter((id) => left.has(id));
    expect(collisions).toEqual([]);
  });
});
