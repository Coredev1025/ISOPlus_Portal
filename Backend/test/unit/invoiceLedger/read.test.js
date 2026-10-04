import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';

import Invoice from '../../../src/models/Invoice.js';
import Item from '../../../src/models/Item.js';
import PDFLink from '../../../src/models/PDFLink.js';
import { up } from '../../../migrations/1791102300000-invoice-ledger-indexes.js';
import {
  byNumber,
  activeForItems,
  forParticipant,
  slotInvoices,
  stampXero,
} from '../../../src/utils/invoiceLedger/read.js';

/**
 * The reader module (KAN-302): the only code allowed to read invoice identity once
 * the readers move onto it. Real models, in-memory Mongo.
 */

const WS = 'ws-r';
const BOARD = 'b-r';

const make = (number, over = {}) => Invoice.create({
  workspaceId: WS,
  boardId: BOARD,
  number,
  kind: 'ndis',
  participant: { profileId: 'p1', name: 'Jane Smith' },
  lines: [{ itemId: `item-${number}`, amount: 10 }],
  total: 10,
  issuedAt: new Date('2026-07-01T00:00:00Z'),
  ...over,
});

beforeEach(async () => {
  await up(mongoose.connection);
});

describe('byNumber', () => {
  it('finds an invoice by its plain number', async () => {
    await make('INV-24');
    expect((await byNumber(WS, 'INV-24')).number).toBe('INV-24');
  });

  it('finds it from the legacy form, and a legacy-numbered invoice from the plain one', async () => {
    await make('INV-24', { legacyNumbers: ['INV-24 (ISO+™)'] });
    expect((await byNumber(WS, 'INV-24 (ISO+™)')).number).toBe('INV-24');
    expect((await byNumber(WS, 'INV-24')).number).toBe('INV-24');
  });

  it('finds a Xero-only invoice by its marker form, but not as a portal number', async () => {
    await make('INV-0001', { source: 'xero', legacyNumbers: ['INV-0001 (Xero)'] });
    expect((await byNumber(WS, 'INV-0001 (Xero)')).source).toBe('xero');
    expect(await byNumber(WS, 'INV-0001')).toBeNull();
  });

  it('is scoped to the workspace', async () => {
    await make('INV-24');
    expect(await byNumber('other-ws', 'INV-24')).toBeNull();
  });

  it('prefers the invoice that owns the number over a flagged duplicate', async () => {
    await make('INV-9', { duplicateOrdinal: 1, total: 99 });
    await make('INV-9', { duplicateOrdinal: 0, total: 10 });
    expect((await byNumber(WS, 'INV-9')).total).toBe(10);
  });

  it('returns a void invoice too: a link to an old document must still resolve', async () => {
    await make('INV-5', { status: 'void' });
    expect((await byNumber(WS, 'INV-5')).status).toBe('void');
  });

  it('returns null for something that is not a number', async () => {
    expect(await byNumber(WS, 'pending:ndis:x:y')).toBeNull();
    expect(await byNumber(WS, '')).toBeNull();
  });
});

describe('activeForItems', () => {
  const item = (itemId, over = {}) => Item.create({
    workspaceId: WS, boardId: BOARD, folderId: 'f', itemId, data: {}, ...over,
  });

  it('maps an item to the invoice that lists it', async () => {
    await make('INV-1', { lines: [{ itemId: 'a', amount: 1 }, { itemId: 'b', amount: 2 }] });
    const found = await activeForItems(WS, ['a', 'b', 'c']);
    expect([...found.keys()].sort()).toEqual(['a', 'b']);
    expect(found.get('a').number).toBe('INV-1');
  });

  it('prefers the invoice the item points at when it is on more than one', async () => {
    const first = await make('INV-1', { lines: [{ itemId: 'a', amount: 1 }], issuedAt: new Date('2026-07-01Z') });
    await make('INV-2', { lines: [{ itemId: 'a', amount: 1 }], issuedAt: new Date('2026-07-10Z') });
    await item('a', { activeInvoiceId: first._id });

    expect((await activeForItems(WS, ['a'])).get('a').number).toBe('INV-1');
  });

  it('falls back to the latest issued invoice when the item points at none', async () => {
    await make('INV-1', { lines: [{ itemId: 'a', amount: 1 }], issuedAt: new Date('2026-07-01Z') });
    await make('INV-2', { lines: [{ itemId: 'a', amount: 1 }], issuedAt: new Date('2026-07-10Z') });
    await item('a');

    expect((await activeForItems(WS, ['a'])).get('a').number).toBe('INV-2');
  });

  it('ignores a void invoice', async () => {
    await make('INV-1', { lines: [{ itemId: 'a', amount: 1 }], status: 'void' });
    expect((await activeForItems(WS, ['a'])).size).toBe(0);
  });

  it('returns an empty map for no items', async () => {
    expect((await activeForItems(WS, [])).size).toBe(0);
  });
});

describe('forParticipant', () => {
  it('returns the issued invoices for a participant on a board, oldest first', async () => {
    await make('INV-2', { issuedAt: new Date('2026-08-01Z') });
    await make('INV-1', { issuedAt: new Date('2026-07-01Z') });
    await make('INV-3', { participant: { name: 'Someone Else' } });
    await make('INV-4', { boardId: 'other-board' });
    await make('INV-5', { status: 'void' });

    const found = await forParticipant({ workspaceId: WS, boardId: BOARD, participant: 'Jane Smith' });
    expect(found.map((i) => i.number)).toEqual(['INV-1', 'INV-2']);
  });
});

describe('slotInvoices', () => {
  it('returns the invoices a slot produced on a board', async () => {
    await make('INV-1', { periodKey: '20260701-0900' });
    await make('INV-2', { periodKey: '20260801-0900' });
    await make('INV-3', { periodKey: '20260701-0900', boardId: 'other' });

    const found = await slotInvoices(WS, BOARD, '20260701-0900');
    expect(found.map((i) => i.number)).toEqual(['INV-1']);
  });
});

describe('stampXero', () => {
  it('records the Xero number on the invoice and on its document rows', async () => {
    const invoice = await make('INV-1');
    await PDFLink.create({
      itemId: 'item-INV-1', workspaceId: WS, pdfLink: 'https://s3/1.pdf', type: 'NDIS Invoice', invoiceId: invoice._id,
    });

    const updated = await stampXero(invoice._id, 'INV-0007');

    expect(updated.xero.invoiceNumber).toBe('INV-0007');
    expect((await PDFLink.findOne({ itemId: 'item-INV-1' }).lean()).xeroInvoiceNumber).toBe('INV-0007');
  });

  it('throws for an invoice that does not exist', async () => {
    await expect(stampXero(new mongoose.Types.ObjectId(), 'INV-0007')).rejects.toThrow(/not found/i);
  });
});
