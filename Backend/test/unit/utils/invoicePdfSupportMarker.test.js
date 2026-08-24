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
