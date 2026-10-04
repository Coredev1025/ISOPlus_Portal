import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';

import Invoice from '../../../src/models/Invoice.js';
import Item from '../../../src/models/Item.js';
import PDFLink from '../../../src/models/PDFLink.js';
import { up } from '../../../migrations/1791102300000-invoice-ledger-indexes.js';

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

const markerModule = await import('../../../src/utils/invoicedMarker.js');
const { issueInvoice, commitInvoice, repairInvoice, resetIndexCheckForTests } = await import('../../../src/utils/invoiceLedger/issue.js');
const { generateUnderClaim } = await import('../../../src/utils/automationInvoiceClaim.js');
const { warn } = await import('../../../src/utils/logger.js');

/**
 * issueInvoice (KAN-302): the existing claim protocol with the new invoice record
 * committed under the claim, and every failure window written down.
 *
 * Order: claim -> produce -> record (the older writes) -> COMMIT the invoice ->
 * marker rewrite -> point the items at the invoice. With the write flag off it is
 * exactly the old protocol.
 */

const WS = 'ws-i';
const BOARD = 'b-i';
const TYPE = 'NDIS Invoice';
const PERIOD = '20260101-0900';

const base = (over = {}) => ({
  workspaceId: WS,
  boardId: BOARD,
  itemIds: ['a', 'b'],
  type: TYPE,
  periodKey: PERIOD,
  kind: 'ndis',
  participant: { profileId: 'p-1', name: 'Jane Smith' },
  trigger: 'automation',
  produce: async () => ({ invoiceNumber: 'INV-5', fileUrl: 'https://s3/5.pdf', invoiceTotal: 150 }),
  ...over,
});

/** What recordPdfLinks does: one ledger row per item, carrying the number. */
const recordRows = (workspaceId = WS) => async (generated, claimed) => {
  await PDFLink.insertMany(claimed.map((itemId) => ({
    itemId, workspaceId, boardId: BOARD, type: TYPE, pdfLink: generated.fileUrl,
    invoiceNumber: generated.invoiceNumber, invoiceTotal: generated.invoiceTotal, periodKey: PERIOD,
  })));
};

const markerOf = async (itemId) => (await Item.findOne({ itemId }).lean()).invoicedBy ?? null;
const activeOf = async (itemId) => (await Item.findOne({ itemId }).lean()).activeInvoiceId ?? null;

const saved = {};

beforeEach(async () => {
  saved.write = process.env.INVOICE_LEDGER_WRITE;
  process.env.INVOICE_LEDGER_WRITE = 'on';
  vi.clearAllMocks();
  await up(mongoose.connection);
  await Item.insertMany(['a', 'b'].map((itemId) => ({
    workspaceId: WS, boardId: BOARD, folderId: 'f', itemId, data: {},
  })));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (saved.write === undefined) delete process.env.INVOICE_LEDGER_WRITE; else process.env.INVOICE_LEDGER_WRITE = saved.write;
});

describe('with the write flag on', () => {
  it('commits one invoice listing the claimed items, and returns its id', async () => {
    const result = await issueInvoice(base({ record: recordRows() }));

    const invoices = await Invoice.find({ workspaceId: WS }).lean();
    expect(invoices).toHaveLength(1);
    expect(String(result.invoiceId)).toBe(String(invoices[0]._id));
    expect(invoices[0]).toMatchObject({
      number: 'INV-5', source: 'portal', kind: 'ndis', status: 'issued', origin: 'live',
      total: 150, periodKey: PERIOD, trigger: 'automation', boardId: BOARD,
      participant: { profileId: 'p-1', name: 'Jane Smith' },
      pdf: { pdfLink: 'https://s3/5.pdf' },
    });
    expect(invoices[0].lines.map((l) => l.itemId).sort()).toEqual(['a', 'b']);
  });

  it('confirms the claim: the marker names the number and the items point at the invoice', async () => {
    const result = await issueInvoice(base({ record: recordRows() }));

    expect(await markerOf('a')).toBe('INV-5');
    expect(String(await activeOf('a'))).toBe(String(result.invoiceId));
    expect(String(await activeOf('b'))).toBe(String(result.invoiceId));
  });

  it('stamps the invoice id on the document rows the older writes made', async () => {
    const result = await issueInvoice(base({ record: recordRows() }));

    const rows = await PDFLink.find({ workspaceId: WS }).lean();
    expect(rows).toHaveLength(2);
    rows.forEach((row) => expect(String(row.invoiceId)).toBe(String(result.invoiceId)));
  });

  it('parses a suffixed number: the invoice holds the plain number and remembers the original', async () => {
    await issueInvoice(base({
      produce: async () => ({ invoiceNumber: 'INV-6 (ISO+™)', fileUrl: 'https://s3/6.pdf', invoiceTotal: 10 }),
    }));

    const invoice = await Invoice.findOne({ workspaceId: WS }).lean();
    expect(invoice.number).toBe('INV-6');
    expect(invoice.legacyNumbers).toEqual(['INV-6 (ISO+™)']);
    expect(await markerOf('a')).toBe('INV-6 (ISO+™)');
  });

  it('stores per-item amounts when the producer supplies them, and leaves them at zero when it does not', async () => {
    await issueInvoice(base({ lineAmounts: { a: 100, b: 50 } }));
    const withAmounts = await Invoice.findOne({ number: 'INV-5' }).lean();
    expect(withAmounts.lines).toEqual([{ itemId: 'a', amount: 100 }, { itemId: 'b', amount: 50 }]);

    await Item.insertMany(['c'].map((itemId) => ({ workspaceId: WS, boardId: BOARD, folderId: 'f', itemId, data: {} })));
    await issueInvoice(base({
      itemIds: ['c'], produce: async () => ({ invoiceNumber: 'INV-7', fileUrl: 'https://s3/7.pdf', invoiceTotal: 5 }),
    }));
    expect((await Invoice.findOne({ number: 'INV-7' }).lean()).lines).toEqual([{ itemId: 'c', amount: 0 }]);
  });

  it('records Low Cat only when the producer says so', async () => {
    await issueInvoice(base({ kind: 'age_care', lowCat: true }));
    expect((await Invoice.findOne({ number: 'INV-5' }).lean()).lowCat).toBe(true);
  });

  it('returns null and writes no invoice when there is nothing to bill', async () => {
    await Item.updateMany({ workspaceId: WS }, { $set: { invoicedBy: 'INV-OTHER' } });
    expect(await issueInvoice(base())).toBeNull();
    expect(await Invoice.countDocuments({})).toBe(0);
  });
});

describe('with the write flag off', () => {
  it('is the old protocol: no invoice record, no pointer, the marker still rewritten', async () => {
    delete process.env.INVOICE_LEDGER_WRITE;

    const result = await issueInvoice(base({ record: recordRows() }));

    expect(result.invoiceNumber).toBe('INV-5');
    expect(result.invoiceId).toBeUndefined();
    expect(await Invoice.countDocuments({})).toBe(0);
    expect(await markerOf('a')).toBe('INV-5');
    expect(await activeOf('a')).toBeNull();
    const rows = await PDFLink.find({ workspaceId: WS }).lean();
    rows.forEach((row) => expect(row.invoiceId).toBeUndefined());
  });
});

describe('with the write flag off, the result is what generateUnderClaim returns', () => {
  it('matches it exactly, with and without a record callback', async () => {
    delete process.env.INVOICE_LEDGER_WRITE;

    const viaIssue = await issueInvoice(base());
    await Item.updateMany({ workspaceId: WS }, { $unset: { invoicedBy: '', invoicedAt: '', invoicedPeriodKey: '' } });
    const viaOld = await generateUnderClaim({
      workspaceId: WS, boardId: BOARD, itemIds: ['a', 'b'], type: TYPE, periodKey: PERIOD,
      participant: 'Jane Smith', produce: base().produce,
    });

    expect(viaIssue).toEqual(viaOld);
  });
});

describe('failure windows', () => {
  it('produce throws: the claim is released, nothing is written, the error surfaces', async () => {
    await expect(issueInvoice(base({ produce: async () => { throw new Error('render failed'); } })))
      .rejects.toThrow('render failed');

    expect(await markerOf('a')).toBeNull();
    expect(await Invoice.countDocuments({})).toBe(0);
  });

  it('produce reports the period empty: the claim is released and the result is null', async () => {
    expect(await issueInvoice(base({ produce: async () => ({ empty: true }) }))).toBeNull();
    expect(await markerOf('a')).toBeNull();
    expect(await Invoice.countDocuments({})).toBe(0);
  });

  it('the older writes throw: the claim stays pending and no invoice is committed', async () => {
    const record = async () => { throw new Error('ledger write failed'); };
    await expect(issueInvoice(base({ record }))).rejects.toThrow('ledger write failed');

    expect(await markerOf('a')).toMatch(/^pending:/);
    expect(await Invoice.countDocuments({})).toBe(0);
  });

  it('the commit throws: the claim stays pending, the older rows exist and are not linked', async () => {
    vi.spyOn(Invoice, 'findOneAndUpdate').mockReturnValue({
      lean: async () => { throw new Error('invoice write failed'); },
    });

    await expect(issueInvoice(base({ record: recordRows() }))).rejects.toThrow('invoice write failed');

    expect(await markerOf('a')).toMatch(/^pending:/);
    expect(await Invoice.countDocuments({})).toBe(0);
    const rows = await PDFLink.find({ workspaceId: WS }).lean();
    expect(rows).toHaveLength(2);
    rows.forEach((row) => expect(row.invoiceId).toBeUndefined());
  });

  it('the marker rewrite fails after the commit: the invoice exists, and repair finishes the confirm step', async () => {
    vi.spyOn(markerModule, 'markItemsInvoiced').mockRejectedValueOnce(new Error('marker rewrite failed'));

    await expect(issueInvoice(base({ record: recordRows() }))).rejects.toThrow('marker rewrite failed');

    const invoice = await Invoice.findOne({ workspaceId: WS }).lean();
    expect(invoice).toBeTruthy();
    expect(await markerOf('a')).toMatch(/^pending:/);
    expect(await activeOf('a')).toBeNull();

    const outcome = await repairInvoice(invoice._id);

    expect(outcome).toEqual({ repaired: ['a', 'b'], skipped: [], missing: [] });
    expect(await markerOf('a')).toBe('INV-5');
    expect(String(await activeOf('a'))).toBe(String(invoice._id));
  });

  it('committing the same invoice twice finds the existing record instead of failing', async () => {
    const generated = { invoiceNumber: 'INV-5', fileUrl: 'https://s3/5.pdf', invoiceTotal: 150 };
    const args = {
      workspaceId: WS, boardId: BOARD, itemIds: ['a', 'b'], generated, kind: 'ndis', source: 'portal',
      participant: { name: 'Jane Smith' }, trigger: 'automation', periodKey: PERIOD,
    };
    const first = await commitInvoice(args);
    const second = await commitInvoice(args);

    expect(String(second._id)).toBe(String(first._id));
    expect(await Invoice.countDocuments({})).toBe(1);
  });

  it('a different invoice on a number that is taken is refused', async () => {
    const generated = { invoiceNumber: 'INV-5', fileUrl: 'https://s3/5.pdf', invoiceTotal: 150 };
    const args = {
      workspaceId: WS, boardId: BOARD, generated, kind: 'ndis', source: 'portal',
      participant: { name: 'Jane Smith' }, trigger: 'automation',
    };
    await commitInvoice({ ...args, itemIds: ['a'] });

    await expect(commitInvoice({ ...args, itemIds: ['b'] })).rejects.toThrow(/already exists for different items/i);
  });
});

describe('manual producers claim per attempt', () => {
  it('lets only one of two concurrent attempts for the same items issue an invoice', async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let firstHasClaimed;
    const claimed = new Promise((resolve) => { firstHasClaimed = resolve; });
    const first = issueInvoice(base({
      trigger: 'manual', periodKey: null, attemptId: 'req-1',
      produce: async () => {
        firstHasClaimed();
        await held;
        return { invoiceNumber: 'INV-1', fileUrl: 'https://s3/1.pdf', invoiceTotal: 1 };
      },
    }));
    // produce runs only after the claim is taken, so this is a signal, not a guess.
    await claimed;

    const second = await issueInvoice(base({
      trigger: 'manual', periodKey: null, attemptId: 'req-2',
      produce: async () => ({ invoiceNumber: 'INV-2', fileUrl: 'https://s3/2.pdf', invoiceTotal: 2 }),
    }));
    expect(second).toBeNull();

    release();
    await first;
    expect(await Invoice.countDocuments({})).toBe(1);
    expect(await markerOf('a')).toBe('INV-1');
  });
});

describe('the participant', () => {
  it('refuses a participant with no name: every participant on a slot would share one claim token', async () => {
    await expect(issueInvoice(base({ participant: { profileId: 'p-1' } }))).rejects.toThrow(/participant name/i);
    await expect(issueInvoice(base({ participant: undefined }))).rejects.toThrow(/participant name/i);
    expect(await markerOf('a')).toBeNull();
  });

  it('accepts a plain name string, as the scheduled generators pass today, and stores it as the name', async () => {
    await issueInvoice(base({ participant: 'Jane Smith' }));
    expect((await Invoice.findOne({ number: 'INV-5' }).lean()).participant).toEqual({ name: 'Jane Smith' });
  });
});

describe('what is validated before anything is written', () => {
  it('refuses an unknown source', async () => {
    await expect(issueInvoice(base({ source: 'quickbooks' }))).rejects.toThrow(/source/i);
    expect(await markerOf('a')).toBeNull();
  });

  it('refuses an unknown kind before it claims, so nothing is left pending', async () => {
    await expect(issueInvoice(base({ kind: 'other' }))).rejects.toThrow(/kind/i);
    expect(await markerOf('a')).toBeNull();
  });

  it('keeps the claim pending when the invoice fails validation at commit', async () => {
    const produce = async () => ({ invoiceNumber: '   ', fileUrl: 'https://s3/x.pdf', invoiceTotal: 1 });
    await expect(issueInvoice(base({ produce }))).rejects.toThrow();
    expect(await Invoice.countDocuments({})).toBe(0);
  });
});

describe('the unique number index must exist before an invoice is committed', () => {
  it('refuses to commit without it, and says which migration builds it', async () => {
    await Invoice.collection.dropIndexes();
    resetIndexCheckForTests();

    await expect(issueInvoice(base())).rejects.toThrow(/invoice-ledger-indexes/);
    expect(await markerOf('a')).toMatch(/^pending:/);
    expect(await Invoice.countDocuments({})).toBe(0);
  });
});

describe('the pointer step', () => {
  it('a failure pointing the items at the invoice does not fail the issue: the invoice is issued and marked', async () => {
    const real = Item.updateMany.bind(Item);
    const spy = vi.spyOn(Item, 'updateMany').mockImplementation((filter, update, ...rest) => (
      update?.$set && 'activeInvoiceId' in update.$set
        ? Promise.reject(new Error('pointer write failed'))
        : real(filter, update, ...rest)
    ));

    const result = await issueInvoice(base({ record: recordRows() }));
    spy.mockRestore();

    expect(result.invoiceNumber).toBe('INV-5');
    expect(await markerOf('a')).toBe('INV-5');
    expect(await activeOf('a')).toBeNull();
    expect(warn.mock.calls.some(([, message]) => /repair/i.test(message))).toBe(true);
  });
});

describe('repairInvoice', () => {
  const issuedInvoice = async (over = {}) => Invoice.create({
    workspaceId: WS, boardId: BOARD, number: 'INV-9', kind: 'ndis',
    lines: [{ itemId: 'a', amount: 1 }, { itemId: 'b', amount: 1 }], ...over,
  });

  it('leaves an item holding a different real number alone, and says so', async () => {
    const invoice = await issuedInvoice();
    await Item.updateOne({ itemId: 'b' }, { $set: { invoicedBy: 'INV-OTHER' } });

    const outcome = await repairInvoice(invoice._id);

    expect(outcome).toEqual({ repaired: ['a'], skipped: ['b'], missing: [] });
    expect(await markerOf('b')).toBe('INV-OTHER');
    expect(await activeOf('b')).toBeNull();
  });

  it('is safe to run twice', async () => {
    const invoice = await issuedInvoice();
    await repairInvoice(invoice._id);
    const again = await repairInvoice(invoice._id);

    expect(again.repaired.sort()).toEqual(['a', 'b']);
    expect(await markerOf('a')).toBe('INV-9');
  });

  it('refuses an invoice that does not exist', async () => {
    await expect(repairInvoice(new mongoose.Types.ObjectId())).rejects.toThrow(/not found/i);
  });

  it('reports an item that no longer exists as missing, not as holding another number', async () => {
    const invoice = await issuedInvoice({ lines: [{ itemId: 'a', amount: 1 }, { itemId: 'gone', amount: 1 }] });
    expect(await repairInvoice(invoice._id)).toEqual({ repaired: ['a'], skipped: [], missing: ['gone'] });
  });

  it('only takes a provisional claim that is this invoice\'s own', async () => {
    const invoice = await issuedInvoice({ claimToken: 'pending:NDIS Invoice:slot-1:Jane Smith' });
    await Item.updateOne({ itemId: 'a' }, { $set: { invoicedBy: 'pending:NDIS Invoice:slot-1:Jane Smith' } });
    await Item.updateOne({ itemId: 'b' }, { $set: { invoicedBy: 'pending:NDIS Invoice:slot-2:Someone Else' } });

    const outcome = await repairInvoice(invoice._id);

    expect(outcome).toEqual({ repaired: ['a'], skipped: ['b'], missing: [] });
    expect(await markerOf('b')).toBe('pending:NDIS Invoice:slot-2:Someone Else');
  });

  it('does not take any provisional claim for an invoice that recorded none', async () => {
    const invoice = await issuedInvoice();
    await Item.updateOne({ itemId: 'a' }, { $set: { invoicedBy: 'pending:NDIS Invoice:slot-1:Jane Smith' } });

    expect((await repairInvoice(invoice._id)).skipped).toEqual(['a']);
  });

  it('never rewrites the marker of a portal invoice when repairing a Xero invoice of the same number', async () => {
    const xero = await issuedInvoice({
      number: 'INV-1', source: 'xero', legacyNumbers: ['INV-1 (Xero)'], lines: [{ itemId: 'a', amount: 1 }],
    });
    await Item.updateOne({ itemId: 'a' }, { $set: { invoicedBy: 'INV-1' } });

    const outcome = await repairInvoice(xero._id);

    expect(outcome).toEqual({ repaired: [], skipped: ['a'], missing: [] });
    expect(await markerOf('a')).toBe('INV-1');
    expect(await activeOf('a')).toBeNull();
  });

  it('writes the Xero marker form for a Xero invoice, and accepts its own form already in place', async () => {
    const xero = await issuedInvoice({
      number: 'INV-1', source: 'xero', legacyNumbers: ['INV-1 (Xero)'], lines: [{ itemId: 'a', amount: 1 }],
    });
    await Item.updateOne({ itemId: 'a' }, { $set: { invoicedBy: 'INV-1 (Xero)' } });

    expect((await repairInvoice(xero._id)).repaired).toEqual(['a']);
    expect(await markerOf('a')).toBe('INV-1 (Xero)');
  });

  it('refuses a void invoice: it must not re-mark items it no longer covers', async () => {
    const invoice = await issuedInvoice({ status: 'void' });
    await expect(repairInvoice(invoice._id)).rejects.toThrow(/not issued/i);
    expect(await markerOf('a')).toBeNull();
  });
});
