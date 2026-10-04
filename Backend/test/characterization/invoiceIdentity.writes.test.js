import { describe, it, expect, beforeEach, vi } from 'vitest';

import Item from '../../src/models/Item.js';
import InvoiceNumber from '../../src/models/InvoiceNumber.js';

vi.mock('../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, info: vi.fn(), warn: vi.fn() };
});

const { saveInvoiceNumber } = await import('../../src/utils/invoicePdfSupport.js');

/**
 * KAN-303. Characterization of how an invoice's identity is written TODAY, ahead
 * of KAN-302 (one source of truth for invoices). These tests record the current
 * behaviour, accidents included, and pass against the unmodified code. When a
 * later change alters one of them on purpose, the change updates the test and
 * says why.
 *
 * Vocabulary, to match docs/superpowers/specs/2026-10-04-invoice-source-of-truth-design.md:
 *   marker = Item.invoicedBy        log = InvoiceNumber rows (one per item and type)
 *
 * Design cases pinned here: g (one item, two numbers), i (log row overwritten by
 * a later number), c and f (Xero and PDF on one item).
 */

const WS = 'ws-char';
const BOARD = 'board-char';
const FIRST = 'INV-3001';
const SECOND = 'INV-3002';
const XERO = 'INV-0001 (Xero)';

const markerOf = async (itemId) => (await Item.findOne({ itemId }).lean()).invoicedBy ?? null;
const logRows = (itemId) => InvoiceNumber.find({ itemId }).sort({ type: 1 }).lean();

beforeEach(async () => {
  vi.clearAllMocks();
  await Item.create({ workspaceId: WS, boardId: BOARD, folderId: 'f1', itemId: 'a', data: {} });
});

describe('a second PDF number for an item that already carries one (cases g and i)', () => {
  it('overwrites the item\'s log row with the later number', async () => {
    await saveInvoiceNumber(WS, BOARD, 'a', FIRST, 'PDF', 'https://s3/first.pdf');
    await saveInvoiceNumber(WS, BOARD, 'a', SECOND, 'PDF', 'https://s3/second.pdf');

    const rows = await logRows('a');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ invoiceNumber: SECOND, type: 'PDF', pdfLink: 'https://s3/second.pdf' });
  });

  it('keeps the first number on the marker, so marker and log now disagree', async () => {
    await saveInvoiceNumber(WS, BOARD, 'a', FIRST, 'PDF', 'https://s3/first.pdf');
    await saveInvoiceNumber(WS, BOARD, 'a', SECOND, 'PDF', 'https://s3/second.pdf');

    expect(await markerOf('a')).toBe(FIRST);
    expect((await logRows('a'))[0].invoiceNumber).toBe(SECOND);
  });

  it('keeps the log row\'s original createdAt and moves its updatedAt', async () => {
    await saveInvoiceNumber(WS, BOARD, 'a', FIRST, 'PDF', 'https://s3/first.pdf');
    const [before] = await logRows('a');
    await new Promise((resolve) => setTimeout(resolve, 15));
    await saveInvoiceNumber(WS, BOARD, 'a', SECOND, 'PDF', 'https://s3/second.pdf');
    const [after] = await logRows('a');

    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });
});

describe('the same item on a PDF invoice and a Xero invoice (cases c and f)', () => {
  it('PDF first: the marker stays on the PDF number and the log holds one row per type', async () => {
    await saveInvoiceNumber(WS, BOARD, 'a', FIRST, 'PDF', 'https://s3/first.pdf');
    await saveInvoiceNumber(WS, BOARD, 'a', XERO, 'Xero');

    expect(await markerOf('a')).toBe(FIRST);
    const rows = await logRows('a');
    expect(rows.map((r) => [r.type, r.invoiceNumber])).toEqual([['PDF', FIRST], ['Xero', XERO]]);
  });

  it('Xero first: the marker stays on the Xero number and a later PDF still gets its own log row', async () => {
    await saveInvoiceNumber(WS, BOARD, 'a', XERO, 'Xero');
    await saveInvoiceNumber(WS, BOARD, 'a', FIRST, 'PDF', 'https://s3/first.pdf');

    expect(await markerOf('a')).toBe(XERO);
    const rows = await logRows('a');
    expect(rows.map((r) => [r.type, r.invoiceNumber])).toEqual([['PDF', FIRST], ['Xero', XERO]]);
  });

  it('a Xero-only item has a Xero log row and no PDF row, so a PDF-keyed reader sees nothing', async () => {
    await saveInvoiceNumber(WS, BOARD, 'a', XERO, 'Xero');

    expect(await InvoiceNumber.countDocuments({ itemId: 'a', type: 'PDF' })).toBe(0);
    expect(await InvoiceNumber.countDocuments({ itemId: 'a', type: 'Xero' })).toBe(1);
  });
});

describe('the log row is keyed by item, workspace, board and type (case i)', () => {
  it('writes separate rows for the same item on two boards', async () => {
    await Item.create({ workspaceId: WS, boardId: 'board-other', folderId: 'f1', itemId: 'a2', data: {} });
    await saveInvoiceNumber(WS, BOARD, 'a', FIRST, 'PDF', 'https://s3/first.pdf');
    await saveInvoiceNumber(WS, 'board-other', 'a2', SECOND, 'PDF', 'https://s3/second.pdf');

    expect(await InvoiceNumber.countDocuments({})).toBe(2);
  });

  it('allows the same number on many items, one row each', async () => {
    await Item.create({ workspaceId: WS, boardId: BOARD, folderId: 'f1', itemId: 'b', data: {} });
    await saveInvoiceNumber(WS, BOARD, 'a', FIRST, 'PDF', 'https://s3/first.pdf');
    await saveInvoiceNumber(WS, BOARD, 'b', FIRST, 'PDF', 'https://s3/first.pdf');

    const rows = await InvoiceNumber.find({ invoiceNumber: FIRST }).lean();
    expect(rows.map((r) => r.itemId).sort()).toEqual(['a', 'b']);
  });
});
