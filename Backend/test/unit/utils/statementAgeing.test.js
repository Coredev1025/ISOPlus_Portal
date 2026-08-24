import { describe, it, expect } from 'vitest';

import {
  AGEING_BUCKETS,
  ageingBucketFor,
  assertAgeingReconciles,
  buildAgeingSummary,
} from '../../../src/utils/statementAgeing.js';

/**
 * Section 4.3: ageing runs from each invoice's DUE date, not its issue date.
 * Manual invoicing sets due date to issue date plus 14 days, so an invoice
 * issued 40 days ago is 26 days overdue, not 40.
 *
 * And the buckets must sum to the closing balance — checked before rendering,
 * with the statement failed rather than sent if they do not.
 */

const AS_AT = '2025-08-31T00:00:00.000+10:00';

const owing = (dueDate, amount) => ({ dueDate, amount });

describe('ageingBucketFor', () => {
  it('calls an invoice not yet due Current', () => {
    expect(ageingBucketFor('2025-09-10', AS_AT)).toBe('current');
  });

  it('calls an invoice due today Current, since it is not yet overdue', () => {
    expect(ageingBucketFor('2025-08-31', AS_AT)).toBe('current');
  });

  // Boundaries, counted from a statement date of 31 August 2025. Each pair is
  // the youngest and oldest due date that lands in the bucket, so an
  // off-by-one in either direction fails.
  it.each([
    ['2025-08-30', 'd1to30'], // 1 day overdue
    ['2025-08-01', 'd1to30'], // 30
    ['2025-07-31', 'd31to60'], // 31
    ['2025-07-02', 'd31to60'], // 60
    ['2025-07-01', 'd61to90'], // 61
    ['2025-06-02', 'd61to90'], // 90
    ['2025-06-01', 'd90plus'], // 91
    ['2024-01-01', 'd90plus'],
  ])('puts a due date of %s in %s', (dueDate, bucket) => {
    expect(ageingBucketFor(dueDate, AS_AT)).toBe(bucket);
  });

  it('measures from the due date, not the issue date', () => {
    // Issued 40 days before AS_AT, due 14 days later, so 26 days overdue.
    const issued = new Date('2025-07-22T00:00:00.000+10:00');
    const due = new Date(issued);
    due.setDate(due.getDate() + 14);
    expect(ageingBucketFor(due.toISOString(), AS_AT)).toBe('d1to30');
  });
});

describe('buildAgeingSummary', () => {
  it('sums each outstanding invoice into its bucket', () => {
    const summary = buildAgeingSummary([
      owing('2025-09-10', 1232.5),
      owing('2025-08-15', 1195),
    ], AS_AT);
    expect(summary.current).toBe(1232.5);
    expect(summary.d1to30).toBe(1195);
    expect(summary.d31to60).toBe(0);
  });

  it('returns every bucket, including the empty ones', () => {
    const summary = buildAgeingSummary([], AS_AT);
    expect(Object.keys(summary)).toEqual(AGEING_BUCKETS.map((b) => b.key));
    expect(Object.values(summary).every((v) => v === 0)).toBe(true);
  });

  it('ignores an invoice with nothing outstanding', () => {
    const summary = buildAgeingSummary([owing('2025-08-15', 0)], AS_AT);
    expect(summary.d1to30).toBe(0);
  });

  it('nets a credit against the bucket it falls in', () => {
    const summary = buildAgeingSummary([
      owing('2025-08-15', 1195),
      owing('2025-08-16', -195),
    ], AS_AT);
    expect(summary.d1to30).toBe(1000);
  });
});

describe('assertAgeingReconciles', () => {
  it('passes when the buckets sum to the closing balance', () => {
    const summary = buildAgeingSummary([
      owing('2025-09-10', 1232.5),
      owing('2025-08-15', 1195),
    ], AS_AT);
    expect(() => assertAgeingReconciles(summary, 2427.5)).not.toThrow();
  });

  it('throws rather than rendering a statement that does not add up', () => {
    const summary = buildAgeingSummary([owing('2025-09-10', 1232.5)], AS_AT);
    expect(() => assertAgeingReconciles(summary, 2427.5)).toThrow(/does not reconcile/i);
  });

  it('names both figures, so the failure is diagnosable from the log alone', () => {
    const summary = buildAgeingSummary([owing('2025-09-10', 100)], AS_AT);
    expect(() => assertAgeingReconciles(summary, 250)).toThrow(/100.*250|250.*100/);
  });

  it('tolerates a sub-cent rounding difference', () => {
    const summary = buildAgeingSummary([owing('2025-09-10', 1232.5)], AS_AT);
    expect(() => assertAgeingReconciles(summary, 1232.504)).not.toThrow();
  });

  it('rejects a whole cent difference, which is a real error', () => {
    const summary = buildAgeingSummary([owing('2025-09-10', 1232.5)], AS_AT);
    expect(() => assertAgeingReconciles(summary, 1232.51)).toThrow(/does not reconcile/i);
  });
});
