import { describe, it, expect, beforeEach, vi } from 'vitest';

import Item from '../../../src/models/Item.js';
import InvoiceNumber from '../../../src/models/InvoiceNumber.js';

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, info: vi.fn(), warn: vi.fn() };
});

const { warn } = await import('../../../src/utils/logger.js');
const { saveInvoiceNumber } = await import('../../../src/utils/invoicePdfSupport.js');

/**
 * Section 3.3: manual invoice generation must set the same invoiced marker as
 * the automated run. If it does not, the next scheduled run finds those items
 * unmarked and bills them a second time.
 *
 * `saveInvoiceNumber` is where that belongs, because it is the one function
 * every path that allocates an invoice number already goes through — the
 * manual NDIS and SaH webhook generators, the Xero routes, and the scheduled
 * generator. Marking anywhere else would have to be repeated in six places and
 * would be missed in the seventh.
 */

const WS = 'ws-1';
const BOARD = 'board-1';
const INVOICE = 'INV-2001 (ISO+™)';
const LATER_INVOICE = 'INV-2002 (ISO+™)';

beforeEach(async () => {
  vi.clearAllMocks();
  await Item.create({
    workspaceId: WS, boardId: BOARD, folderId: 'f1', itemId: 'a', data: {},
  });
});

const warnedMessages = () => warn.mock.calls.map(([, message]) => message);

describe('saveInvoiceNumber also sets the invoiced marker', () => {
  it('marks the item it just recorded an invoice number for', async () => {
    await saveInvoiceNumber(WS, BOARD, 'a', INVOICE, 'PDF', 'https://s3/x.pdf');
    const row = await Item.findOne({ itemId: 'a' }).lean();
    expect(row.invoicedBy).toBe(INVOICE);
  });

  it('still writes the InvoiceNumber row it always did', async () => {
    await saveInvoiceNumber(WS, BOARD, 'a', INVOICE, 'PDF', 'https://s3/x.pdf');
    const row = await InvoiceNumber.findOne({ itemId: 'a' }).lean();
    expect(row.invoiceNumber).toBe(INVOICE);
    expect(row.type).toBe('PDF');
  });

  it('keeps the first claim when a later document covers the same item', async () => {
    // The Xero push records a second number for an item the PDF run already
    // billed. Either marker excludes the item from the next run, so the
    // original claim is kept rather than overwritten — it is the one that says
    // which invoice the participant actually received.
    await saveInvoiceNumber(WS, BOARD, 'a', INVOICE, 'PDF', 'https://s3/x.pdf');
    await saveInvoiceNumber(WS, BOARD, 'a', LATER_INVOICE, 'Xero');
    const row = await Item.findOne({ itemId: 'a' }).lean();
    expect(row.invoicedBy).toBe(INVOICE);
  });

  it('warns when the item is already claimed, because that is a second document for billed work', async () => {
    // The claim is refused, which is right — the first marker names the invoice
    // the participant received. But a refusal means a second document now
    // exists for work that was already billed, and until now the only trace of
    // it was the absence of a change. Nobody audits an absence.
    await saveInvoiceNumber(WS, BOARD, 'a', INVOICE, 'PDF', 'https://s3/x.pdf');
    await saveInvoiceNumber(WS, BOARD, 'a', LATER_INVOICE, 'PDF');

    const message = warnedMessages().find((m) => /already invoiced/i.test(m));
    expect(message).toBeTruthy();
    const [, , meta] = warn.mock.calls.find(([, m]) => /already invoiced/i.test(m));
    expect(meta).toMatchObject({
      itemId: 'a', invoiceNumber: LATER_INVOICE, claimedBy: INVOICE,
    });
  });

  it('does not warn when the claim is taken, which is the ordinary case', async () => {
    await saveInvoiceNumber(WS, BOARD, 'a', INVOICE, 'PDF', 'https://s3/x.pdf');
    expect(warnedMessages().filter((m) => /already invoiced/i.test(m))).toEqual([]);
  });

  it('does not warn when the same invoice records itself twice', async () => {
    // A retried PDF run, or the Xero push for the same number. The claim is
    // idempotent for its own number, so nothing was refused and nothing is
    // wrong.
    await saveInvoiceNumber(WS, BOARD, 'a', INVOICE, 'PDF', 'https://s3/x.pdf');
    await saveInvoiceNumber(WS, BOARD, 'a', INVOICE, 'Xero');
    expect(warnedMessages().filter((m) => /already invoiced/i.test(m))).toEqual([]);
  });

  it('does not mark an item in another workspace', async () => {
    await saveInvoiceNumber('other-ws', BOARD, 'a', INVOICE, 'PDF');
    const row = await Item.findOne({ itemId: 'a' }).lean();
    expect(row.invoicedBy ?? null).toBe(null);
  });

  it('does not throw when the item does not exist', async () => {
    await expect(saveInvoiceNumber(WS, BOARD, 'missing', INVOICE, 'PDF')).resolves.toBeUndefined();
  });
});

/**
 * Section 3.4: the invoice write and the item marking must succeed or fail
 * together, and where the design forces a choice, prefer leaving items
 * unbilled — an unbilled item is recoverable on the next run, a double-billed
 * participant is not.
 *
 * Selection reads only `Item.invoicedBy` (`isAlreadyInvoiced` in
 * utils/invoiceItemSelection.js), never the `invoicenumber` ledger. So of the
 * two partial-failure states, only one is safe:
 *
 *   marker set, ledger row missing  → the item is excluded from every future
 *                                     run. Nobody is billed twice, and the
 *                                     missing row is visible and repairable.
 *   ledger row written, no marker   → the next scheduled run selects the item
 *                                     again and bills the participant twice.
 *
 * The second is the direction this used to fail in, because it wrote the
 * ledger row first and marked afterwards with only a warning.
 */
describe('saveInvoiceNumber fails towards not billing twice', () => {
  it('does not write the ledger row when the item could not be marked', async () => {
    // A real failure of the claim, provoked at the driver rather than by
    // mocking the marker module, so the whole claim path runs.
    const updateMany = vi.spyOn(Item, 'updateMany').mockRejectedValue(new Error('mongo is down'));
    try {
      await saveInvoiceNumber(WS, BOARD, 'a', INVOICE, 'PDF', 'https://s3/x.pdf');
    } finally {
      updateMany.mockRestore();
    }

    expect(await InvoiceNumber.findOne({ itemId: 'a' }).lean()).toBeNull();
    const message = warnedMessages().find((m) => /was not recorded either/i.test(m));
    expect(message).toBeTruthy();
  });

  it('keeps the marker when the ledger row cannot be written', async () => {
    // Releasing the claim here would hand the item straight back to the next
    // run, which is the double bill the ordering exists to prevent — the same
    // reason generateUnderClaim keeps its claim when `record` throws.
    const findOneAndUpdate = vi.spyOn(InvoiceNumber, 'findOneAndUpdate')
      .mockRejectedValue(new Error('mongo is down'));
    try {
      await saveInvoiceNumber(WS, BOARD, 'a', INVOICE, 'PDF', 'https://s3/x.pdf');
    } finally {
      findOneAndUpdate.mockRestore();
    }

    const row = await Item.findOne({ itemId: 'a' }).lean();
    expect(row.invoicedBy).toBe(INVOICE);
    expect(warnedMessages().find((m) => /Failed to save invoice number/i.test(m))).toBeTruthy();
  });
});
