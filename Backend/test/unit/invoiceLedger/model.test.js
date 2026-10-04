import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';

import Invoice from '../../../src/models/Invoice.js';
import Item from '../../../src/models/Item.js';
import PDFLink from '../../../src/models/PDFLink.js';
import { up, down } from '../../../migrations/1791102300000-invoice-ledger-indexes.js';

/**
 * The invoices collection (KAN-302): its defaults, its enums, and the unique index
 * the migration builds. The index is what makes committing an invoice idempotent.
 */

const base = (over = {}) => ({
  workspaceId: 'ws-1',
  boardId: 'b-1',
  number: 'INV-1',
  kind: 'ndis',
  participant: { profileId: 'p-1', name: 'Jane Smith' },
  lines: [{ itemId: 'i-1', amount: 100 }],
  total: 100,
  ...over,
});

beforeEach(async () => {
  await up(mongoose.connection);
});

describe('Invoice defaults', () => {
  it('is issued, from the portal, live, with no legacy numbers and no duplicate marker', async () => {
    const saved = await Invoice.create(base());
    const row = await Invoice.findById(saved._id).lean();

    expect(row.status).toBe('issued');
    expect(row.source).toBe('portal');
    expect(row.origin).toBe('live');
    expect(row.legacyNumbers).toEqual([]);
    expect(row.duplicateOrdinal).toBe(0);
    expect(row.totalDerived).toBeUndefined();
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('keeps the lines it is given, without an _id on each', async () => {
    const saved = await Invoice.create(base({ lines: [{ itemId: 'a', amount: 1 }, { itemId: 'b', amount: 2 }] }));
    const row = await Invoice.findById(saved._id).lean();
    expect(row.lines).toEqual([{ itemId: 'a', amount: 1 }, { itemId: 'b', amount: 2 }]);
  });
});

describe('Invoice validation', () => {
  it.each([
    ['workspaceId', { workspaceId: undefined }],
    ['number', { number: undefined }],
    ['kind', { kind: undefined }],
  ])('requires %s', async (_name, over) => {
    await expect(Invoice.create(base(over))).rejects.toThrow(/required/i);
  });

  it.each([
    ['status', { status: 'paid' }],
    ['source', { source: 'quickbooks' }],
    ['kind', { kind: 'other' }],
    ['origin', { origin: 'import' }],
    ['trigger', { trigger: 'cron' }],
  ])('rejects an unknown %s', async (_name, over) => {
    await expect(Invoice.create(base(over))).rejects.toThrow();
  });

  it('rejects a line with no item id', async () => {
    await expect(Invoice.create(base({ lines: [{ amount: 5 }] }))).rejects.toThrow(/required/i);
  });
});

describe('the unique number index', () => {
  it('refuses a second invoice with the same workspace, source and number', async () => {
    await Invoice.create(base());
    await expect(Invoice.create(base({ lines: [{ itemId: 'i-2', amount: 5 }] }))).rejects.toThrow(/E11000|duplicate key/i);
  });

  it('allows the same number in another workspace, or from another source', async () => {
    await Invoice.create(base());
    await Invoice.create(base({ workspaceId: 'ws-2' }));
    await Invoice.create(base({ source: 'xero' }));
    expect(await Invoice.countDocuments({})).toBe(3);
  });

  it('allows a flagged duplicate: each gets its own ordinal', async () => {
    await Invoice.create(base());
    await Invoice.create(base({ duplicateOrdinal: 1 }));
    await Invoice.create(base({ duplicateOrdinal: 2 }));
    expect(await Invoice.countDocuments({ number: 'INV-1' })).toBe(3);
    await expect(Invoice.create(base({ duplicateOrdinal: 1 }))).rejects.toThrow(/E11000|duplicate key/i);
  });
});

describe('the index migration', () => {
  const names = async () => (await Invoice.collection.indexes()).map((i) => i.name);

  it('builds the indexes, and is safe to run twice', async () => {
    await up(mongoose.connection);
    const built = await names();
    expect(built).toEqual(expect.arrayContaining([
      'invoice_number_unique', 'invoice_line_item', 'invoice_legacy_number',
      'invoice_participant', 'invoice_slot',
    ]));
  });

  it('down drops the indexes and keeps every invoice', async () => {
    await Invoice.create(base());
    await down(mongoose.connection);

    const left = await names();
    expect(left).toEqual(['_id_']);
    expect(await Invoice.countDocuments({})).toBe(1);
  });

  it('down is safe when the indexes are already gone', async () => {
    await down(mongoose.connection);
    await expect(down(mongoose.connection)).resolves.toBeUndefined();
  });

  it('down is safe when the collection does not exist at all', async () => {
    await Invoice.collection.drop();
    await expect(down(mongoose.connection)).resolves.toBeUndefined();
  });

  it('builds the index on pdflinks.invoiceId that stampXero and the audit use, and down drops it', async () => {
    const onDocuments = async () => (await PDFLink.collection.indexes()).map((i) => i.name);
    expect(await onDocuments()).toContain('invoice_document');
    await down(mongoose.connection);
    expect(await onDocuments()).not.toContain('invoice_document');
  });
});

describe('the pointers on items and documents', () => {
  it('an item has no active invoice until one is set', async () => {
    const item = await Item.create({ workspaceId: 'ws-1', boardId: 'b-1', folderId: 'f', itemId: 'x', data: {} });
    expect((await Item.findById(item._id).lean()).activeInvoiceId ?? null).toBeNull();
  });

  it('an item can point at an invoice', async () => {
    const invoice = await Invoice.create(base());
    const item = await Item.create({
      workspaceId: 'ws-1', boardId: 'b-1', folderId: 'f', itemId: 'x', data: {}, activeInvoiceId: invoice._id,
    });
    expect(String((await Item.findById(item._id).lean()).activeInvoiceId)).toBe(String(invoice._id));
  });

  it('a document row can carry the invoice it belongs to', async () => {
    const invoice = await Invoice.create(base());
    const doc = await PDFLink.create({
      itemId: 'x', workspaceId: 'ws-1', pdfLink: 'https://s3/x.pdf', type: 'NDIS Invoice', invoiceId: invoice._id,
    });
    expect(String((await PDFLink.findById(doc._id).lean()).invoiceId)).toBe(String(invoice._id));
  });
});
