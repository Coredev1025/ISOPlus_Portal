import { describe, it, expect, beforeEach, vi } from 'vitest';

import Item from '../../../src/models/Item.js';
import { claimItemsForInvoice } from '../../../src/utils/invoicedMarker.js';
import {
  generateUnderClaim,
  provisionalClaimToken,
} from '../../../src/utils/automationInvoiceClaim.js';

/**
 * Section 3.4: the invoice write and the item marking must succeed or fail
 * together, and where that is impossible the failure must leave items unbilled
 * rather than billed twice.
 */

const WS = 'ws-1';
const BOARD = 'board-1';
const TYPE = 'NDIS Invoice';
const PERIOD = '2025-01';
const PARTICIPANT = 'Jane Doe';

const base = {
  workspaceId: WS, boardId: BOARD, type: TYPE, periodKey: PERIOD, participant: PARTICIPANT,
};

const invoicedBy = async (itemId) => (await Item.findOne({ itemId }).lean())?.invoicedBy ?? null;

beforeEach(async () => {
  await Item.insertMany(['a', 'b'].map((itemId) => ({
    workspaceId: WS, boardId: BOARD, folderId: 'f1', itemId, data: {},
  })));
});

describe('generateUnderClaim — the happy path', () => {
  it('marks the items with the real invoice number the generator produced', async () => {
    const result = await generateUnderClaim({
      ...base,
      itemIds: ['a', 'b'],
      produce: async () => ({ invoiceNumber: 'INV-3001 (ISO+™)', fileUrl: 'https://s3/x.pdf' }),
    });

    expect(result.invoiceNumber).toBe('INV-3001 (ISO+™)');
    expect(result.itemIds.sort()).toEqual(['a', 'b']);
    expect(await invoicedBy('a')).toBe('INV-3001 (ISO+™)');
    expect(await invoicedBy('b')).toBe('INV-3001 (ISO+™)');
  });

  it('hands the generator only the items the claim actually took', async () => {
    await claimItemsForInvoice({
      workspaceId: WS, boardId: BOARD, itemIds: ['a'], invoiceNumber: 'INV-OTHER', periodKey: PERIOD,
    });
    const produce = vi.fn(async () => ({ invoiceNumber: 'INV-3002 (ISO+™)' }));

    await generateUnderClaim({ ...base, itemIds: ['a', 'b'], produce });

    expect(produce).toHaveBeenCalledWith(['b']);
    // The item another invoice holds keeps that claim and stays off this PDF.
    expect(await invoicedBy('a')).toBe('INV-OTHER');
  });
});

describe('generateUnderClaim — failure leaves items billable', () => {
  it('releases the claim and rethrows when the generator throws', async () => {
    const boom = new Error('pdfme exploded');
    await expect(generateUnderClaim({
      ...base,
      itemIds: ['a', 'b'],
      produce: async () => { throw boom; },
    })).rejects.toThrow('pdfme exploded');

    // Unbilled and unmarked, so the next run picks them up. This is the
    // direction section 3.4 says to fail in.
    expect(await invoicedBy('a')).toBe(null);
    expect(await invoicedBy('b')).toBe(null);
  });

  it('releases the claim when the generator reports the period empty', async () => {
    const result = await generateUnderClaim({
      ...base,
      itemIds: ['a'],
      produce: async () => ({ empty: true }),
    });
    expect(result).toBe(null);
    expect(await invoicedBy('a')).toBe(null);
  });

  it('releases the claim when the generator returns no invoice number', async () => {
    const result = await generateUnderClaim({
      ...base,
      itemIds: ['a'],
      produce: async () => ({ fileUrl: 'https://s3/x.pdf' }),
    });
    expect(result).toBe(null);
    expect(await invoicedBy('a')).toBe(null);
  });

  it('does not release a claim a different invoice holds', async () => {
    await claimItemsForInvoice({
      workspaceId: WS, boardId: BOARD, itemIds: ['a'], invoiceNumber: 'INV-OTHER', periodKey: PERIOD,
    });
    await expect(generateUnderClaim({
      ...base,
      itemIds: ['a', 'b'],
      produce: async () => { throw new Error('boom'); },
    })).rejects.toThrow('boom');

    expect(await invoicedBy('a')).toBe('INV-OTHER');
    expect(await invoicedBy('b')).toBe(null);
  });
});

describe('generateUnderClaim — nothing to bill (section 3.5)', () => {
  it('produces nothing and calls no generator when every item is already invoiced', async () => {
    await claimItemsForInvoice({
      workspaceId: WS, boardId: BOARD, itemIds: ['a', 'b'], invoiceNumber: 'INV-OTHER', periodKey: PERIOD,
    });
    const produce = vi.fn();

    const result = await generateUnderClaim({ ...base, itemIds: ['a', 'b'], produce });

    expect(result).toBe(null);
    expect(produce).not.toHaveBeenCalled();
  });
});

describe('generateUnderClaim — retry', () => {
  it('re-claims its own items after a crash left the provisional token behind', async () => {
    // Simulates a run that claimed and then died before releasing.
    const token = provisionalClaimToken({ type: TYPE, periodKey: PERIOD, participant: PARTICIPANT });
    await claimItemsForInvoice({
      workspaceId: WS, boardId: BOARD, itemIds: ['a'], invoiceNumber: token, periodKey: PERIOD,
    });

    const result = await generateUnderClaim({
      ...base,
      itemIds: ['a'],
      produce: async () => ({ invoiceNumber: 'INV-3003 (ISO+™)' }),
    });

    expect(result.invoiceNumber).toBe('INV-3003 (ISO+™)');
    expect(await invoicedBy('a')).toBe('INV-3003 (ISO+™)');
  });
});
