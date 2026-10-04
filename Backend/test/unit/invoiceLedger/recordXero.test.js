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

const { recordXeroInvoice } = await import('../../../src/utils/invoiceLedger/recordXero.js');
const { resetIndexCheckForTests } = await import('../../../src/utils/invoiceLedger/issue.js');
const { warn } = await import('../../../src/utils/logger.js');

/**
 * recordXeroInvoice (KAN-308): the manual Xero routes (and, through them, the scheduled
 * Xero draft push) create a Xero invoice for items. Items already on a portal invoice
 * take the Xero number on that invoice and nothing new is billed (decision D8); items on
 * no invoice get a Xero-source invoice. Never throws.
 */

const WS = 'ws-x';
const BOARD = 'b-x';

const xeroCall = (over = {}) => ({
  workspaceId: WS,
  boardId: BOARD,
  itemIds: ['a', 'b'],
  created: { invoiceNumber: 'INV-501', invoiceID: 'xid-1', total: 90 },
  kind: 'ndis',
  participant: { name: 'Jane Smith' },
  lineAmounts: { a: 40, b: 50 },
  invoiceDate: '2026-09-01',
  dueDate: '2026-09-15',
  ...over,
});

const portalInvoice = (over = {}) => Invoice.create({
  workspaceId: WS, boardId: BOARD, number: 'INV-9', source: 'portal', kind: 'ndis',
  participant: { name: 'Jane Smith' }, lines: [{ itemId: 'a', amount: 40 }, { itemId: 'b', amount: 50 }],
  total: 90, issuedAt: new Date('2026-08-01T00:00:00Z'), trigger: 'manual', status: 'issued', origin: 'live', ...over,
});

const saved = {};

beforeEach(async () => {
  saved.write = process.env.INVOICE_LEDGER_WRITE;
  process.env.INVOICE_LEDGER_WRITE = 'on';
  vi.clearAllMocks();
  await up(mongoose.connection);
  resetIndexCheckForTests();
  await Item.insertMany(['a', 'b', 'c'].map((itemId) => ({
    workspaceId: WS, boardId: BOARD, folderId: 'f', itemId, data: {},
  })));
});

afterEach(() => {
  if (saved.write === undefined) delete process.env.INVOICE_LEDGER_WRITE; else process.env.INVOICE_LEDGER_WRITE = saved.write;
});

describe('items on no invoice yet', () => {
  it('records a Xero invoice with the Xero number, the lines and the total', async () => {
    await Item.updateMany({ workspaceId: WS }, { $set: { invoicedBy: 'INV-501 (Xero)' } });
    const invoice = await recordXeroInvoice(xeroCall());

    expect(invoice).toMatchObject({
      number: 'INV-501', source: 'xero', legacyNumbers: ['INV-501 (Xero)'], kind: 'ndis',
      total: 90, trigger: 'manual', status: 'issued', participant: { name: 'Jane Smith' },
    });
    expect(invoice.lines).toEqual([{ itemId: 'a', amount: 40 }, { itemId: 'b', amount: 50 }]);
    expect(invoice.issuedAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(invoice.dueDate.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    const item = await Item.findOne({ itemId: 'a' }).lean();
    expect(String(item.activeInvoiceId)).toBe(String(invoice._id));
  });

  it('is idempotent for the same Xero number and items', async () => {
    await recordXeroInvoice(xeroCall());
    await recordXeroInvoice(xeroCall());
    expect(await Invoice.countDocuments({ workspaceId: WS })).toBe(1);
  });
});

describe('items already on a portal invoice (D8)', () => {
  it('attaches the Xero number to that invoice and creates nothing', async () => {
    const portal = await portalInvoice();
    await PDFLink.insertMany(['a', 'b'].map((itemId) => ({
      itemId, workspaceId: WS, boardId: BOARD, type: 'NDIS Invoice', pdfLink: 'https://s3/9.pdf', invoiceNumber: 'INV-9', invoiceId: portal._id,
    })));

    const result = await recordXeroInvoice(xeroCall());

    expect(String(result._id)).toBe(String(portal._id));
    expect(await Invoice.countDocuments({ workspaceId: WS })).toBe(1);
    const stored = await Invoice.findById(portal._id).lean();
    expect(stored.xero).toEqual({ invoiceNumber: 'INV-501', id: 'xid-1' });
    expect((await PDFLink.find({ workspaceId: WS }).lean()).every((r) => r.xeroInvoiceNumber === 'INV-501')).toBe(true);
  });

  it('does nothing and warns when the Xero invoice spans more than one portal invoice', async () => {
    await portalInvoice({ lines: [{ itemId: 'a', amount: 40 }], total: 40 });
    await portalInvoice({ number: 'INV-10', lines: [{ itemId: 'b', amount: 50 }], total: 50 });

    expect(await recordXeroInvoice(xeroCall())).toBeNull();
    expect(await Invoice.countDocuments({ workspaceId: WS })).toBe(2);
    expect(warn).toHaveBeenCalledWith('InvoiceLedger', expect.stringMatching(/spans/), expect.objectContaining({ reason: 'xero-spans-invoices' }));
  });

  it('does nothing and warns when only some of the items are on the portal invoice', async () => {
    await portalInvoice({ lines: [{ itemId: 'a', amount: 40 }], total: 40 });

    expect(await recordXeroInvoice(xeroCall())).toBeNull();
    expect(await Invoice.countDocuments({ workspaceId: WS })).toBe(1);
    expect(warn).toHaveBeenCalledWith('InvoiceLedger', expect.stringMatching(/spans/), expect.any(Object));
  });

  it('ignores a void portal invoice', async () => {
    await portalInvoice({ status: 'void' });
    const invoice = await recordXeroInvoice(xeroCall());
    expect(invoice.source).toBe('xero');
  });
});

describe('items billed by an invoice the ledger does not hold yet (before the backfill)', () => {
  it('records nothing when an item is marked with a portal number and has no ledger invoice', async () => {
    await Item.updateOne({ itemId: 'a' }, { $set: { invoicedBy: 'INV-24' } });
    await Item.updateOne({ itemId: 'b' }, { $set: { invoicedBy: 'INV-501 (Xero)' } });

    expect(await recordXeroInvoice(xeroCall())).toBeNull();
    expect(await Invoice.countDocuments({ workspaceId: WS })).toBe(0);
    expect(warn).toHaveBeenCalledWith('InvoiceLedger', expect.any(String), expect.objectContaining({ reason: 'xero-on-unrecorded-invoice' }));
  });

  it('records nothing when an item carries another Xero invoice the ledger does not hold', async () => {
    await Item.updateOne({ itemId: 'a' }, { $set: { invoicedBy: 'INV-400 (Xero)' } });
    expect(await recordXeroInvoice(xeroCall())).toBeNull();
    expect(await Invoice.countDocuments({ workspaceId: WS })).toBe(0);
  });

  it('records when the items are unmarked, pending, or marked with this Xero number', async () => {
    await Item.updateOne({ itemId: 'a' }, { $set: { invoicedBy: 'INV-501 (Xero)' } });
    await Item.updateOne({ itemId: 'b' }, { $set: { invoicedBy: 'pending:something' } });
    expect((await recordXeroInvoice(xeroCall())).source).toBe('xero');
  });
});

describe('a second Xero push of the same items', () => {
  it('does not overwrite the Xero number already on the portal invoice', async () => {
    const portal = await portalInvoice({ xero: { invoiceNumber: 'INV-501', id: 'xid-1' } });

    expect(await recordXeroInvoice(xeroCall({ created: { invoiceNumber: 'INV-777', invoiceID: 'xid-7', total: 90 } }))).toBeNull();
    expect((await Invoice.findById(portal._id).lean()).xero).toEqual({ invoiceNumber: 'INV-501', id: 'xid-1' });
    expect(warn).toHaveBeenCalledWith('InvoiceLedger', expect.any(String), expect.objectContaining({ reason: 'xero-already-attached' }));
  });

  it('stamps again with the same number', async () => {
    const portal = await portalInvoice({ xero: { invoiceNumber: 'INV-501', id: 'xid-1' } });
    const result = await recordXeroInvoice(xeroCall());
    expect(String(result._id)).toBe(String(portal._id));
  });
});

describe('guards', () => {
  it('writes nothing with the flag off', async () => {
    process.env.INVOICE_LEDGER_WRITE = 'off';
    expect(await recordXeroInvoice(xeroCall())).toBeNull();
    expect(await Invoice.countDocuments({})).toBe(0);
  });

  it('never throws: a failure is warned about and the caller carries on', async () => {
    await Invoice.collection.dropIndexes();
    resetIndexCheckForTests();

    expect(await recordXeroInvoice(xeroCall())).toBeNull();
    expect(warn).toHaveBeenCalledWith('InvoiceLedger', expect.stringMatching(/not recorded/), expect.any(Object));
  });

  it('falls back to the sum of the lines when Xero returned no total', async () => {
    const invoice = await recordXeroInvoice(xeroCall({ created: { invoiceNumber: 'INV-502', invoiceID: 'x2' } }));
    expect(invoice.total).toBe(90);
  });
});
