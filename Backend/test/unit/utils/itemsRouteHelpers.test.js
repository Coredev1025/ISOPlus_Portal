import { describe, it, expect, vi } from 'vitest';
import {
  compareServiceItems,
  resolveInvoiceIssuedValue,
  parseListPagination,
  matchesStatusFilter,
  applyInvoiceStatusUpdates,
} from '../../../src/utils/itemsRouteHelpers.js';

/**
 * A projected service row as buildMonthlyStatementServiceRows produces it:
 * the stored Item under `item`, with the two dates already parsed to Date or
 * null.
 */
function serviceRow({ itemId, scheduledStartDate = null, actualEndDate = null, updatedAt, createdAt }) {
  return {
    item: {
      itemId,
      workspaceId: 'wsp_1',
      boardId: 'brd_services',
      updatedAt,
      createdAt,
      data: {},
    },
    scheduledStartDate,
    actualEndDate,
    filterDate: scheduledStartDate,
    participantName: 'Jane Doe',
    transactionStatusFormatted: 'Delivered',
    fundingSourceResolved: 'NDIS',
    totalAmountNum: 120,
  };
}

/** An Item document as routes/items.js loads it before patching invoice status. */
function invoiceItem(data = {}) {
  return {
    itemId: 'itm_1',
    workspaceId: 'wsp_1',
    boardId: 'brd_jobs',
    data,
  };
}

describe('compareServiceItems', () => {
  const byScheduledAsc = { sortByDate: true, useDeliveryDate: false, serviceSortOrder: 'asc' };

  it('orders by scheduled start date ascending', () => {
    const early = serviceRow({ itemId: 'a', scheduledStartDate: new Date('2026-06-01T00:00:00.000Z') });
    const late = serviceRow({ itemId: 'b', scheduledStartDate: new Date('2026-06-05T00:00:00.000Z') });

    expect(compareServiceItems(early, late, byScheduledAsc)).toBe(-1);
    expect(compareServiceItems(late, early, byScheduledAsc)).toBe(1);
    expect(compareServiceItems(early, early, byScheduledAsc)).toBe(0);
  });

  it('reverses the comparison for a descending sort order', () => {
    const early = serviceRow({ itemId: 'a', scheduledStartDate: new Date('2026-06-01T00:00:00.000Z') });
    const late = serviceRow({ itemId: 'b', scheduledStartDate: new Date('2026-06-05T00:00:00.000Z') });

    expect(compareServiceItems(early, late, { sortByDate: true, useDeliveryDate: false, serviceSortOrder: 'desc' }))
      .toBe(1);
  });

  it('uses the actual end date when sorting by delivery date', () => {
    const a = serviceRow({
      itemId: 'a',
      scheduledStartDate: new Date('2026-06-01T00:00:00.000Z'),
      actualEndDate: new Date('2026-06-10T00:00:00.000Z'),
    });
    const b = serviceRow({
      itemId: 'b',
      scheduledStartDate: new Date('2026-06-05T00:00:00.000Z'),
      actualEndDate: new Date('2026-06-02T00:00:00.000Z'),
    });

    expect(compareServiceItems(a, b, { sortByDate: true, useDeliveryDate: true, serviceSortOrder: 'asc' })).toBe(1);
    expect(compareServiceItems(a, b, byScheduledAsc)).toBe(-1);
  });

  it('pushes rows with no date to the end regardless of sort order', () => {
    const dated = serviceRow({ itemId: 'a', scheduledStartDate: new Date('2026-06-01T00:00:00.000Z') });
    const undated = serviceRow({ itemId: 'b' });

    expect(compareServiceItems(undated, dated, byScheduledAsc)).toBe(1);
    expect(compareServiceItems(dated, undated, byScheduledAsc)).toBe(-1);
    expect(compareServiceItems(undated, dated, { sortByDate: true, useDeliveryDate: false, serviceSortOrder: 'desc' }))
      .toBe(1);
    expect(compareServiceItems(undated, undated, byScheduledAsc)).toBe(0);
  });

  it('compares non-Date values directly', () => {
    const a = serviceRow({ itemId: 'a', scheduledStartDate: '2026-06-01' });
    const b = serviceRow({ itemId: 'b', scheduledStartDate: '2026-06-05' });
    expect(compareServiceItems(a, b, byScheduledAsc)).toBe(-1);

    const early = serviceRow({ itemId: 'c', scheduledStartDate: 1000 });
    const later = serviceRow({ itemId: 'd', scheduledStartDate: 2000 });
    expect(compareServiceItems(later, early, byScheduledAsc)).toBe(1);
  });

  it('sorts by most recently updated first when not sorting by date', () => {
    const older = serviceRow({ itemId: 'a', updatedAt: new Date('2026-06-01T00:00:00.000Z') });
    const newer = serviceRow({ itemId: 'b', updatedAt: new Date('2026-06-09T00:00:00.000Z') });

    expect(compareServiceItems(newer, older, { sortByDate: false })).toBe(-1);
    expect(compareServiceItems(older, newer, { sortByDate: false })).toBe(1);
    expect(compareServiceItems(older, older, { sortByDate: false })).toBe(0);
  });

  it('ignores the sort order when falling back to the updated comparator', () => {
    const older = serviceRow({ itemId: 'a', updatedAt: new Date('2026-06-01T00:00:00.000Z') });
    const newer = serviceRow({ itemId: 'b', updatedAt: new Date('2026-06-09T00:00:00.000Z') });

    expect(compareServiceItems(newer, older, { sortByDate: false, serviceSortOrder: 'desc' })).toBe(-1);
  });

  it('falls back to createdAt, then to the epoch, and accepts string timestamps', () => {
    const created = serviceRow({ itemId: 'a', createdAt: '2026-06-09T00:00:00.000Z' });
    const neverTouched = serviceRow({ itemId: 'b' });

    expect(compareServiceItems(created, neverTouched, { sortByDate: false })).toBe(-1);
    expect(compareServiceItems(neverTouched, neverTouched, { sortByDate: false })).toBe(0);
  });

  it('produces the expected order when used as an Array#sort comparator', () => {
    const rows = [
      serviceRow({ itemId: 'b', scheduledStartDate: new Date('2026-06-05T00:00:00.000Z') }),
      serviceRow({ itemId: 'none' }),
      serviceRow({ itemId: 'a', scheduledStartDate: new Date('2026-06-01T00:00:00.000Z') }),
      serviceRow({ itemId: 'c', scheduledStartDate: new Date('2026-06-09T00:00:00.000Z') }),
    ];

    rows.sort((x, y) => compareServiceItems(x, y, byScheduledAsc));

    expect(rows.map((r) => r.item.itemId)).toEqual(['a', 'b', 'c', 'none']);
  });
});

describe('resolveInvoiceIssuedValue', () => {
  it('maps "invoiced" to true, case-insensitively', () => {
    expect(resolveInvoiceIssuedValue('invoiced')).toBe(true);
    expect(resolveInvoiceIssuedValue('Invoiced')).toBe(true);
    expect(resolveInvoiceIssuedValue('INVOICED')).toBe(true);
  });

  it('maps "pending" and "not invoiced" to false', () => {
    expect(resolveInvoiceIssuedValue('pending')).toBe(false);
    expect(resolveInvoiceIssuedValue('Pending')).toBe(false);
    expect(resolveInvoiceIssuedValue('Not Invoiced')).toBe(false);
  });

  it('returns undefined for any other status, so the attribute is left alone', () => {
    expect(resolveInvoiceIssuedValue('draft')).toBeUndefined();
    expect(resolveInvoiceIssuedValue('')).toBeUndefined();
    expect(resolveInvoiceIssuedValue('not-invoiced')).toBeUndefined();
    expect(resolveInvoiceIssuedValue(null)).toBeUndefined();
    expect(resolveInvoiceIssuedValue(undefined)).toBeUndefined();
    expect(resolveInvoiceIssuedValue(true)).toBeUndefined();
  });
});

describe('parseListPagination', () => {
  it('paginates when a positive numeric limit is supplied', () => {
    expect(parseListPagination('3', '25')).toEqual({
      limitNumber: 25,
      applyPagination: true,
      pageNumber: 3,
      skip: 50,
    });
  });

  it('defaults to page 1 when the page is missing or not a positive integer', () => {
    expect(parseListPagination(undefined, '25')).toEqual({
      limitNumber: 25, applyPagination: true, pageNumber: 1, skip: 0,
    });
    expect(parseListPagination('0', '25').pageNumber).toBe(1);
    expect(parseListPagination('-2', '25').pageNumber).toBe(1);
    expect(parseListPagination('abc', '25').pageNumber).toBe(1);
  });

  it('disables pagination when no limit is supplied', () => {
    const off = { limitNumber: null, applyPagination: false, pageNumber: 1, skip: 0 };
    expect(parseListPagination('4', undefined)).toEqual(off);
    expect(parseListPagination('4', null)).toEqual(off);
    expect(parseListPagination('4', '')).toEqual(off);
  });

  it('disables pagination for the "all" sentinel, case-insensitively', () => {
    expect(parseListPagination('4', 'all')).toEqual({
      limitNumber: null, applyPagination: false, pageNumber: 1, skip: 0,
    });
    expect(parseListPagination('4', 'ALL').applyPagination).toBe(false);
  });

  it('disables pagination for a non-positive or unparseable limit', () => {
    expect(parseListPagination('4', '0').applyPagination).toBe(false);
    expect(parseListPagination('4', '-10').applyPagination).toBe(false);
    expect(parseListPagination('4', 'abc').applyPagination).toBe(false);
  });

  it('accepts numeric limits and pages, and a trailing-garbage limit', () => {
    expect(parseListPagination(2, 10)).toEqual({
      limitNumber: 10, applyPagination: true, pageNumber: 2, skip: 10,
    });
    expect(parseListPagination('1', '25abc')).toEqual({
      limitNumber: 25, applyPagination: true, pageNumber: 1, skip: 0,
    });
  });
});

describe('matchesStatusFilter', () => {
  it('matches any name in the label-name array', () => {
    expect(matchesStatusFilter(['Invoiced', 'Paid'], null, 'Paid')).toBe(true);
    expect(matchesStatusFilter(['Invoiced', 'Paid'], null, 'Pending')).toBe(false);
  });

  it('matches a single non-array name', () => {
    expect(matchesStatusFilter('Invoiced', null, 'Invoiced')).toBe(true);
    expect(matchesStatusFilter('Invoiced', null, 'Paid')).toBe(false);
  });

  it('falls back to the raw value when the names do not match', () => {
    expect(matchesStatusFilter(['Invoiced'], 'lbl_paid', 'lbl_paid')).toBe(true);
    expect(matchesStatusFilter([], 'lbl_paid', 'lbl_paid')).toBe(true);
    expect(matchesStatusFilter(null, 'lbl_paid', 'lbl_paid')).toBe(true);
  });

  it('joins a raw array with single spaces before comparing', () => {
    expect(matchesStatusFilter(null, ['lbl_a', 'lbl_b'], 'lbl_a lbl_b')).toBe(true);
    expect(matchesStatusFilter(null, ['lbl_a', 'lbl_b'], 'lbl_a')).toBe(false);
  });

  it('returns false when there is nothing to compare against', () => {
    expect(matchesStatusFilter(null, null, 'Paid')).toBe(false);
    expect(matchesStatusFilter([], '', 'Paid')).toBe(false);
    expect(matchesStatusFilter(undefined, 0, 'Paid')).toBe(false);
  });

  it('compares loosely, so a numeric filter matches a stringified id', () => {
    expect(matchesStatusFilter([5], null, '5')).toBe(true);
    expect(matchesStatusFilter(null, 7, 7)).toBe(true);
  });
});

describe('applyInvoiceStatusUpdates', () => {
  it('sets the invoice-issued flag and the invoice number', () => {
    const item = invoiceItem({ 'Invoice Issued and Sent': false });
    const info = vi.fn();

    const changed = applyInvoiceStatusUpdates(
      item,
      { invoiceIssuedValue: true, invoiceNumber: 'INV-1042', fileUrl: undefined },
      info,
    );

    expect(changed).toBe(true);
    expect(item.data).toEqual({
      'Invoice Issued and Sent': true,
      'Generated Invoice Number': 'INV-1042',
    });
    expect(info).not.toHaveBeenCalled();
  });

  it('reports no change when the values already match', () => {
    const item = invoiceItem({ 'Invoice Issued and Sent': true, 'Generated Invoice Number': 'INV-1042' });

    const changed = applyInvoiceStatusUpdates(
      item,
      { invoiceIssuedValue: true, invoiceNumber: 'INV-1042' },
      vi.fn(),
    );

    expect(changed).toBe(false);
    expect(item.data).toEqual({ 'Invoice Issued and Sent': true, 'Generated Invoice Number': 'INV-1042' });
  });

  it('leaves the flag untouched when the status did not resolve to a boolean', () => {
    const item = invoiceItem({ 'Invoice Issued and Sent': true });

    expect(applyInvoiceStatusUpdates(item, { invoiceIssuedValue: undefined }, vi.fn())).toBe(false);
    expect(item.data).toEqual({ 'Invoice Issued and Sent': true });
  });

  it('writes false for a "pending" status', () => {
    const item = invoiceItem({ 'Invoice Issued and Sent': true });

    expect(applyInvoiceStatusUpdates(item, { invoiceIssuedValue: false }, vi.fn())).toBe(true);
    expect(item.data['Invoice Issued and Sent']).toBe(false);
  });

  it('ignores a blank invoice number', () => {
    const item = invoiceItem({});

    expect(applyInvoiceStatusUpdates(item, { invoiceNumber: '' }, vi.fn())).toBe(false);
    expect(item.data).toEqual({});
  });

  it('writes the file URL to the first file attribute only', () => {
    const item = invoiceItem({});

    const changed = applyInvoiceStatusUpdates(
      item,
      { fileUrl: 'https://files.example.com/inv-1042.pdf' },
      vi.fn(),
    );

    expect(changed).toBe(true);
    expect(item.data).toEqual({ 'Invoice File URL': 'https://files.example.com/inv-1042.pdf' });
  });

  it('moves to the next file attribute when the first already holds the URL', () => {
    const fileUrl = 'https://files.example.com/inv-1042.pdf';
    const item = invoiceItem({ 'Invoice File URL': fileUrl });

    expect(applyInvoiceStatusUpdates(item, { fileUrl }, vi.fn())).toBe(true);
    expect(item.data).toEqual({
      'Invoice File URL': fileUrl,
      'Invoice PDF Link': fileUrl,
    });
  });

  it('logs when every file attribute already holds the URL', () => {
    const fileUrl = 'https://files.example.com/inv-1042.pdf';
    const item = invoiceItem({
      'Invoice File URL': fileUrl,
      'Invoice PDF Link': fileUrl,
      'Generated Invoice File URL': fileUrl,
      'Generated Invoice Link': fileUrl,
    });
    const info = vi.fn();

    expect(applyInvoiceStatusUpdates(item, { fileUrl }, info)).toBe(false);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      'Items-Service',
      'No matching attribute found for invoice file URL',
      { itemId: 'itm_1', workspaceId: 'wsp_1', boardId: 'brd_jobs' },
    );
  });

  it('applies all three updates together', () => {
    const item = invoiceItem({ 'Invoice Issued and Sent': false });

    const changed = applyInvoiceStatusUpdates(
      item,
      {
        invoiceIssuedValue: true,
        invoiceNumber: 'INV-1042 (Xero)',
        fileUrl: 'https://files.example.com/inv-1042.pdf',
      },
      vi.fn(),
    );

    expect(changed).toBe(true);
    expect(item.data).toEqual({
      'Invoice Issued and Sent': true,
      'Generated Invoice Number': 'INV-1042 (Xero)',
      'Invoice File URL': 'https://files.example.com/inv-1042.pdf',
    });
  });
});
