import { describe, it, expect } from 'vitest';
import {
  normalizeString,
  isBlank,
  round2,
  parseNumber,
  isTimeBasedUnit,
  categorizeTransaction,
  shouldAutoUpdateMasterPlanVariables,
  computeMasterPlanQuantity,
  computeMasterPlanTotalAmount,
  computeMasterPlanContributions,
} from '../../../src/utils/ageCareMasterPlanCalc.js';

/** A delivered transaction, the shape categorizeTransaction returns. */
const deliveredTx = {
  statusNorm: 'delivered',
  isAdjustment: false,
  isCancelled: false,
  isDelivered: true,
  isCommitted: false,
};

const cancelledTx = {
  statusNorm: 'cancelled',
  isAdjustment: false,
  isCancelled: true,
  isDelivered: false,
  isCommitted: false,
};

const committedTx = {
  statusNorm: '',
  isAdjustment: false,
  isCancelled: false,
  isDelivered: false,
  isCommitted: true,
};

const adjustmentTx = {
  statusNorm: 'adjustment - refund',
  isAdjustment: true,
  isCancelled: false,
  isDelivered: false,
  isCommitted: false,
};

describe('normalizeString', () => {
  it('returns an empty string for null and undefined', () => {
    expect(normalizeString(null)).toBe('');
    expect(normalizeString(undefined)).toBe('');
  });

  it('trims and lowercases', () => {
    expect(normalizeString('  Delivered  ')).toBe('delivered');
    expect(normalizeString('CANCELLED')).toBe('cancelled');
  });

  it('stringifies non-strings', () => {
    expect(normalizeString(42)).toBe('42');
    expect(normalizeString(false)).toBe('false');
  });

  it('does not treat 0 as nullish', () => {
    expect(normalizeString(0)).toBe('0');
  });
});

describe('isBlank', () => {
  it('is true for nullish, empty and whitespace-only values', () => {
    expect(isBlank(null)).toBe(true);
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank('')).toBe(true);
    expect(isBlank('   ')).toBe(true);
  });

  it('is false for any non-empty content, including "0"', () => {
    expect(isBlank('Delivered')).toBe(false);
    expect(isBlank(0)).toBe(false);
    expect(isBlank('0')).toBe(false);
  });
});

describe('round2', () => {
  it('rounds to two decimal places', () => {
    expect(round2(12.3456)).toBe(12.35);
    expect(round2(3.456)).toBe(3.46);
    expect(round2(59.97)).toBe(59.97);
  });

  it('coerces numeric strings', () => {
    expect(round2('12.345')).toBe(12.35);
    expect(round2('7')).toBe(7);
  });

  it('returns 0 for non-finite input', () => {
    expect(round2(NaN)).toBe(0);
    expect(round2(Infinity)).toBe(0);
    expect(round2(-Infinity)).toBe(0);
    expect(round2(undefined)).toBe(0);
    expect(round2('abc')).toBe(0);
  });

  it('treats null as 0 because Number(null) is 0', () => {
    expect(round2(null)).toBe(0);
  });

  it('rounds half away from zero only upward — negative halves round toward zero', () => {
    // Math.round(-1055.5) === -1055, so -10.555 becomes -10.55 rather than -10.56.
    expect(round2(-10.555)).toBe(-10.55);
    expect(round2(-2.345)).toBe(-2.35);
  });

  it('inherits binary float representation error (1.005 rounds down)', () => {
    // 1.005 * 100 === 100.49999999999999 in IEEE-754, so this rounds to 1, not 1.01.
    expect(round2(1.005)).toBe(1);
  });

  it('preserves zero', () => {
    expect(round2(0)).toBe(0);
  });
});

describe('parseNumber', () => {
  it('returns 0 for nullish', () => {
    expect(parseNumber(null)).toBe(0);
    expect(parseNumber(undefined)).toBe(0);
  });

  it('returns finite numbers unchanged', () => {
    expect(parseNumber(25.5)).toBe(25.5);
    expect(parseNumber(-3)).toBe(-3);
    expect(parseNumber(0)).toBe(0);
  });

  it('returns 0 for non-finite numbers', () => {
    expect(parseNumber(NaN)).toBe(0);
    expect(parseNumber(Infinity)).toBe(0);
  });

  it('strips $, % and commas from strings', () => {
    expect(parseNumber('$25.50')).toBe(25.5);
    expect(parseNumber('50%')).toBe(50);
    expect(parseNumber('1,234.56')).toBe(1234.56);
    expect(parseNumber('  12  ')).toBe(12);
  });

  it('returns 0 for unparseable strings', () => {
    expect(parseNumber('abc')).toBe(0);
    expect(parseNumber('')).toBe(0);
    expect(parseNumber(true)).toBe(0);
  });

  it('handles negative money strings', () => {
    expect(parseNumber('-$40.25')).toBe(-40.25);
  });
});

describe('isTimeBasedUnit', () => {
  it('matches any unit containing "hour", case-insensitively', () => {
    expect(isTimeBasedUnit('Per Hour')).toBe(true);
    expect(isTimeBasedUnit('HOURLY')).toBe(true);
    expect(isTimeBasedUnit('  hour  ')).toBe(true);
  });

  it('is false for non-time units', () => {
    expect(isTimeBasedUnit('Each')).toBe(false);
    expect(isTimeBasedUnit('Per Item')).toBe(false);
    expect(isTimeBasedUnit('Day')).toBe(false);
  });

  it('is false for nullish units', () => {
    expect(isTimeBasedUnit(null)).toBe(false);
    expect(isTimeBasedUnit(undefined)).toBe(false);
    expect(isTimeBasedUnit('')).toBe(false);
  });
});

describe('categorizeTransaction', () => {
  it('classifies a delivered transaction', () => {
    expect(categorizeTransaction({ transactionStatus: 'Delivered', committedATHM: false })).toEqual({
      statusNorm: 'delivered',
      isAdjustment: false,
      isCancelled: false,
      isDelivered: true,
      isCommitted: false,
    });
  });

  it('classifies a cancelled transaction', () => {
    expect(categorizeTransaction({ transactionStatus: 'Cancelled', committedATHM: false })).toEqual({
      statusNorm: 'cancelled',
      isAdjustment: false,
      isCancelled: true,
      isDelivered: false,
      isCommitted: false,
    });
  });

  it('classifies a status starting with "adjustment" as an adjustment', () => {
    const result = categorizeTransaction({ transactionStatus: 'Adjustment', committedATHM: false });
    expect(result.isAdjustment).toBe(true);
    expect(result.statusNorm).toBe('adjustment');
  });

  it('classifies "adjustment" combined with refund or charge in any order', () => {
    expect(categorizeTransaction({ transactionStatus: 'Refund Adjustment' }).isAdjustment).toBe(true);
    expect(categorizeTransaction({ transactionStatus: 'Charge Adjustment' }).isAdjustment).toBe(true);
    expect(categorizeTransaction({ transactionStatus: 'Adjustment - Refund' }).isAdjustment).toBe(true);
  });

  it('does not classify a mid-string "adjustment" without refund/charge as an adjustment', () => {
    const result = categorizeTransaction({ transactionStatus: 'Manual adjustment', committedATHM: false });
    expect(result.isAdjustment).toBe(false);
  });

  it('suppresses isDelivered when the status is also an adjustment', () => {
    const result = categorizeTransaction({ transactionStatus: 'Adjustment - Delivered', committedATHM: false });
    expect(result.isAdjustment).toBe(true);
    expect(result.isDelivered).toBe(false);
  });

  it('flags committed only when the committed tick is set AND the status is blank', () => {
    expect(categorizeTransaction({ transactionStatus: '', committedATHM: true }).isCommitted).toBe(true);
    expect(categorizeTransaction({ transactionStatus: undefined, committedATHM: true }).isCommitted).toBe(true);
    expect(categorizeTransaction({ transactionStatus: '   ', committedATHM: true }).isCommitted).toBe(true);
  });

  it('does not flag committed when a status is present or the tick is missing', () => {
    expect(categorizeTransaction({ transactionStatus: 'Delivered', committedATHM: true }).isCommitted).toBe(false);
    expect(categorizeTransaction({ transactionStatus: '', committedATHM: false }).isCommitted).toBe(false);
    expect(categorizeTransaction({ transactionStatus: '', committedATHM: undefined }).isCommitted).toBe(false);
  });
});

describe('shouldAutoUpdateMasterPlanVariables', () => {
  it('is false for adjustments (they are managed manually)', () => {
    expect(shouldAutoUpdateMasterPlanVariables(adjustmentTx)).toBe(false);
  });

  it('is true for every non-adjustment transaction', () => {
    expect(shouldAutoUpdateMasterPlanVariables(deliveredTx)).toBe(true);
    expect(shouldAutoUpdateMasterPlanVariables(cancelledTx)).toBe(true);
    expect(shouldAutoUpdateMasterPlanVariables(committedTx)).toBe(true);
  });
});

describe('computeMasterPlanQuantity', () => {
  it('returns null for adjustments so nothing is overwritten', () => {
    expect(computeMasterPlanQuantity({
      isTimeBased: true,
      tx: adjustmentTx,
      actualDuration: 3,
      scheduledDuration: 4,
      quantityNonTimeBased: 5,
    })).toBeNull();
  });

  it('uses the non-time-based quantity when the unit is not hourly', () => {
    expect(computeMasterPlanQuantity({
      isTimeBased: false,
      tx: deliveredTx,
      actualDuration: 3,
      scheduledDuration: 4,
      quantityNonTimeBased: 3.456,
    })).toBe(3.46);
  });

  it('uses the actual duration for a delivered time-based shift', () => {
    expect(computeMasterPlanQuantity({
      isTimeBased: true,
      tx: deliveredTx,
      actualDuration: 2.755,
      scheduledDuration: 4,
      quantityNonTimeBased: 99,
    })).toBe(2.76);
  });

  it('uses the scheduled duration for a cancelled time-based shift', () => {
    expect(computeMasterPlanQuantity({
      isTimeBased: true,
      tx: cancelledTx,
      actualDuration: 0,
      scheduledDuration: 4.5,
      quantityNonTimeBased: 99,
    })).toBe(4.5);
  });

  it('uses the scheduled duration for a committed time-based shift', () => {
    expect(computeMasterPlanQuantity({
      isTimeBased: true,
      tx: committedTx,
      actualDuration: 0,
      scheduledDuration: 7.25,
      quantityNonTimeBased: 99,
    })).toBe(7.25);
  });

  it('returns 0 rather than null when the quantity is genuinely zero', () => {
    expect(computeMasterPlanQuantity({
      isTimeBased: true,
      tx: deliveredTx,
      actualDuration: 0,
      scheduledDuration: 4,
      quantityNonTimeBased: 0,
    })).toBe(0);
  });
});

describe('computeMasterPlanTotalAmount', () => {
  it('returns null for adjustments', () => {
    expect(computeMasterPlanTotalAmount({
      unitPrice: 25.5,
      quantity: 2,
      tx: adjustmentTx,
      billableToClientPct: 100,
    })).toBeNull();
  });

  it('multiplies unit price by quantity for a delivered shift', () => {
    expect(computeMasterPlanTotalAmount({
      unitPrice: 25.5,
      quantity: 2,
      tx: deliveredTx,
      billableToClientPct: 100,
    })).toBe(51);
  });

  it('parses money and numeric strings before multiplying', () => {
    // 19.99 * 3 = 59.97
    expect(computeMasterPlanTotalAmount({
      unitPrice: '$19.99',
      quantity: '3',
      tx: deliveredTx,
      billableToClientPct: '100',
    })).toBe(59.97);
  });

  it('ignores billableToClientPct when the shift was not cancelled', () => {
    expect(computeMasterPlanTotalAmount({
      unitPrice: 20,
      quantity: 2,
      tx: deliveredTx,
      billableToClientPct: 50,
    })).toBe(40);
  });

  it('applies billableToClientPct to a cancelled shift', () => {
    // 19.99 * 3 = 59.97; 59.97 * 0.5 = 29.985 -> 29.99
    expect(computeMasterPlanTotalAmount({
      unitPrice: '19.99',
      quantity: 3,
      tx: cancelledTx,
      billableToClientPct: '50',
    })).toBe(29.99);
  });

  it('bills nothing for a cancellation that is 0% billable', () => {
    expect(computeMasterPlanTotalAmount({
      unitPrice: 100,
      quantity: 2,
      tx: cancelledTx,
      billableToClientPct: '0%',
    })).toBe(0);
  });

  it('treats a missing billable percentage on a cancellation as 0', () => {
    expect(computeMasterPlanTotalAmount({
      unitPrice: 100,
      quantity: 2,
      tx: cancelledTx,
      billableToClientPct: undefined,
    })).toBe(0);
  });

  it('bills the full amount for a 100% billable cancellation', () => {
    expect(computeMasterPlanTotalAmount({
      unitPrice: 100,
      quantity: 2,
      tx: cancelledTx,
      billableToClientPct: 100,
    })).toBe(200);
  });

  it('returns 0 when the quantity is null (parseNumber(null) is 0)', () => {
    expect(computeMasterPlanTotalAmount({
      unitPrice: 100,
      quantity: null,
      tx: deliveredTx,
      billableToClientPct: 100,
    })).toBe(0);
  });

  it('produces a negative total for a negative unit price', () => {
    expect(computeMasterPlanTotalAmount({
      unitPrice: -25,
      quantity: 2,
      tx: deliveredTx,
      billableToClientPct: 100,
    })).toBe(-50);
  });
});

describe('computeMasterPlanContributions', () => {
  it('returns null for adjustments', () => {
    expect(computeMasterPlanContributions({
      totalAmount: 100,
      participantContributionPct: 25,
      tx: adjustmentTx,
    })).toBeNull();
  });

  it('splits the total between participant and government', () => {
    expect(computeMasterPlanContributions({
      totalAmount: 100,
      participantContributionPct: 25,
      tx: deliveredTx,
    })).toEqual({ participantContribution: 25, governmentSubsidy: 75 });
  });

  it('gives the whole total to the government at 0%', () => {
    expect(computeMasterPlanContributions({
      totalAmount: 59.97,
      participantContributionPct: 0,
      tx: deliveredTx,
    })).toEqual({ participantContribution: 0, governmentSubsidy: 59.97 });
  });

  it('gives the whole total to the participant at 100%', () => {
    expect(computeMasterPlanContributions({
      totalAmount: 59.97,
      participantContributionPct: '100%',
      tx: deliveredTx,
    })).toEqual({ participantContribution: 59.97, governmentSubsidy: 0 });
  });

  it('handles fractional percentages given as strings', () => {
    // 17.5% of 90 = 15.75; 90 - 15.75 = 74.25
    expect(computeMasterPlanContributions({
      totalAmount: '$90.00',
      participantContributionPct: '17.5',
      tx: deliveredTx,
    })).toEqual({ participantContribution: 15.75, governmentSubsidy: 74.25 });
  });

  it('rounds each side independently, so the two need not sum to the raw total', () => {
    // 33% of 33.33 = 10.9989 -> 11; 33.33 - 11 = 22.33
    expect(computeMasterPlanContributions({
      totalAmount: 33.33,
      participantContributionPct: 33,
      tx: cancelledTx,
    })).toEqual({ participantContribution: 11, governmentSubsidy: 22.33 });
  });

  it('splits a negative total (an adjustment-style credit) proportionally', () => {
    expect(computeMasterPlanContributions({
      totalAmount: -50,
      participantContributionPct: 20,
      tx: cancelledTx,
    })).toEqual({ participantContribution: -10, governmentSubsidy: -40 });
  });

  it('treats a blank percentage as 0', () => {
    expect(computeMasterPlanContributions({
      totalAmount: 80,
      participantContributionPct: '',
      tx: committedTx,
    })).toEqual({ participantContribution: 0, governmentSubsidy: 80 });
  });

  it('returns a zero split for a zero total', () => {
    expect(computeMasterPlanContributions({
      totalAmount: 0,
      participantContributionPct: 30,
      tx: deliveredTx,
    })).toEqual({ participantContribution: 0, governmentSubsidy: 0 });
  });
});
