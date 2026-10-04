import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';

import { createApp } from '../../src/app.js';
import { authenticatedAgent } from '../helpers/auth.js';
import Invoice from '../../src/models/Invoice.js';
import InvoiceNumber from '../../src/models/InvoiceNumber.js';
import { up as buildInvoiceIndexes } from '../../migrations/1791102300000-invoice-ledger-indexes.js';

vi.mock('../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, warn: vi.fn(actual.warn), info: vi.fn(actual.info) };
});
const { warn, info } = await import('../../src/utils/logger.js');

/**
 * KAN-313: GET /api/items/:ws/:board/invoice/:number/pdf-link with INVOICE_LEDGER_READ.
 *
 *   off     the old log, as before (pinned by test/characterization/invoiceIdentity.pdfLink.test.js)
 *   shadow  the old answer is served; a difference from the invoice record is logged with a class
 *   on      the invoice record: any form of the number resolves, an invoice that exists only as
 *           a marker or a backfilled record is found, the response keeps its shape
 */

const app = createApp();
const WS = 'w-pdf';
const BOARD = 'b-pdf';

const get = async (number, board = BOARD) => {
  const { agent } = await authenticatedAgent(app);
  return agent.get(`/api/items/${WS}/${board}/invoice/${encodeURIComponent(number)}/pdf-link`);
};

const log = (itemId, invoiceNumber, extra = {}) => InvoiceNumber.create({
  itemId, workspaceId: WS, boardId: BOARD, invoiceNumber, type: 'PDF', pdfLink: `https://s3/${itemId}.pdf`, ...extra,
});
const invoice = (number, over = {}) => Invoice.create({
  workspaceId: WS,
  boardId: BOARD,
  number,
  kind: 'ndis',
  participant: { name: 'Jane Smith' },
  lines: [{ itemId: 'i1', amount: 10 }, { itemId: 'i2', amount: 5 }],
  total: 15,
  issuedAt: new Date('2026-07-01T00:00:00Z'),
  trigger: 'manual',
  pdf: { pdfLink: `https://s3/${number}.pdf` },
  ...over,
});

const saved = process.env.INVOICE_LEDGER_READ;

beforeEach(async () => {
  await Promise.all([Invoice, InvoiceNumber].map((m) => m.deleteMany({})));
  await buildInvoiceIndexes(mongoose.connection);
  vi.clearAllMocks();
});

afterEach(() => {
  if (saved === undefined) delete process.env.INVOICE_LEDGER_READ; else process.env.INVOICE_LEDGER_READ = saved;
});

describe('INVOICE_LEDGER_READ=off', () => {
  it('reads the old log and never the invoice record', async () => {
    delete process.env.INVOICE_LEDGER_READ;
    await invoice('INV-3');
    const find = vi.spyOn(Invoice, 'findOne');
    expect((await get('INV-3')).status).toBe(404);
    expect(find).not.toHaveBeenCalled();
    find.mockRestore();
  });
});

describe('INVOICE_LEDGER_READ=on', () => {
  beforeEach(() => { process.env.INVOICE_LEDGER_READ = 'on'; });

  it('finds an invoice by its plain number and answers in the same shape, with the first item', async () => {
    await invoice('INV-10');
    const res = await get('INV-10');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pdfLink: 'https://s3/INV-10.pdf', invoiceNumber: 'INV-10', itemId: 'i1' });
  });

  it('answers with the number as it was stored when the invoice has a legacy form, and finds it from either form', async () => {
    await invoice('INV-11', { legacyNumbers: ['INV-11 (ISO+™)'] });
    const plain = await get('INV-11');
    const suffixed = await get('INV-11 (ISO+™)');
    expect(plain.body.invoiceNumber).toBe('INV-11 (ISO+™)');
    expect(suffixed.status).toBe(200);
    expect(suffixed.body.invoiceNumber).toBe('INV-11 (ISO+™)');
  });

  it('answers 404 with the same message when there is no such invoice', async () => {
    const res = await get('INV-404');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Invoice not found or is not a PDF invoice');
  });

  it('answers 404, link not available, for an invoice with no document', async () => {
    await invoice('INV-12', { pdf: undefined });
    const res = await get('INV-12');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('PDF link not available for this invoice');
  });

  it('does not answer for another board, and a Xero invoice has no PDF to give', async () => {
    await invoice('INV-13');
    expect((await get('INV-13', 'other-board')).status).toBe(404);
    await invoice('INV-0001', { source: 'xero', legacyNumbers: ['INV-0001 (Xero)'], pdf: undefined });
    expect((await get('INV-0001')).status).toBe(404);
  });

  it('finds the duplicate that belongs to the board asked for, not only the one that owns the number workspace-wide', async () => {
    await invoice('INV-16', { boardId: 'board-A' });
    await invoice('INV-16', { boardId: BOARD, duplicateOrdinal: 1, pdf: { pdfLink: 'https://s3/mine.pdf' } });
    const res = await get('INV-16');
    expect(res.status).toBe(200);
    expect(res.body.pdfLink).toBe('https://s3/mine.pdf');
  });

  it('never serves an invoice with no board to a board that asks, as the old lookup required the board to match', async () => {
    await invoice('INV-17', { boardId: undefined });
    expect((await get('INV-17')).status).toBe(404);
  });

  it('prefers the invoice that owns a number over a flagged duplicate', async () => {
    await invoice('INV-14');
    await invoice('INV-14', { duplicateOrdinal: 1, pdf: { pdfLink: 'https://s3/dup.pdf' } });
    expect((await get('INV-14')).body.pdfLink).toBe('https://s3/INV-14.pdf');
  });

  it('a void invoice still resolves, so an old link keeps working', async () => {
    await invoice('INV-15', { status: 'void' });
    expect((await get('INV-15')).status).toBe(200);
  });
});

describe('INVOICE_LEDGER_READ=shadow', () => {
  beforeEach(() => { process.env.INVOICE_LEDGER_READ = 'shadow'; });

  it('serves the old answer and logs, as an expected class, an invoice only the record finds', async () => {
    await invoice('INV-20');
    expect((await get('INV-20')).status).toBe(404);
    const logged = info.mock.calls.filter((c) => c[1] === 'Shadow difference');
    expect(logged.map((c) => c[2].class)).toEqual(['pdf_link_ledger_only']);
  });

  it('says nothing when both agree', async () => {
    await invoice('INV-21', { legacyNumbers: ['INV-21 (ISO+™)'] });
    await log('i1', 'INV-21 (ISO+™)', { pdfLink: 'https://s3/INV-21.pdf' });
    const res = await get('INV-21');
    expect(res.status).toBe(200);
    expect(info.mock.calls.filter((c) => c[1] === 'Shadow difference')).toEqual([]);
    expect(warn.mock.calls.filter((c) => c[1] === 'Shadow difference')).toEqual([]);
  });

  it('warns when the old log finds an invoice the record does not, or the documents differ', async () => {
    await log('i1', 'INV-22');
    expect((await get('INV-22')).status).toBe(200);
    await log('i2', 'INV-23', { pdfLink: 'https://s3/log-23.pdf' });
    await invoice('INV-23', { pdf: { pdfLink: 'https://s3/other-23.pdf' } });
    expect((await get('INV-23')).body.pdfLink).toBe('https://s3/log-23.pdf');
    const classes = warn.mock.calls.filter((c) => c[1] === 'Shadow difference').map((c) => c[2].class);
    expect(classes).toEqual(['pdf_link_legacy_only', 'pdf_link_differs']);
  });

  it('never fails the request when the comparison cannot run', async () => {
    await log('i1', 'INV-24');
    const spy = vi.spyOn(Invoice, 'findOne').mockImplementation(() => { throw new Error('boom'); });
    const res = await get('INV-24');
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(warn.mock.calls.some((c) => /could not be compared/i.test(c[1]))).toBe(true);
  });
});
