import { describe, it, expect } from 'vitest';

import { planMarkers } from '../../../../src/utils/invoiceLedger/markers/plan.js';
import { formatMarkerResult } from '../../../../src/utils/invoiceLedger/markers/cli.js';

/**
 * The marker backfill planner (KAN-312): which items get `invoicedBy` / `invoicedAt` from the
 * old log. Pure. In production no item has a marker and the log is the only record, so the
 * marker is the guard that works when the log is not read.
 */

const log = (itemId, invoiceNumber, over = {}) => ({
  itemId,
  invoiceNumber,
  type: 'PDF',
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-01T00:00:00Z'),
  ...over,
});
const item = (itemId, over = {}) => ({ itemId, invoicedBy: null, ...over });

describe('planMarkers', () => {
  it('marks an unmarked item with the logged number exactly as stored, and the log row date', () => {
    const plan = planMarkers({
      items: [item('a')],
      logRows: [log('a', 'INV-24 (ISO+™)', { createdAt: new Date('2026-05-02T00:00:00Z'), updatedAt: new Date('2026-05-02T00:00:00Z') })],
    });
    expect(plan.markers).toEqual([{
      itemId: 'a', invoicedBy: 'INV-24 (ISO+™)', invoicedAt: new Date('2026-05-02T00:00:00Z'), from: 'PDF', approximate: false,
    }]);
  });

  it('keeps the PDF number when the PDF row is the later one (D8: the portal invoice holds the Xero number)', () => {
    const plan = planMarkers({
      items: [item('a')],
      logRows: [
        log('a', 'INV-0501 (Xero)', { type: 'Xero', createdAt: new Date('2026-06-01Z') }),
        log('a', 'INV-24 (ISO+™)', { createdAt: new Date('2026-07-01Z') }),
      ],
    });
    expect(plan.markers[0]).toMatchObject({ invoicedBy: 'INV-24 (ISO+™)', from: 'PDF' });
    expect(plan.report.counts.hadBothTypes).toBe(1);
  });

  // KAN-315: the latest invoice an item has wins, whichever system issued it.
  it('takes the Xero number when the Xero row is later than the PDF row', () => {
    const plan = planMarkers({
      items: [item('a')],
      logRows: [
        log('a', 'INV-24 (ISO+™)', { createdAt: new Date('2026-06-01Z'), updatedAt: new Date('2026-06-01Z') }),
        log('a', 'INV-0501 (Xero)', { type: 'Xero', createdAt: new Date('2026-07-01Z'), updatedAt: new Date('2026-07-01Z') }),
      ],
    });
    expect(plan.markers[0]).toMatchObject({ invoicedBy: 'INV-0501 (Xero)', from: 'Xero', invoicedAt: new Date('2026-07-01Z') });
    expect(plan.report.counts.hadBothTypes).toBe(1);
  });

  it('keeps the PDF number when the dates are equal: only a strictly later Xero row wins', () => {
    const same = new Date('2026-07-01Z');
    const plan = planMarkers({
      items: [item('a')],
      logRows: [
        log('a', 'INV-0501 (Xero)', { type: 'Xero', createdAt: same, updatedAt: same }),
        log('a', 'INV-24 (ISO+™)', { createdAt: same, updatedAt: same }),
      ],
    });
    expect(plan.markers[0]).toMatchObject({ invoicedBy: 'INV-24 (ISO+™)', from: 'PDF' });
  });

  it('marks an item with only a Xero row with the Xero number', () => {
    const plan = planMarkers({ items: [item('a')], logRows: [log('a', 'INV-0600 (Xero)', { type: 'Xero' })] });
    expect(plan.markers[0]).toMatchObject({ invoicedBy: 'INV-0600 (Xero)', from: 'Xero' });
    expect(plan.report.counts.byType).toEqual({ Xero: 1 });
  });

  // The invoice backfill points an item with no marker at the latest invoice that lists it, so
  // the marker takes the latest row too: pointer and marker agree because the code says so.
  it('takes the latest of several PDF rows, deterministically, so the marker agrees with the pointer', () => {
    const plan = planMarkers({
      items: [item('a')],
      logRows: [
        log('a', 'INV-30', { createdAt: new Date('2026-08-01Z') }),
        log('a', 'INV-20', { createdAt: new Date('2026-06-01Z') }),
      ],
    });
    expect(plan.markers[0].invoicedBy).toBe('INV-30');
  });

  it('breaks a tie on the date by the number, the same way for any input order', () => {
    const rows = [log('a', 'INV-20'), log('a', 'INV-10')];
    expect(planMarkers({ items: [item('a')], logRows: rows }).markers[0].invoicedBy)
      .toBe(planMarkers({ items: [item('a')], logRows: [...rows].reverse() }).markers[0].invoicedBy);
  });

  it('still marks an item whose row has a number but no usable creation date, dating it from the last update, then the row id', () => {
    const noCreated = planMarkers({
      items: [item('a')],
      logRows: [log('a', 'INV-24', { createdAt: undefined, updatedAt: new Date('2026-07-09T00:00:00Z') })],
    });
    expect(noCreated.markers[0]).toMatchObject({ invoicedBy: 'INV-24', invoicedAt: new Date('2026-07-09T00:00:00Z'), approximate: true });

    const onlyId = planMarkers({
      items: [item('a')],
      logRows: [log('a', 'INV-24', { createdAt: undefined, updatedAt: undefined, idDate: new Date('2026-06-01T00:00:00Z') })],
    });
    expect(onlyId.markers[0]).toMatchObject({ invoicedBy: 'INV-24', invoicedAt: new Date('2026-06-01T00:00:00Z'), approximate: true });

    const nothing = planMarkers({
      items: [item('a')],
      logRows: [log('a', 'INV-24', { createdAt: undefined, updatedAt: undefined })],
    });
    expect(nothing.markers[0]).toMatchObject({ invoicedBy: 'INV-24', invoicedAt: null, approximate: true });
  });

  it('never overwrites a marker, a pending claim included, and counts them', () => {
    const plan = planMarkers({
      items: [item('a', { invoicedBy: 'INV-1' }), item('b', { invoicedBy: 'pending:ndis:20260701-0900:Jane' }), item('c', { invoicedBy: '' })],
      logRows: [log('a', 'INV-24'), log('b', 'INV-25'), log('c', 'INV-26')],
    });
    expect(plan.markers.map((m) => m.itemId)).toEqual(['c']);
    expect(plan.report.counts.alreadyMarked).toBe(2);
  });

  it('lists log rows of items that no longer exist, and marks nothing for them', () => {
    const plan = planMarkers({ items: [], logRows: [log('gone', 'INV-24')] });
    expect(plan.markers).toEqual([]);
    expect(plan.report.lists.deletedItems).toEqual([{ itemId: 'gone', number: 'INV-24' }]);
  });

  it('flags a date taken from a log row that was revisited later as approximate and counts it', () => {
    const plan = planMarkers({
      items: [item('a'), item('b')],
      logRows: [
        log('a', 'INV-24', { createdAt: new Date('2026-05-01T00:00:00Z'), updatedAt: new Date('2026-07-01T00:00:00Z') }),
        log('b', 'INV-24'),
      ],
    });
    expect(plan.markers.map((m) => [m.itemId, m.approximate])).toEqual([['a', true], ['b', false]]);
    expect(plan.report.counts.approximateDates).toBe(1);
  });

  it('skips only a log row with no usable number, and lists it; a bad date never leaves an item unmarked', () => {
    const plan = planMarkers({
      items: [item('a'), item('b')],
      logRows: [log('a', ''), log('b', 'INV-24', { createdAt: 'not a date', updatedAt: 'not a date' })],
    });
    expect(plan.markers.map((m) => m.itemId)).toEqual(['b']);
    expect(plan.report.lists.unusableRows.map((r) => r.itemId)).toEqual(['a']);
  });

  it('is deterministic: the same inputs in any order give the same plan', () => {
    const a = planMarkers({ items: [item('a'), item('b')], logRows: [log('a', 'INV-1'), log('b', 'INV-2')] });
    const b = planMarkers({ items: [item('b'), item('a')], logRows: [log('b', 'INV-2'), log('a', 'INV-1')] });
    expect(a.markers).toEqual(b.markers);
  });

  it('does not change its inputs', () => {
    const items = [item('a')];
    const logRows = [log('a', 'INV-24')];
    const before = JSON.stringify({ items, logRows });
    planMarkers({ items, logRows });
    expect(JSON.stringify({ items, logRows })).toBe(before);
  });
});

describe('formatMarkerResult', () => {
  const planned = [{ workspaceId: 'w1', plan: { markers: [], report: { counts: {}, lists: { deletedItems: [{ itemId: 'x', number: 'INV-1' }], unusableRows: [] } } } }];
  const totals = { toMark: 3, alreadyMarked: 1, deletedItems: 1, unusableRows: 0, hadBothTypes: 1, approximateDates: 2, byType: { PDF: 2, Xero: 1 } };

  it('says it was a dry run, what it would mark, what is approximate, and the plan hash to pass back', () => {
    const text = formatMarkerResult({ applied: false, totals, planned, planHash: 'abc123def456' }).join('\n');
    expect(text).toMatch(/DRY RUN: nothing was written/);
    expect(text).toMatch(/items to mark\s+3/);
    expect(text).toMatch(/items whose log rows are unusable/);
    expect(text).toMatch(/from PDF rows\s+2/);
    expect(text).toMatch(/dates that are approximate\s+2/);
    expect(text).toMatch(/Plan hash: abc123def456/);
    expect(text).toMatch(/--apply --plan <hash>/);
  });

  it('says what an applied run wrote, and what an undo did', () => {
    const applied = formatMarkerResult({ applied: true, totals, planned, results: [{ workspaceId: 'w1', marked: 3 }] }).join('\n');
    expect(applied).toMatch(/APPLIED/);
    expect(applied).toMatch(/w1\s+marked 3/);
    expect(formatMarkerResult({ applied: false, undone: { items: 3, preview: true } }).join('\n')).toMatch(/UNDO PREVIEW.*\n.*would clear 3/);
    expect(formatMarkerResult({ applied: false, undone: { items: 3, preview: false } }).join('\n')).toMatch(/cleared 3/);
  });
});
