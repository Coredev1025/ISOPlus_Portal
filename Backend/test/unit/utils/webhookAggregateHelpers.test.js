import { describe, it, expect } from 'vitest';
import {
  enrichNumericAggregateFields,
  enrichLabelAggregateFields,
} from '../../../src/utils/webhookAggregateHelpers.js';

// Test doubles for the two collaborators webhook.js injects. Both mirror the
// private implementations in src/routes/webhook.js (parseNumberValue at ~L639,
// safeString at ~L702) closely enough for the formats that actually reach these
// helpers: plain numbers, "$1,234.56" currency strings, "(500.00)" negatives,
// null/undefined, and label objects of the shape { id, name, color }.
function parseNumberValue(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let s = String(value).trim();
  if (!s) return 0;
  let negative = false;
  if (/\(.*\)/.test(s)) {
    negative = true;
    s = s.replace(/[()]/g, '');
  }
  const parsed = parseFloat(s.replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(parsed)) return 0;
  return negative ? -Math.abs(parsed) : parsed;
}

function safeString(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return value.name || value.id || '';
  return String(value);
}

// The real map webhook.js builds in enrichAggregateFromCategory.
const NUMERIC_FIELDS = {
  availableFundStart: 'availableFundStart',
  quarterlyAdjustment: 'quarterlyAdjustment',
  primarySupplementAmount: 'primarySupplementAmount',
  carryoverFunding: 'carryoverFunding',
  unspentReturned: 'unspentReturned',
  commonwealthUnspent: 'commonwealthUnspent',
  providerUnspent: 'providerUnspent',
  participantUnspent: 'participantUnspent',
  previousMonthSpending: 'previousMonthSpending',
  fundAmount: 'fundAmount',
  additionalAmountApproved: 'additionalAmountApproved',
  adjustmentAmount: 'adjustmentAmount',
  committedFunds: 'committedFunds',
  govSubsidyAmount: 'govSubsidyAmount',
  participantContributionAmount: 'participantContributionAmount',
  remainingBalanceAllocationPeriod: 'remainingBalanceAllocationPeriod',
};

const MAPPED_FIELDS = [
  { aggField: 'totalAvailableBudget', catFields: ['totalAvailableBudget', 'availableFunds'] },
  { aggField: 'deliveredAmount', catFields: ['deliveredAmount', 'serviceDeliveredAmount'] },
  { aggField: 'remainingBalance', catFields: ['remainingBalance', 'remainingBudget'] },
];

// Mirrors initializeBudgetAggregate() in src/routes/webhook.js.
function makeAggregate(overrides = {}) {
  return {
    availableFundStart: 0,
    quarterlyAdjustment: 0,
    primarySupplementAmount: 0,
    carryoverFunding: 0,
    unspentReturned: 0,
    commonwealthUnspent: 0,
    providerUnspent: 0,
    participantUnspent: 0,
    previousMonthSpending: 0,
    totalAvailableBudget: 0,
    deliveredAmount: 0,
    adjustmentAmount: 0,
    remainingBalance: 0,
    committedFunds: 0,
    remainingBalanceEndOfMonth: 0,
    remainingBalanceAllocationPeriod: 0,
    fundAmount: 0,
    additionalAmountApproved: 0,
    govSubsidyAmount: 0,
    participantContributionAmount: 0,
    fund: '',
    fundClassification: '',
    primarySupplementLabel: '',
    quarterLabel: '',
    months: new Set(),
    fundingStartDate: null,
    fundingEndDate: null,
    hscmTotalAllocatedTime: 0,
    hscmTotalReceivedAmount: 0,
    hscmTotalAllocatedAmount: 0,
    hscmItemCount: 0,
    ...overrides,
  };
}

describe('enrichNumericAggregateFields', () => {
  it('fills every zero numeric field from the matching category field', () => {
    const aggregate = makeAggregate();
    const category = {
      availableFundStart: '$12,000.00',
      quarterlyAdjustment: 250.5,
      primarySupplementAmount: '(500.00)',
      carryoverFunding: '1,000',
      unspentReturned: 0,
      commonwealthUnspent: null,
      providerUnspent: '',
      participantUnspent: undefined,
      previousMonthSpending: 87.25,
      fundAmount: 30000,
      additionalAmountApproved: 0,
      adjustmentAmount: -12.75,
      committedFunds: '$4,500.00',
      govSubsidyAmount: 0,
      participantContributionAmount: 0,
      remainingBalanceAllocationPeriod: 9999.99,
      totalAvailableBudget: 0,
      availableFunds: '$26,500.00',
      deliveredAmount: 0,
      serviceDeliveredAmount: 3200,
      remainingBalance: 0,
      remainingBudget: 0,
      primarySupplementLabel: 'Home Care Level 3',
      fund: 'Commonwealth',
      fundClassification: 'HCP',
    };

    enrichNumericAggregateFields(aggregate, category, NUMERIC_FIELDS, MAPPED_FIELDS, parseNumberValue);

    expect(aggregate.availableFundStart).toBe(12000);
    expect(aggregate.quarterlyAdjustment).toBe(250.5);
    expect(aggregate.primarySupplementAmount).toBe(-500);
    expect(aggregate.carryoverFunding).toBe(1000);
    expect(aggregate.previousMonthSpending).toBe(87.25);
    expect(aggregate.fundAmount).toBe(30000);
    expect(aggregate.adjustmentAmount).toBe(-12.75);
    expect(aggregate.committedFunds).toBe(4500);
    expect(aggregate.remainingBalanceAllocationPeriod).toBe(9999.99);

    // Category value parses to 0 (or is absent) => aggregate is left untouched.
    expect(aggregate.unspentReturned).toBe(0);
    expect(aggregate.commonwealthUnspent).toBe(0);
    expect(aggregate.providerUnspent).toBe(0);
    expect(aggregate.participantUnspent).toBe(0);
    expect(aggregate.additionalAmountApproved).toBe(0);
    expect(aggregate.govSubsidyAmount).toBe(0);
    expect(aggregate.participantContributionAmount).toBe(0);

    // Mapped fields fall through to the second candidate name.
    expect(aggregate.totalAvailableBudget).toBe(26500);
    expect(aggregate.deliveredAmount).toBe(3200);
    // Neither remainingBalance nor remainingBudget is non-zero.
    expect(aggregate.remainingBalance).toBe(0);
  });

  it('does not overwrite a numeric field the aggregate already carries', () => {
    const aggregate = makeAggregate({ availableFundStart: 7500, adjustmentAmount: -3 });
    const category = { availableFundStart: 999, adjustmentAmount: 42 };

    enrichNumericAggregateFields(
      aggregate,
      category,
      { availableFundStart: 'availableFundStart', adjustmentAmount: 'adjustmentAmount' },
      [],
      parseNumberValue,
    );

    expect(aggregate.availableFundStart).toBe(7500);
    expect(aggregate.adjustmentAmount).toBe(-3);
  });

  it('treats an aggregate value below the 0.001 threshold as empty and overwrites it', () => {
    const aggregate = makeAggregate({ fundAmount: 0.0009, committedFunds: -0.0009 });
    const category = { fundAmount: 500, committedFunds: 250 };

    enrichNumericAggregateFields(
      aggregate,
      category,
      { fundAmount: 'fundAmount', committedFunds: 'committedFunds' },
      [],
      parseNumberValue,
    );

    expect(aggregate.fundAmount).toBe(500);
    expect(aggregate.committedFunds).toBe(250);
  });

  it('keeps an aggregate value exactly at the 0.001 threshold', () => {
    const aggregate = makeAggregate({ fundAmount: 0.001, committedFunds: -0.001 });
    const category = { fundAmount: 500, committedFunds: 250 };

    enrichNumericAggregateFields(
      aggregate,
      category,
      { fundAmount: 'fundAmount', committedFunds: 'committedFunds' },
      [],
      parseNumberValue,
    );

    expect(aggregate.fundAmount).toBe(0.001);
    expect(aggregate.committedFunds).toBe(-0.001);
  });

  it('ignores a category value below the 0.001 threshold, leaving the field undefined', () => {
    const aggregate = {};
    const category = { fundAmount: 0.0005, committedFunds: '-0.0004' };

    enrichNumericAggregateFields(
      aggregate,
      category,
      { fundAmount: 'fundAmount', committedFunds: 'committedFunds' },
      [],
      parseNumberValue,
    );

    expect(aggregate).toEqual({});
    expect('fundAmount' in aggregate).toBe(false);
  });

  it('copies a negative category value when the aggregate is empty', () => {
    const aggregate = makeAggregate();

    enrichNumericAggregateFields(
      aggregate,
      { unspentReturned: '(1,250.75)' },
      { unspentReturned: 'unspentReturned' },
      [],
      parseNumberValue,
    );

    expect(aggregate.unspentReturned).toBe(-1250.75);
  });

  it('honours a category key that differs from the aggregate key', () => {
    const aggregate = makeAggregate();

    enrichNumericAggregateFields(
      aggregate,
      { availableFunds: 8800, totalAvailableBudget: 0 },
      { totalAvailableBudget: 'availableFunds' },
      [],
      parseNumberValue,
    );

    expect(aggregate.totalAvailableBudget).toBe(8800);
  });

  it('takes the first non-zero mapped candidate and stops', () => {
    const aggregate = makeAggregate();
    const category = {
      totalAvailableBudget: 1111,
      availableFunds: 2222,
      deliveredAmount: 0,
      serviceDeliveredAmount: 3333,
      remainingBalance: null,
      remainingBudget: '$4,444.00',
    };

    enrichNumericAggregateFields(aggregate, category, {}, MAPPED_FIELDS, parseNumberValue);

    expect(aggregate.totalAvailableBudget).toBe(1111);
    expect(aggregate.deliveredAmount).toBe(3333);
    expect(aggregate.remainingBalance).toBe(4444);
  });

  it('leaves a mapped field alone when no candidate is non-zero', () => {
    const aggregate = makeAggregate();

    enrichNumericAggregateFields(
      aggregate,
      { deliveredAmount: 0, serviceDeliveredAmount: '' },
      {},
      [{ aggField: 'deliveredAmount', catFields: ['deliveredAmount', 'serviceDeliveredAmount'] }],
      parseNumberValue,
    );

    expect(aggregate.deliveredAmount).toBe(0);
  });

  it('does not consult the category at all for an already-populated mapped field', () => {
    const aggregate = makeAggregate({ deliveredAmount: 99 });
    const reads = [];
    const spyingParse = (value) => {
      reads.push(value);
      return parseNumberValue(value);
    };

    enrichNumericAggregateFields(
      aggregate,
      { deliveredAmount: 1, serviceDeliveredAmount: 2 },
      {},
      [{ aggField: 'deliveredAmount', catFields: ['deliveredAmount', 'serviceDeliveredAmount'] }],
      spyingParse,
    );

    expect(aggregate.deliveredAmount).toBe(99);
    expect(reads).toEqual([]);
  });

  it('does not mutate the category object', () => {
    const aggregate = makeAggregate();
    const category = { availableFundStart: '$1,000.00', availableFunds: 500 };
    const categoryBefore = { ...category };

    enrichNumericAggregateFields(aggregate, category, NUMERIC_FIELDS, MAPPED_FIELDS, parseNumberValue);

    expect(category).toEqual(categoryBefore);
  });

  it('returns undefined — the aggregate is enriched in place', () => {
    const aggregate = makeAggregate();
    const result = enrichNumericAggregateFields(
      aggregate,
      { fundAmount: 10 },
      { fundAmount: 'fundAmount' },
      [],
      parseNumberValue,
    );

    expect(result).toBeUndefined();
    expect(aggregate.fundAmount).toBe(10);
  });

  it('is a no-op when both field maps are empty', () => {
    const aggregate = makeAggregate();
    const before = { ...aggregate };

    enrichNumericAggregateFields(aggregate, { fundAmount: 500 }, {}, [], parseNumberValue);

    expect(aggregate).toEqual(before);
  });
});

describe('enrichLabelAggregateFields', () => {
  it('fills every empty label and date field from the category', () => {
    const aggregate = makeAggregate();
    const category = {
      primarySupplementLabel: 'Dementia and Cognition Supplement',
      fund: 'Commonwealth',
      fundClassification: 'Home Care Package Level 3',
      fundingStartDate: '01/07/2025',
      fundingEndDate: '30/06/2026',
      availableFundStart: 12000,
    };

    enrichLabelAggregateFields(aggregate, category, safeString);

    expect(aggregate.primarySupplementLabel).toBe('Dementia and Cognition Supplement');
    expect(aggregate.fund).toBe('Commonwealth');
    expect(aggregate.fundClassification).toBe('Home Care Package Level 3');
    expect(aggregate.fundingStartDate).toBe('01/07/2025');
    expect(aggregate.fundingEndDate).toBe('30/06/2026');
  });

  it('does not overwrite labels or dates the aggregate already carries', () => {
    const aggregate = makeAggregate({
      primarySupplementLabel: 'Existing Label',
      fund: 'Existing Fund',
      fundClassification: 'Existing Class',
      fundingStartDate: '01/01/2025',
      fundingEndDate: '31/12/2025',
    });

    enrichLabelAggregateFields(
      aggregate,
      {
        primarySupplementLabel: 'New Label',
        fund: 'New Fund',
        fundClassification: 'New Class',
        fundingStartDate: '01/07/2025',
        fundingEndDate: '30/06/2026',
      },
      safeString,
    );

    expect(aggregate.primarySupplementLabel).toBe('Existing Label');
    expect(aggregate.fund).toBe('Existing Fund');
    expect(aggregate.fundClassification).toBe('Existing Class');
    expect(aggregate.fundingStartDate).toBe('01/01/2025');
    expect(aggregate.fundingEndDate).toBe('31/12/2025');
  });

  it('unwraps ISO+ label objects via safeString, preferring name over id', () => {
    const aggregate = makeAggregate();

    enrichLabelAggregateFields(
      aggregate,
      {
        primarySupplementLabel: { id: 'lbl-1', name: 'Oxygen Supplement', color: '#00aa55' },
        fund: { id: 'fund-9', name: '', color: '#123456' },
        fundClassification: { id: 'class-2' },
      },
      safeString,
    );

    expect(aggregate.primarySupplementLabel).toBe('Oxygen Supplement');
    expect(aggregate.fund).toBe('fund-9');
    expect(aggregate.fundClassification).toBe('class-2');
  });

  it('normalises missing label values to the empty string, not undefined', () => {
    const aggregate = makeAggregate();

    enrichLabelAggregateFields(aggregate, {}, safeString);

    expect(aggregate.primarySupplementLabel).toBe('');
    expect(aggregate.fund).toBe('');
    expect(aggregate.fundClassification).toBe('');
  });

  it('leaves the date fields untouched when the category has none', () => {
    const aggregate = makeAggregate();

    enrichLabelAggregateFields(aggregate, { fundingStartDate: '', fundingEndDate: null }, safeString);

    expect(aggregate.fundingStartDate).toBeNull();
    expect(aggregate.fundingEndDate).toBeNull();
  });

  it('passes date values straight through without going via safeString', () => {
    const aggregate = makeAggregate();
    const start = new Date('2025-07-01T00:00:00.000Z');
    const seen = [];
    const spyingSafeString = (value) => {
      seen.push(value);
      return safeString(value);
    };

    enrichLabelAggregateFields(aggregate, { fundingStartDate: start }, spyingSafeString);

    expect(aggregate.fundingStartDate).toBe(start);
    expect(seen).toEqual([undefined, undefined, undefined]);
  });

  it('returns undefined — the aggregate is enriched in place', () => {
    const aggregate = makeAggregate();
    const result = enrichLabelAggregateFields(aggregate, { fund: 'Commonwealth' }, safeString);

    expect(result).toBeUndefined();
    expect(aggregate.fund).toBe('Commonwealth');
  });
});
