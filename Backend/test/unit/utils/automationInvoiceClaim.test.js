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

describe('generateUnderClaim — the ledger row comes before the marker', () => {
  it('records the document while the provisional token is still held', async () => {
    const order = [];
    await generateUnderClaim({
      ...base,
      itemIds: ['a'],
      produce: async () => ({ invoiceNumber: 'INV-3004 (ISO+™)' }),
      record: async (document, claimed) => {
        order.push(document.invoiceNumber, claimed.join(','), await invoicedBy('a'));
      },
    });

    expect(order).toEqual(['INV-3004 (ISO+™)', 'a', provisionalClaimToken({
      type: TYPE, periodKey: PERIOD, participant: PARTICIPANT,
    })]);
    expect(await invoicedBy('a')).toBe('INV-3004 (ISO+™)');
  });

  it('keeps the pending token when the ledger write fails, so the alarm can see it', async () => {
    await expect(generateUnderClaim({
      ...base,
      itemIds: ['a'],
      produce: async () => ({ invoiceNumber: 'INV-3005 (ISO+™)' }),
      record: async () => { throw new Error('ledger write failed'); },
    })).rejects.toThrow('ledger write failed');

    // Not the real invoice number — that would name a document with no ledger
    // row — and not released either, because a row may already have been
    // written and releasing would bill those items twice.
    expect(await invoicedBy('a')).toMatch(/^pending:/);
  });
});

describe('the per-attempt token for a manual invoice (KAN-302)', () => {
  it('leaves the deterministic token unchanged when there is no attempt id', () => {
    expect(provisionalClaimToken({ type: TYPE, periodKey: PERIOD, participant: PARTICIPANT }))
      .toBe('pending:NDIS Invoice:2025-01:Jane Doe');
  });

  it('appends the attempt id after a separator when there is one', () => {
    expect(provisionalClaimToken({
      type: TYPE, periodKey: PERIOD, participant: PARTICIPANT, attemptId: 'req-1',
    })).toBe('pending:NDIS Invoice:2025-01:Jane Doe#req-1');
  });

  it('lets only one of two concurrent manual attempts for the same items claim them', async () => {
    let releaseFirst;
    const firstHolds = new Promise((resolve) => { releaseFirst = resolve; });
    let firstHasClaimed;
    const claimed = new Promise((resolve) => { firstHasClaimed = resolve; });
    const first = generateUnderClaim({
      ...base, attemptId: 'req-1', itemIds: ['a', 'b'],
      produce: async () => { firstHasClaimed(); await firstHolds; return { invoiceNumber: 'INV-1' }; },
    });
    // produce runs only after the claim is taken, so this is a signal, not a guess.
    await claimed;

    const second = await generateUnderClaim({
      ...base, attemptId: 'req-2', itemIds: ['a', 'b'],
      produce: async () => ({ invoiceNumber: 'INV-2' }),
    });
    expect(second).toBeNull();

    releaseFirst();
    const winner = await first;
    expect(winner.invoiceNumber).toBe('INV-1');
    expect(await invoicedBy('a')).toBe('INV-1');
  });
});
