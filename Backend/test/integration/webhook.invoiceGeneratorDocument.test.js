import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

// The generator itself is the boundary here: it renders a PDF and uploads it to
// S3. What this file is about is what the route records afterwards.
vi.mock('../../src/services/automation/ndisInvoiceGeneratorPdf.js', () => ({
  generateNdisInvoiceGeneratorPdf: vi.fn(),
}));

const { generateNdisInvoiceGeneratorPdf } = await import(
  '../../src/services/automation/ndisInvoiceGeneratorPdf.js'
);
const { createApp } = await import('../../src/app.js');
const PDFLink = (await import('../../src/models/PDFLink.js')).default;
const Invoice = (await import('../../src/models/Invoice.js')).default;
const Item = (await import('../../src/models/Item.js')).default;
const mongoose = (await import('mongoose')).default;
const { up: buildInvoiceIndexes } = await import('../../migrations/1791102300000-invoice-ledger-indexes.js');
const { resetIndexCheckForTests } = await import('../../src/utils/invoiceLedger/issue.js');

const app = createApp();
const WORKSPACE = '55369';
const BOARD = 'eNiJpH14PN3';

beforeEach(async () => {
  await PDFLink.deleteMany({});
  generateNdisInvoiceGeneratorPdf.mockResolvedValue({
    invoiceNumber: 'INV-1210 (ISO+™)',
    fileUrl: 'https://s3.example/inv-1210.pdf',
    invoiceTotal: 12393.3,
    itemCount: 2,
    lineCount: 7,
    lineAmounts: { 'shift-aug': 5000.3, 'shift-sep': 7393 },
  });
});

const post = (body) => request(app)
  .post(`/api/pdf/${WORKSPACE}/${BOARD}/invoicendis-invoice-generator`)
  .send({
    // The shape the Invoice Generator screen posts: one entry per line, keyed
    // `<itemId>:<code>`, so two shifts arrive as seven rows.
    items: [
      { id: 'shift-aug:support' },
      { id: 'shift-aug:provider_travel_non_labour' },
      { id: 'shift-aug:allowances' },
      { id: 'shift-sep:support' },
      { id: 'shift-sep:provider_travel_non_labour' },
      { id: 'shift-sep:activity_transport' },
      { id: 'shift-sep:allowances' },
    ],
    participantName: 'Masoud Test',
    invoiceDate: '2026-09-01T00:00:00.000Z',
    dueDate: '2026-09-15T00:00:00.000Z',
    ...body,
  });

/**
 * The Invoice Generator screen is how invoices are actually raised on this
 * board, and until now it recorded nothing at all. ISO+ marked both shifts
 * INV-1210, the portal held no document for it, and the statement went on
 * citing INV-1205 — an older, smaller invoice that no longer matched anything.
 * A client would receive an invoice for $12,393.30 and a statement quoting
 * $6,841.91 against a different number.
 */
describe('an invoice raised from the Invoice Generator', () => {
  it('records a document row for every item on the invoice', async () => {
    await post();

    const rows = await PDFLink.find({ workspaceId: WORKSPACE }).lean();
    expect(rows.map((row) => row.itemId).sort()).toEqual(['shift-aug', 'shift-sep']);
  });

  // The three fields the statement of account matches on. Without them the row
  // exists but is unreachable, which is the same outcome as not writing it.
  it('carries the board, the participant and the billed figure', async () => {
    await post();

    const [row] = await PDFLink.find({ workspaceId: WORKSPACE, itemId: 'shift-aug' }).lean();
    expect(row.boardId).toBe(BOARD);
    expect(row.participant).toBe('Masoud Test');
    expect(row.invoiceNumber).toBe('INV-1210 (ISO+™)');
    expect(row.type).toBe('NDIS Invoice');
  });

  /**
   * One invoice covering several shifts is one charge on the statement, not
   * one per shift. The whole invoice total is stamped on every row and readers
   * dedupe by `pdfLink` — the convention `recordPdfLinks` already follows and
   * `participantInvoices` already relies on. Summing the rows instead would
   * bill this participant $24,786.60 for a $12,393.30 invoice.
   */
  it('stamps the whole invoice total on each row, under one document link', async () => {
    await post();

    const rows = await PDFLink.find({ workspaceId: WORKSPACE }).lean();
    expect(rows.map((row) => row.invoiceTotal)).toEqual([12393.3, 12393.3]);
    expect(new Set(rows.map((row) => row.pdfLink)).size).toBe(1);
  });

  // The operator's own date, so a backdated invoice is stated in the month it
  // claims rather than on the day it was generated.
  it('records the invoice date the operator supplied', async () => {
    await post({ invoiceDate: '2026-06-20T00:00:00.000Z' });

    const [row] = await PDFLink.find({ workspaceId: WORKSPACE, itemId: 'shift-aug' }).lean();
    expect(new Date(row.invoiceDate).toISOString()).toBe('2026-06-20T00:00:00.000Z');
  });

  // Nothing was billed, so there is nothing to state.
  it('records nothing when the generator found nothing to invoice', async () => {
    generateNdisInvoiceGeneratorPdf.mockResolvedValue({ empty: true });
    await post();

    expect(await PDFLink.countDocuments({ workspaceId: WORKSPACE })).toBe(0);
  });
});

/**
 * KAN-306: with INVOICE_LEDGER_WRITE on, the same request also records the invoice
 * (one document, its lines the amounts the generator rendered). Off, nothing new.
 */
describe('the invoice record (INVOICE_LEDGER_WRITE)', () => {
  // The number the portal writes since KAN-294, with no suffix, as marker and as the generator's result.
  beforeEach(() => {
    generateNdisInvoiceGeneratorPdf.mockResolvedValue({
      invoiceNumber: 'INV-1210',
      fileUrl: 'https://s3.example/inv-1210.pdf',
      invoiceTotal: 12393.3,
      itemCount: 2,
      lineCount: 7,
      lineAmounts: { 'shift-aug': 5000.3, 'shift-sep': 7393 },
      invoiceDate: '2026-09-01T00:00:00.000Z',
      dueDate: '2026-09-15T00:00:00.000Z',
    });
  });

  const saved = process.env.INVOICE_LEDGER_WRITE;

  beforeEach(async () => {
    await Invoice.deleteMany({});
    await Item.deleteMany({});
    await Item.insertMany(['shift-aug', 'shift-sep'].map((itemId) => ({
      workspaceId: WORKSPACE, boardId: BOARD, folderId: 'f', itemId, data: {}, invoicedBy: 'INV-1210',
    })));
    await buildInvoiceIndexes(mongoose.connection);
    resetIndexCheckForTests();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.INVOICE_LEDGER_WRITE; else process.env.INVOICE_LEDGER_WRITE = saved;
  });

  it('records one manual invoice with the rendered line amounts, and points the items at it', async () => {
    process.env.INVOICE_LEDGER_WRITE = 'on';
    await post();

    const invoices = await Invoice.find({ workspaceId: WORKSPACE }).lean();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      number: 'INV-1210', legacyNumbers: [], kind: 'ndis', trigger: 'manual', total: 12393.3,
      participant: { name: 'Masoud Test' },
    });
    expect(invoices[0].lines).toEqual([{ itemId: 'shift-aug', amount: 5000.3 }, { itemId: 'shift-sep', amount: 7393 }]);
    expect(invoices[0].issuedAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(invoices[0].dueDate.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    const rows = await PDFLink.find({ workspaceId: WORKSPACE }).lean();
    expect(rows.every((r) => String(r.invoiceId) === String(invoices[0]._id))).toBe(true);
    expect((await Item.find({ workspaceId: WORKSPACE }).lean()).every((i) => String(i.activeInvoiceId) === String(invoices[0]._id))).toBe(true);
  });

  it('dates the invoice from what the document printed when the request leaves the dates out', async () => {
    process.env.INVOICE_LEDGER_WRITE = 'on';
    await post({ invoiceDate: '', dueDate: undefined });

    const [invoice] = await Invoice.find({ workspaceId: WORKSPACE }).lean();
    expect(invoice.issuedAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(invoice.dueDate.toISOString()).toBe('2026-09-15T00:00:00.000Z');
  });

  it('writes no invoice with the flag off, and the response is the same', async () => {
    delete process.env.INVOICE_LEDGER_WRITE;
    const res = await post();

    expect(res.body).toMatchObject({ invoiceNumber: 'INV-1210', itemCount: 2, lineCount: 7 });
    expect(await Invoice.countDocuments({})).toBe(0);
  });

  it('still answers with the invoice when the record cannot be written', async () => {
    process.env.INVOICE_LEDGER_WRITE = 'on';
    await Invoice.collection.dropIndexes();
    resetIndexCheckForTests();
    const res = await post();

    expect(res.status).toBe(200);
    expect(res.body.invoiceNumber).toBe('INV-1210');
    expect(await PDFLink.countDocuments({ workspaceId: WORKSPACE })).toBe(2);
  });
});
