import { describe, it, expect, beforeEach, vi } from 'vitest';

import Item from '../../../src/models/Item.js';
import { STALE_CLAIM_MAX_AGE_MS } from '../../../src/constants/invoiceSelection.js';

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

const { error } = await import('../../../src/utils/logger.js');
const { findStaleClaims, reportStaleClaims } = await import('../../../src/utils/staleInvoiceClaims.js');

/**
 * The recovery gap in section 3.4's claim protocol.
 *
 * `generateUnderClaim` claims with a `pending:` token and releases it if
 * generation fails. A process that dies between those two points leaves the
 * token behind, and nothing clears it. Those items are then excluded from
 * every future invoice — the participant is under-billed, silently, and the
 * only evidence is a marker nobody is reading.
 *
 * Section 3.4 is right that failing this way beats double billing. But
 * "recoverable" needs someone to notice first, and noticing is what this is.
 * Detection only: clearing a token automatically would race a run that is
 * merely slow, which is the double bill the whole protocol exists to prevent.
 */

const WS = 'ws-1';
const BOARD = 'board-1';
const NOW = new Date('2026-08-20T00:00:00.000Z');
const PENDING = 'pending:NDIS Invoice:20260801-0000:Jane Doe';
const REAL_INVOICE = 'INV-1194 (ISO+™)';

const ago = (ms) => new Date(NOW.getTime() - ms);

async function seed(itemId, { invoicedBy, invoicedAt }) {
  await Item.create({
    workspaceId: WS, boardId: BOARD, folderId: 'f1', itemId, data: {}, invoicedBy, invoicedAt,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findStaleClaims', () => {
  it('finds a provisional token older than the cutoff', async () => {
    await seed('a', { invoicedBy: PENDING, invoicedAt: ago(STALE_CLAIM_MAX_AGE_MS + 60_000) });
    const stale = await findStaleClaims({ workspaceId: WS, boardId: BOARD, now: NOW });
    expect(stale.map((row) => row.itemId)).toEqual(['a']);
    expect(stale[0].invoicedBy).toBe(PENDING);
  });

  it('leaves a young token alone, because that run may still be working', async () => {
    await seed('a', { invoicedBy: PENDING, invoicedAt: ago(60_000) });
    const stale = await findStaleClaims({ workspaceId: WS, boardId: BOARD, now: NOW });
    expect(stale).toEqual([]);
  });

  it('ignores a real invoice number however old it is', async () => {
    // An issued invoice is supposed to hold its items forever. Only the
    // provisional token is evidence of a run that never finished.
    await seed('a', { invoicedBy: REAL_INVOICE, invoicedAt: ago(STALE_CLAIM_MAX_AGE_MS * 100) });
    const stale = await findStaleClaims({ workspaceId: WS, boardId: BOARD, now: NOW });
    expect(stale).toEqual([]);
  });

  it('ignores an unclaimed item', async () => {
    await seed('a', { invoicedBy: null, invoicedAt: null });
    const stale = await findStaleClaims({ workspaceId: WS, boardId: BOARD, now: NOW });
    expect(stale).toEqual([]);
  });

  it('does not reach into another workspace or board', async () => {
    await seed('a', { invoicedBy: PENDING, invoicedAt: ago(STALE_CLAIM_MAX_AGE_MS + 60_000) });
    expect(await findStaleClaims({ workspaceId: 'other-ws', boardId: BOARD, now: NOW })).toEqual([]);
    expect(await findStaleClaims({ workspaceId: WS, boardId: 'other-board', now: NOW })).toEqual([]);
  });

  it('treats a token with no invoicedAt as stale, since nothing can vouch for it', async () => {
    await seed('a', { invoicedBy: PENDING, invoicedAt: null });
    const stale = await findStaleClaims({ workspaceId: WS, boardId: BOARD, now: NOW });
    expect(stale.map((row) => row.itemId)).toEqual(['a']);
  });
});

describe('reportStaleClaims', () => {
  it('raises an error-level alarm naming the items being withheld', async () => {
    await seed('a', { invoicedBy: PENDING, invoicedAt: ago(STALE_CLAIM_MAX_AGE_MS + 60_000) });
    await seed('b', { invoicedBy: PENDING, invoicedAt: ago(STALE_CLAIM_MAX_AGE_MS + 60_000) });

    const stale = await reportStaleClaims({ workspaceId: WS, boardId: BOARD, now: NOW });

    expect(stale).toHaveLength(2);
    expect(error).toHaveBeenCalledTimes(1);
    const [source, message, meta] = error.mock.calls[0];
    expect(source).toBe('Automation');
    expect(message).toMatch(/never completed/i);
    expect(meta).toMatchObject({ workspaceId: WS, boardId: BOARD, count: 2 });
    expect(meta.itemIds.sort()).toEqual(['a', 'b']);
  });

  it('says nothing when there is nothing to say', async () => {
    await seed('a', { invoicedBy: REAL_INVOICE, invoicedAt: ago(60_000) });
    const stale = await reportStaleClaims({ workspaceId: WS, boardId: BOARD, now: NOW });
    expect(stale).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it('caps the ids it logs, and says how many it left out', async () => {
    // A board that crashed mid-run can hold thousands. The alarm has to stay
    // readable and the log document has to stay under the sanitizer's size cap.
    const ids = Array.from({ length: 60 }, (_, i) => `i${i}`);
    for (const itemId of ids) {
      await seed(itemId, { invoicedBy: PENDING, invoicedAt: ago(STALE_CLAIM_MAX_AGE_MS + 60_000) });
    }
    await reportStaleClaims({ workspaceId: WS, boardId: BOARD, now: NOW });
    const [, , meta] = error.mock.calls[0];
    expect(meta.count).toBe(60);
    expect(meta.itemIds).toHaveLength(50);
    expect(meta.truncated).toBe(10);
  });
});
