import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';

import Item from '../../../src/models/Item.js';

/**
 * Section 2 of the invoice selection spec, applied to a real run.
 *
 * `selectInvoiceableItems` is the pure rule and is tested against the spec's
 * table in invoiceItemSelection.test.js. This is the seam that puts it in front
 * of generation: the Invoice Generator list decides what a period *contains*,
 * and this decides what of it is *billable* under the board's invoice type.
 *
 * The risk it carries is under-billing, not double billing, so every id it
 * drops is counted in a log line rather than dropped quietly.
 */

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, info: vi.fn(), warn: vi.fn() };
});

const { warn } = await import('../../../src/utils/logger.js');
const { selectBillableItemIds } = await import('../../../src/utils/automationItemSelection.js');

const WS = 'ws-sel';
const BOARD = 'board-sel';
const PERIOD = { start: '2025-12-01T00:00:00.000+11:00', end: '2025-12-31T23:59:59.999+11:00' };

const shift = (itemId, overrides = {}) => ({
  workspaceId: WS,
  boardId: BOARD,
  folderId: 'f1',
  itemId,
  data: {
    'Job Status': 'Completed',
    'Actual Shift Start Date and Time': '2025-12-10T09:00:00.000000+11:00',
    ...overrides,
  },
});

beforeEach(async () => {
  vi.clearAllMocks();
});

describe('selectBillableItemIds', () => {
  it('keeps the items whose status and date both qualify', async () => {
    await Item.insertMany([shift('a'), shift('b')]);

    const selected = await selectBillableItemIds({
      workspaceId: WS, boardId: BOARD, itemIds: ['a', 'b'], invoiceType: 'ndis-certification', period: PERIOD,
    });

    expect(selected.sort()).toEqual(['a', 'b']);
  });

  it('drops an item whose status does not qualify, and says how many', async () => {
    await Item.insertMany([shift('a'), shift('b', { 'Job Status': 'In Progress' })]);

    const selected = await selectBillableItemIds({
      workspaceId: WS, boardId: BOARD, itemIds: ['a', 'b'], invoiceType: 'ndis-certification', period: PERIOD,
    });

    expect(selected).toEqual(['a']);
    const line = warn.mock.calls.find(([, message]) => /selection/i.test(message));
    expect(line[2]).toMatchObject({ listed: 2, selected: 1, dropped: 1 });
  });

  it('drops an item dated outside the period', async () => {
    await Item.insertMany([
      shift('a'),
      shift('b', {
        'Actual Shift Start Date and Time': '2025-11-10T09:00:00.000000+11:00',
        'Scheduled Shift Start Date & Time': '2025-11-09T09:00:00.000000+11:00',
      }),
    ]);

    const selected = await selectBillableItemIds({
      workspaceId: WS, boardId: BOARD, itemIds: ['a', 'b'], invoiceType: 'ndis-certification', period: PERIOD,
    });

    expect(selected).toEqual(['a']);
  });

  it('keeps the listed ids untouched when the board is not one of the five types', async () => {
    // invoiceTypeFromBoardLabel returns null for a label the spec's table does
    // not cover — 'Care Management - NDIS - 2026 Pricing' is a real one. The
    // spec is explicit that conditions must not be inferred, so the only honest
    // answer is to leave the list query's own window as the rule and say so.
    await Item.insertMany([shift('a'), shift('b', { 'Job Status': 'In Progress' })]);

    const selected = await selectBillableItemIds({
      workspaceId: WS, boardId: BOARD, itemIds: ['a', 'b'], invoiceType: null, period: PERIOD,
    });

    expect(selected.sort()).toEqual(['a', 'b']);
    expect(warn.mock.calls.some(([, message]) => /no selection conditions/i.test(message))).toBe(true);
  });

  it('preserves the order the list gave, so the invoice rows do not reshuffle', async () => {
    await Item.insertMany([shift('a'), shift('b'), shift('c')]);

    const selected = await selectBillableItemIds({
      workspaceId: WS, boardId: BOARD, itemIds: ['c', 'a', 'b'], invoiceType: 'ndis-certification', period: PERIOD,
    });

    expect(selected).toEqual(['c', 'a', 'b']);
  });

  it('drops a listed id that has no stored item rather than assuming it qualifies', async () => {
    await Item.insertMany([shift('a')]);

    const selected = await selectBillableItemIds({
      workspaceId: WS, boardId: BOARD, itemIds: ['a', 'ghost'], invoiceType: 'ndis-certification', period: PERIOD,
    });

    expect(selected).toEqual(['a']);
  });

  it('skips an item a completed invoice already holds', async () => {
    await Item.insertMany([shift('a'), shift('b')]);
    await Item.updateOne({ itemId: 'b' }, { $set: { invoicedBy: 'INV-9001 (ISO+\u2122)' } });

    const selected = await selectBillableItemIds({
      workspaceId: WS, boardId: BOARD, itemIds: ['a', 'b'], invoiceType: 'ndis-certification', period: PERIOD,
    });

    expect(selected).toEqual(['a']);
  });

  it('leaves a provisional claim for the claim protocol to adjudicate', async () => {
    // A `pending:` token is a run in progress, not an invoice. Dropping those
    // here would break the retry that the deterministic token exists for: a job
    // that failed after claiming would never see its own items again.
    // claimItemsForInvoice is the atomic gate, and it takes an item back only
    // when the token is its own.
    await Item.insertMany([shift('a'), shift('b')]);
    await Item.updateOne(
      { itemId: 'b' },
      { $set: { invoicedBy: 'pending:NDIS Invoice:2025-12:Jane Smith' } },
    );

    const selected = await selectBillableItemIds({
      workspaceId: WS, boardId: BOARD, itemIds: ['a', 'b'], invoiceType: 'ndis-certification', period: PERIOD,
    });

    expect(selected.sort()).toEqual(['a', 'b']);
  });

  it('returns an empty list without touching the database for an empty input', async () => {
    expect(await selectBillableItemIds({
      workspaceId: WS, boardId: BOARD, itemIds: [], invoiceType: 'ndis-certification', period: PERIOD,
    })).toEqual([]);
  });
});
