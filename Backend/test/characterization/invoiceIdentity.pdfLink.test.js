import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../../src/app.js';
import { authenticatedAgent } from '../helpers/auth.js';
import Item from '../../src/models/Item.js';
import InvoiceNumber from '../../src/models/InvoiceNumber.js';
import PDFLink from '../../src/models/PDFLink.js';

/**
 * KAN-303. GET /api/items/:ws/:board/invoice/:number/pdf-link TODAY. It reads the
 * InvoiceNumber log (type PDF) only, tries the number as given and then the number
 * with " (ISO+™)" appended. It never reads the ledger (PDFLink) or the item marker.
 * Recorded ahead of KAN-302; see
 * docs/superpowers/specs/2026-10-04-invoice-source-of-truth-design.md.
 *
 * Design cases pinned: b (both directions), d, e, g, i, j, k, and the ledger being
 * ignored. The existing cases are in test/unit/routes/items.test.js.
 */

// These pin the old-log behaviour whatever Backend/.env says (KAN-313).
const savedReadMode = process.env.INVOICE_LEDGER_READ;
beforeEach(() => { delete process.env.INVOICE_LEDGER_READ; });
afterEach(() => {
  if (savedReadMode === undefined) delete process.env.INVOICE_LEDGER_READ; else process.env.INVOICE_LEDGER_READ = savedReadMode;
});

const app = createApp();
const WS = 'w-char';
const BOARD = 'b-char';

const get = async (number) => {
  const { agent } = await authenticatedAgent(app);
  return agent.get(`/api/items/${WS}/${BOARD}/invoice/${encodeURIComponent(number)}/pdf-link`);
};

const log = (itemId, invoiceNumber, extra = {}) => InvoiceNumber.create({
  itemId, workspaceId: WS, boardId: BOARD, invoiceNumber, type: 'PDF', pdfLink: `https://s3/${itemId}.pdf`, ...extra,
});

describe('the lookup resolves a number through the log, trying the suffixed form second', () => {
  it('finds a plain number stored plain', async () => {
    await log('i1', 'INV-10');
    const res = await get('INV-10');
    expect(res.status).toBe(200);
    expect(res.body.invoiceNumber).toBe('INV-10');
  });

  it('finds a suffixed number from the bare number, and returns it as stored (case b)', async () => {
    await log('i1', 'INV-11 (ISO+™)');
    const res = await get('INV-11');
    expect(res.status).toBe(200);
    expect(res.body.invoiceNumber).toBe('INV-11 (ISO+™)');
  });

  it('does not find a plain number from a suffixed request: the fallback only adds the suffix (case b, reverse)', async () => {
    await log('i1', 'INV-12');
    const res = await get('INV-12 (ISO+™)');
    expect(res.status).toBe(404);
  });

  it('does not strip a Xero suffix: a Xero marker number is not a PDF number', async () => {
    await log('i1', 'INV-0001 (Xero)', { type: 'Xero' });
    expect((await get('INV-0001 (Xero)')).status).toBe(404);
    expect((await get('INV-0001')).status).toBe(404);
  });
});

describe('what the lookup cannot see', () => {
  it('answers 404 for an invoice that exists only as a marker on its items (case d)', async () => {
    await Item.create({ workspaceId: WS, boardId: BOARD, folderId: 'f', itemId: 'i1', invoicedBy: 'INV-3', data: {} });
    expect((await get('INV-3')).status).toBe(404);
  });

  it('answers 404 for an invoice that exists only as a ledger document (case e, reversed)', async () => {
    await PDFLink.create({
      itemId: 'i1', workspaceId: WS, boardId: BOARD, type: 'NDIS Invoice', invoiceNumber: 'INV-4',
      pdfLink: 'https://s3/inv-4.pdf', invoiceTotal: 100,
    });
    expect((await get('INV-4')).status).toBe(404);
  });

  it('finds an invoice by the log even when the marker names a different number (cases g and i)', async () => {
    await Item.create({ workspaceId: WS, boardId: BOARD, folderId: 'f', itemId: 'i1', invoicedBy: 'INV-1', data: {} });
    await log('i1', 'INV-2');
    expect((await get('INV-2')).status).toBe(200);
    expect((await get('INV-1')).status).toBe(404);
  });

  it('still resolves a number whose item has since been deleted by sync (case k)', async () => {
    await log('gone', 'INV-5');
    const res = await get('INV-5');
    expect(res.status).toBe(200);
    expect(res.body.itemId).toBe('gone');
  });
});

describe('two items share one number', () => {
  it('returns the link of one of them: the invoice has one row per item and the lookup takes the first match (case j)', async () => {
    await log('i1', 'INV-6', { pdfLink: 'https://s3/one.pdf' });
    await log('i2', 'INV-6', { pdfLink: 'https://s3/one.pdf' });
    const res = await get('INV-6');
    expect(res.status).toBe(200);
    expect(['i1', 'i2']).toContain(res.body.itemId);
    expect(res.body.pdfLink).toBe('https://s3/one.pdf');
  });

  it('KNOWN GAP: returns one of two different invoices that share a number, with no rule for which (case j)', async () => {
    await log('i1', 'INV-7', { pdfLink: 'https://s3/first.pdf' });
    await log('i2', 'INV-7', { pdfLink: 'https://s3/second.pdf' });
    const res = await get('INV-7');
    expect(res.status).toBe(200);
    expect(['https://s3/first.pdf', 'https://s3/second.pdf']).toContain(res.body.pdfLink);
  });
});
