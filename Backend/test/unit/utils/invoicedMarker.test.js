import { describe, it, expect, beforeEach } from 'vitest';

import Item from '../../../src/models/Item.js';
import { buildBacklogBulkOp } from '../../../src/utils/syncWorkerBacklogHelpers.js';
import {
  claimItemsForInvoice,
  markItemsInvoiced,
  releaseItemClaim,
} from '../../../src/utils/invoicedMarker.js';

/**
 * Section 3.2 of the invoice selection spec: an item must appear on exactly one
 * invoice, and the only place that can be recorded is the item itself.
 *
 * The claim is conditional and the release is scoped to the invoice number that
 * made the claim. That pair is what section 3.4 asks for without a transaction:
 * the codebase has no replica set and uses no sessions anywhere, so the
 * invoice write and the marking cannot literally share one commit.
 */

const WS = 'ws-1';
const BOARD = 'board-1';
const INVOICE = 'INV-1194 (ISO+™)';
const OTHER_INVOICE = 'INV-1195 (ISO+™)';
const PERIOD = '2025-01';

async function seedItems(ids) {
  await Item.insertMany(ids.map((itemId) => ({
    workspaceId: WS,
    boardId: BOARD,
    folderId: 'f1',
    itemId,
    data: { 'Job Status': 'Completed' },
  })));
}

const invoicedBy = async (itemId) => (await Item.findOne({ itemId }).lean())?.invoicedBy ?? null;

beforeEach(async () => {
  await seedItems(['a', 'b', 'c']);
});

describe('claimItemsForInvoice', () => {
  it('claims every unclaimed item and reports them', async () => {
    const result = await claimItemsForInvoice({
      workspaceId: WS, boardId: BOARD, itemIds: ['a', 'b'], invoiceNumber: INVOICE, periodKey: PERIOD,
    });
    expect(result.claimed.sort()).toEqual(['a', 'b']);
    expect(result.rejected).toEqual([]);
    expect(await invoicedBy('a')).toBe(INVOICE);
    expect(await invoicedBy('b')).toBe(INVOICE);
  });

  it('records the period and the time of the claim', async () => {
    await claimItemsForInvoice({
      workspaceId: WS, boardId: BOARD, itemIds: ['a'], invoiceNumber: INVOICE, periodKey: PERIOD,
    });
    const row = await Item.findOne({ itemId: 'a' }).lean();
    expect(row.invoicedPeriodKey).toBe(PERIOD);
    expect(row.invoicedAt).toBeInstanceOf(Date);
  });

  it('refuses an item another invoice already claimed, and leaves that claim intact', async () => {
    await claimItemsForInvoice({
      workspaceId: WS, boardId: BOARD, itemIds: ['a'], invoiceNumber: INVOICE, periodKey: PERIOD,
    });
    const second = await claimItemsForInvoice({
      workspaceId: WS, boardId: BOARD, itemIds: ['a', 'b'], invoiceNumber: OTHER_INVOICE, periodKey: PERIOD,
    });
    expect(second.claimed).toEqual(['b']);
    expect(second.rejected).toEqual(['a']);
    expect(await invoicedBy('a')).toBe(INVOICE);
  });

  it('is idempotent for the same invoice number, so a retried run does not double count', async () => {
    const first = await claimItemsForInvoice({
      workspaceId: WS, boardId: BOARD, itemIds: ['a'], invoiceNumber: INVOICE, periodKey: PERIOD,
    });
    const retry = await claimItemsForInvoice({
      workspaceId: WS, boardId: BOARD, itemIds: ['a'], invoiceNumber: INVOICE, periodKey: PERIOD,
    });
    expect(first.claimed).toEqual(['a']);
    expect(retry.claimed).toEqual(['a']);
    expect(retry.rejected).toEqual([]);
  });

  it('does not claim an item belonging to another workspace', async () => {
    const result = await claimItemsForInvoice({
      workspaceId: 'other-ws', boardId: BOARD, itemIds: ['a'], invoiceNumber: INVOICE, periodKey: PERIOD,
    });
    expect(result.claimed).toEqual([]);
    expect(await invoicedBy('a')).toBe(null);
  });

  it('returns empty for an empty item list without touching anything', async () => {
    const result = await claimItemsForInvoice({
      workspaceId: WS, boardId: BOARD, itemIds: [], invoiceNumber: INVOICE, periodKey: PERIOD,
    });
    expect(result).toEqual({ claimed: [], rejected: [] });
  });
});

describe('releaseItemClaim', () => {
  it('clears a claim this invoice made, so the next run can bill the item', async () => {
    await claimItemsForInvoice({
      workspaceId: WS, boardId: BOARD, itemIds: ['a'], invoiceNumber: INVOICE, periodKey: PERIOD,
    });
    await releaseItemClaim({
      workspaceId: WS, boardId: BOARD, itemIds: ['a'], invoiceNumber: INVOICE,
    });
    const row = await Item.findOne({ itemId: 'a' }).lean();
    expect(row.invoicedBy).toBeUndefined();
    expect(row.invoicedPeriodKey).toBeUndefined();
  });

  it('refuses to clear a claim a different invoice holds', async () => {
    await claimItemsForInvoice({
      workspaceId: WS, boardId: BOARD, itemIds: ['a'], invoiceNumber: INVOICE, periodKey: PERIOD,
    });
    await releaseItemClaim({
      workspaceId: WS, boardId: BOARD, itemIds: ['a'], invoiceNumber: OTHER_INVOICE,
    });
    expect(await invoicedBy('a')).toBe(INVOICE);
  });

  it('is scoped to the workspace and board, matching the claim it reverses', async () => {
    // The claim narrows by workspace + board + item; an unscoped release would
    // reach outside that. itemId is a globally unique id today, which is the
    // only reason the asymmetry was harmless — the release must not depend on
    // that staying true.
    await claimItemsForInvoice({
      workspaceId: WS, boardId: BOARD, itemIds: ['a'], invoiceNumber: INVOICE, periodKey: PERIOD,
    });
    await releaseItemClaim({
      workspaceId: 'other-ws', boardId: BOARD, itemIds: ['a'], invoiceNumber: INVOICE,
    });
    expect(await invoicedBy('a')).toBe(INVOICE);

    await releaseItemClaim({
      workspaceId: WS, boardId: 'other-board', itemIds: ['a'], invoiceNumber: INVOICE,
    });
    expect(await invoicedBy('a')).toBe(INVOICE);
  });
});

describe('markItemsInvoiced (the manual path, section 3.3)', () => {
  it('marks items so a later automated run will not bill them again', async () => {
    await markItemsInvoiced({
      workspaceId: WS, boardId: BOARD, itemIds: ['a', 'b'], invoiceNumber: INVOICE,
    });
    expect(await invoicedBy('a')).toBe(INVOICE);
    expect(await invoicedBy('b')).toBe(INVOICE);
  });

  it('overwrites an existing marker, because a manual invoice is a deliberate act', async () => {
    await markItemsInvoiced({
      workspaceId: WS, boardId: BOARD, itemIds: ['a'], invoiceNumber: INVOICE,
    });
    await markItemsInvoiced({
      workspaceId: WS, boardId: BOARD, itemIds: ['a'], invoiceNumber: OTHER_INVOICE,
    });
    expect(await invoicedBy('a')).toBe(OTHER_INVOICE);
  });
});

describe('the marker survives a sync', () => {
  it('is not erased when sync replaces the item data wholesale', async () => {
    // This is why the marker is a top-level field and not a key inside `data`.
    // Sync's bulk op is `$set: { ..., data: transformedData }` — anything held
    // inside `data` is gone on the next run, and the item would be billed
    // again.
    await claimItemsForInvoice({
      workspaceId: WS, boardId: BOARD, itemIds: ['a'], invoiceNumber: INVOICE, periodKey: PERIOD,
    });

    const { bulkOp } = buildBacklogBulkOp(
      { id: 'a', folder_id: 'f1' },
      WS,
      BOARD,
      'sync-guid-1',
      () => ({ 'Job Status': 'Completed', 'Actual Shift Start Date and Time': '2025-01-07T11:00:00.000000+11:00' }),
    );
    await Item.bulkWrite([bulkOp]);

    const row = await Item.findOne({ itemId: 'a' }).lean();
    expect(row.invoicedBy).toBe(INVOICE);
    expect(row.data['Actual Shift Start Date and Time']).toBe('2025-01-07T11:00:00.000000+11:00');
  });
});
