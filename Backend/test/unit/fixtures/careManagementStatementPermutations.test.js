import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ATTRIBUTE_NAMES, REF_ATTRIBUTE_NAMES } from '../../../src/constants/monthlyStatementAttributes.js';
import { extractRefId } from '../../../src/utils/ndisServiceRecords.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, '../../fixtures');
const load = (name) => JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8'));

const fixture = load('care-management-statement-permutations.json');
const otherIds = new Set([
  ...load('care-management-automation.json').items.map((i) => i.itemId),
  ...load('care-management-55390-full.json').items.map((i) => i.itemId),
  ...load('ndis-quote-board.json').items.map((i) => i.itemId),
]);

// The statement picker offers currentYear-4 … currentYear (12 months each);
// this fixture was generated against the 2026 picker. Regenerate when 2022
// falls off the dropdown.
const YEARS = [2022, 2023, 2024, 2025, 2026];
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const BOARD_PARTICIPANTS = {
  jpjztrn14pJ: ['Jane Smith', 'David Brown', 'Lisa Morphy'],
  o24sGM1FoST: ['David Smith', 'Martin Space', 'Sunil Patel', 'George Brown', 'Kate Abraham'],
  dwV23F5WcQL: ['Mike Bird'],
};

const refMap = new Map(fixture.items.map((item) => [item.itemId, item]));
const nameOf = (item) => {
  const refId = extractRefId(item.data[ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]);
  const profile = refId ? refMap.get(refId) : null;
  return profile ? String(profile.data[REF_ATTRIBUTE_NAMES.PROFILE_FULL_NAME] ?? '') : '';
};

describe('care-management-statement-permutations fixture', () => {
  it('covers every board x participant x picker-year x month with a service row', () => {
    for (const [boardId, participants] of Object.entries(BOARD_PARTICIPANTS)) {
      const rows = fixture.items.filter(
        (item) => item.boardId === boardId && ATTRIBUTE_NAMES.SCHEDULED_START in item.data,
      );
      for (const participant of participants) {
        for (const year of YEARS) {
          for (const month of MONTHS) {
            const prefix = `${year}-${String(month).padStart(2, '0')}-`;
            const hit = rows.some(
              (item) => nameOf(item) === participant
                && String(item.data[ATTRIBUTE_NAMES.SCHEDULED_START]).startsWith(prefix),
            );
            expect(hit, `${boardId} / ${participant} / ${prefix}`).toBe(true);
          }
        }
      }
    }
  });

  it('gives every service row the fields a statement line renders', () => {
    const rows = fixture.items.filter((item) => ATTRIBUTE_NAMES.SCHEDULED_START in item.data);
    for (const item of rows) {
      expect(Number(item.data[ATTRIBUTE_NAMES.TOTAL_AMOUNT]), item.itemId).toBeGreaterThan(0);
      expect(Number(item.data[ATTRIBUTE_NAMES.GOV_SUBSIDY]), item.itemId).toBeGreaterThan(0);
      expect(item.data[ATTRIBUTE_NAMES.TRANSACTION_STATUS], item.itemId).toBeTruthy();
      expect(item.data[ATTRIBUTE_NAMES.ACTUAL_END], item.itemId).toBeTruthy();
      expect(extractRefId(item.data[ATTRIBUTE_NAMES.FUNDING_SOURCE]), item.itemId).toBeTruthy();
    }
  });

  it('never approves a timesheet, so no invoice path can ever bill these rows', () => {
    for (const item of fixture.items) {
      expect('Timesheet Approval' in item.data, item.itemId).toBe(false);
    }
  });

  it('keeps itemIds unique and disjoint from the other fixtures', () => {
    const ids = fixture.items.map((item) => item.itemId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(otherIds.has(id), `${id} collides`).toBe(false);
    }
  });

  it('is data only: no schedules, no settings, no invoice numbers', () => {
    expect(fixture.scheduledJobs).toBeUndefined();
    expect(fixture.automationSettings).toBeUndefined();
    expect(fixture.invoiceNumbers).toBeUndefined();
  });
});
