import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';

import Invoice from '../../src/models/Invoice.js';
import InvoiceNumber from '../../src/models/InvoiceNumber.js';
import Item from '../../src/models/Item.js';
import { up as buildInvoiceIndexes } from '../../migrations/1791102300000-invoice-ledger-indexes.js';

vi.mock('../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, warn: vi.fn(actual.warn), info: vi.fn(actual.info) };
});
const { warn, info } = await import('../../src/utils/logger.js');
const { loadInvoiceMaps } = await import('../../src/utils/invoiceLedger/listMaps.js');

/**
 * KAN-313: what the Invoice Generator lists show as "invoiced", the number and the link, behind
 * INVOICE_LEDGER_READ. Both list builders (NDIS and Age Care) take two maps from this reader:
 * item to number, item to document link.
 *
 *   off     the old log (type PDF), as before
 *   shadow  the old maps are served; every item whose answer differs is logged with a class
 *   on      the invoice record, and an item carrying a real marker with no record counts as invoiced
 */

const WS = 'w-list';
const BOARD = 'b-list';

const item = (itemId, over = {}) => Item.create({ workspaceId: WS, boardId: BOARD, folderId: 'f', itemId, data: {}, ...over });
const log = (itemId, invoiceNumber, extra = {}) => InvoiceNumber.create({
  itemId, workspaceId: WS, boardId: BOARD, invoiceNumber, type: 'PDF', pdfLink: `https://s3/${invoiceNumber}.pdf`, ...extra,
});
const invoice = (number, itemIds, over = {}) => Invoice.create({
  workspaceId: WS,
  boardId: BOARD,
  number,
  kind: 'ndis',
  participant: { name: 'Jane Smith' },
  lines: itemIds.map((itemId) => ({ itemId, amount: 10 })),
  total: 10 * itemIds.length,
  issuedAt: new Date('2026-07-01T00:00:00Z'),
  trigger: 'manual',
  pdf: { pdfLink: `https://s3/${number}.pdf` },
  ...over,
});

const load = (ids) => loadInvoiceMaps({
  workspaceId: WS, boardId: BOARD, itemIds: ids, InvoiceNumber,
});
const entries = (map) => [...map].sort(([a], [b]) => a.localeCompare(b));
const shadowLogs = (fn) => fn.mock.calls.filter((c) => c[1] === 'Shadow difference').map((c) => c[2].class);

const saved = process.env.INVOICE_LEDGER_READ;

beforeEach(async () => {
  await Promise.all([Invoice, InvoiceNumber, Item].map((m) => m.deleteMany({})));
  await buildInvoiceIndexes(mongoose.connection);
  vi.clearAllMocks();
});

afterEach(() => {
  if (saved === undefined) delete process.env.INVOICE_LEDGER_READ; else process.env.INVOICE_LEDGER_READ = saved;
});

describe('INVOICE_LEDGER_READ=off', () => {
  it('reads the log alone, and never the invoice record', async () => {
    delete process.env.INVOICE_LEDGER_READ;
    await log('a', 'INV-24 (ISO+™)');
    await invoice('INV-3', ['b']);
    const find = vi.spyOn(Invoice, 'find');

    const { invoiceNumberMap, invoiceFileUrlMap } = await load(['a', 'b']);

    expect(entries(invoiceNumberMap)).toEqual([['a', 'INV-24 (ISO+™)']]);
    expect(entries(invoiceFileUrlMap)).toEqual([['a', 'https://s3/INV-24 (ISO+™).pdf']]);
    expect(find).not.toHaveBeenCalled();
    find.mockRestore();
  });

  it('is empty for no items', async () => {
    delete process.env.INVOICE_LEDGER_READ;
    expect((await load([])).invoiceNumberMap.size).toBe(0);
  });
});

describe('the Age Care CSV asks for rows of every type, as its old query did', () => {
  it('off: a Xero row is read too, and the last row of an item wins, exactly as before', async () => {
    delete process.env.INVOICE_LEDGER_READ;
    await log('a', 'INV-24 (ISO+™)');
    await InvoiceNumber.create({ itemId: 'a', workspaceId: WS, boardId: BOARD, invoiceNumber: 'INV-0501 (Xero)', type: 'Xero' });

    const typed = await load(['a']);
    const everyType = await loadInvoiceMaps({
      workspaceId: WS, boardId: BOARD, itemIds: ['a'], InvoiceNumber, allTypes: true,
    });

    expect(typed.invoiceNumberMap.get('a')).toBe('INV-24 (ISO+™)');
    expect(everyType.invoiceNumberMap.get('a')).toBe('INV-0501 (Xero)');
  });
});

describe('INVOICE_LEDGER_READ=on', () => {
  beforeEach(() => { process.env.INVOICE_LEDGER_READ = 'on'; });

  it('shows an item on an invoice as invoiced, with the number as stored and the document link', async () => {
    await invoice('INV-24', ['a', 'b'], { legacyNumbers: ['INV-24 (ISO+™)'] });
    await invoice('INV-30', ['c']);

    const { invoiceNumberMap, invoiceFileUrlMap } = await load(['a', 'b', 'c', 'd']);

    expect(entries(invoiceNumberMap)).toEqual([['a', 'INV-24 (ISO+™)'], ['b', 'INV-24 (ISO+™)'], ['c', 'INV-30']]);
    expect(invoiceFileUrlMap.get('a')).toBe('https://s3/INV-24.pdf');
    expect(invoiceNumberMap.has('d')).toBe(false);
  });

  it('shows an item billed only in Xero as invoiced: it no longer looks billable', async () => {
    await invoice('INV-0600', ['a'], { source: 'xero', legacyNumbers: ['INV-0600 (Xero)'], pdf: undefined });
    const { invoiceNumberMap, invoiceFileUrlMap } = await load(['a']);
    expect(invoiceNumberMap.get('a')).toBe('INV-0600 (Xero)');
    expect(invoiceFileUrlMap.get('a')).toBeNull();
  });

  it('counts an item with a real marker and no invoice record as invoiced, but not a pending claim', async () => {
    await item('a', { invoicedBy: 'INV-3' });
    await item('b', { invoicedBy: 'pending:ndis:20260701-0900:Jane' });
    const { invoiceNumberMap } = await load(['a', 'b']);
    expect(entries(invoiceNumberMap)).toEqual([['a', 'INV-3']]);
  });

  it('uses the invoice the item points at when it is on two', async () => {
    const first = await invoice('INV-1', ['a'], { issuedAt: new Date('2026-07-01Z') });
    await invoice('INV-2', ['a'], { issuedAt: new Date('2026-08-01Z') });
    await item('a', { activeInvoiceId: first._id });
    expect((await load(['a'])).invoiceNumberMap.get('a')).toBe('INV-1');
  });

  it('ignores a void invoice, but an item whose marker still names it counts as invoiced (the safe direction)', async () => {
    await invoice('INV-1', ['a', 'b'], { status: 'void' });
    await item('b', { invoicedBy: 'INV-1' });
    expect([...(await load(['a', 'b'])).invoiceNumberMap]).toEqual([['b', 'INV-1']]);
  });

  // Until scheduled selection drops the log filter (4c), a logged item with no marker and no
  // record must not read as billable: the log row is the guard that is still standing.
  it('still counts an item with a PDF log row, no marker and no record as invoiced', async () => {
    await log('a', 'INV-24 (ISO+™)');
    const { invoiceNumberMap, invoiceFileUrlMap } = await load(['a']);
    expect(invoiceNumberMap.get('a')).toBe('INV-24 (ISO+™)');
    expect(invoiceFileUrlMap.get('a')).toBe('https://s3/INV-24 (ISO+™).pdf');
  });

  it('prefers the record to the log row for the same item', async () => {
    await log('a', 'INV-24 (ISO+™)');
    await invoice('INV-30', ['a']);
    expect((await load(['a'])).invoiceNumberMap.get('a')).toBe('INV-30');
  });
});

describe('INVOICE_LEDGER_READ=shadow', () => {
  beforeEach(() => { process.env.INVOICE_LEDGER_READ = 'shadow'; });

  it('serves the old maps and logs an item only the record knows as an expected class', async () => {
    await invoice('INV-3', ['a']);
    const { invoiceNumberMap } = await load(['a']);
    expect(invoiceNumberMap.size).toBe(0);
    expect(shadowLogs(info)).toEqual(['list_invoiced_ledger_only']);
    expect(shadowLogs(warn)).toEqual([]);
  });

  it('says nothing when the log and the record agree, even when the number differs only by its suffix', async () => {
    await log('a', 'INV-24 (ISO+™)', { pdfLink: 'https://s3/INV-24.pdf' });
    await invoice('INV-24', ['a'], { legacyNumbers: ['INV-24 (ISO+™)'] });
    await load(['a']);
    expect(shadowLogs(info)).toEqual([]);
    expect(shadowLogs(warn)).toEqual([]);
  });

  it('warns for an item only the log knows, a different number, or a different document', async () => {
    await log('a', 'INV-1');
    await log('b', 'INV-2');
    await invoice('INV-9', ['b']);
    await log('c', 'INV-4', { pdfLink: 'https://s3/log-4.pdf' });
    await invoice('INV-4', ['c'], { pdf: { pdfLink: 'https://s3/other-4.pdf' } });

    await load(['a', 'b', 'c']);

    expect(shadowLogs(warn).sort()).toEqual(['list_invoiced_legacy_only', 'list_link_differs', 'list_number_differs']);
  });

  it('logs one line per class per call, with a count and a few examples, not one per item', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `x${i}`);
    for (const id of ids) await invoice(`INV-${id}`, [id]);
    await load(ids);

    const lines = info.mock.calls.filter((c) => c[1] === 'Shadow difference');
    expect(lines).toHaveLength(1);
    expect(lines[0][2]).toMatchObject({ class: 'list_invoiced_ledger_only', count: 60 });
    expect(lines[0][2].sampleItemIds).toHaveLength(20);
  });

  it('treats an empty log number as not invoiced', async () => {
    await InvoiceNumber.create({ itemId: 'a', workspaceId: WS, boardId: BOARD, invoiceNumber: '-', type: 'PDF' });
    await InvoiceNumber.updateOne({ itemId: 'a' }, { $set: { invoiceNumber: '' } });
    await load(['a']);
    expect(shadowLogs(warn)).toEqual([]);
    expect(shadowLogs(info)).toEqual([]);
  });

  it('never fails the list when the comparison cannot run', async () => {
    await log('a', 'INV-1');
    const spy = vi.spyOn(Invoice, 'find').mockImplementation(() => { throw new Error('boom'); });
    const { invoiceNumberMap } = await load(['a']);
    spy.mockRestore();
    expect(invoiceNumberMap.get('a')).toBe('INV-1');
    expect(warn.mock.calls.some((c) => /could not be compared/i.test(c[1]))).toBe(true);
  });
});
