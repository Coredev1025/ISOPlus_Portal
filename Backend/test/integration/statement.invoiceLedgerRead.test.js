import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The statement of account with INVOICE_LEDGER_READ (KAN-309). The case that started this
 * (KAN-296, KAN-297): an invoice that exists only as an item marker (INV-3) has no document
 * row, so the statement leaves it out and drops the payment recorded against it. With the
 * read switched to the invoice record the invoice is charged and the payment applied.
 *
 *   off     the old stores, as before
 *   shadow  the old answer is served; every difference is logged with its class
 *   on      the invoice record
 */

const renderedInputs = [];

vi.mock('@pdfme/generator', () => ({
  generate: vi.fn(async ({ inputs }) => {
    renderedInputs.push(inputs[0]);
    return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  }),
}));

vi.mock('../../src/utils/uploadS3.js', () => ({
  uploadFileToS3: vi.fn(async () => ({ $metadata: { httpStatusCode: 200 } })),
  getS3FileUrl: vi.fn(async (key) => `https://s3.example/${key}`),
  getS3File: vi.fn(async () => Buffer.from('logo')),
}));

vi.mock('../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, warn: vi.fn(actual.warn), info: vi.fn(actual.info) };
});

const mongoose = (await import('mongoose')).default;
const { warn, info } = await import('../../src/utils/logger.js');
const { default: Board } = await import('../../src/models/Board.js');
const { default: Business } = await import('../../src/models/Business.js');
const { default: Item } = await import('../../src/models/Item.js');
const { default: PDFLink } = await import('../../src/models/PDFLink.js');
const { default: Invoice } = await import('../../src/models/Invoice.js');
const { up: buildInvoiceIndexes } = await import('../../migrations/1791102300000-invoice-ledger-indexes.js');
const { PDFLINK_TYPE_NDIS_INVOICE } = await import('../../src/constants/automation.js');
const { generateStatementsForBoard } = await import('../../src/services/automation/generateStatements.js');

const WORKSPACE = '55369';
const BOARD = 'eNiJpH14PN3';
const PARTICIPANT = 'Masoud Test';
const TZ = 'Australia/Sydney';
const SLOT = '2026-09-01T13:00:00.000Z';
const PERIOD_KEY = '20260901-2300';

const statementRender = () => renderedInputs.find((input) => input?.transactions !== undefined);
const closingBalance = () => statementRender().amountDue;

const personItem = (itemId, invoicedBy, amount) => ({
  itemId,
  workspaceId: WORKSPACE,
  boardId: BOARD,
  folderId: 'folder-1',
  invoicedBy,
  data: {
    'Full Name/Preferred Name': PARTICIPANT,
    'Participant Full Name': PARTICIPANT,
    'Amount Received($)': String(amount),
    'Payment Received Date': '2026-08-20T00:00:00.000Z',
    'Scheduled Shift Start Date & Time': '2026-08-15T09:00:00.000Z',
    'Actual Shift End Date & Time': '2026-08-15T11:00:00.000Z',
    'Total Amount ($)': '250.00',
  },
});

const invoiceRecord = (number, total, itemId, over = {}) => ({
  workspaceId: WORKSPACE,
  boardId: BOARD,
  number,
  source: 'portal',
  kind: 'ndis',
  participant: { name: PARTICIPANT },
  lines: [{ itemId, amount: total }],
  total,
  issuedAt: new Date('2026-08-05T00:00:00.000Z'),
  trigger: 'manual',
  status: 'issued',
  origin: 'live',
  ...over,
});

/**
 * INV-1205 is in both worlds ($250, $100 paid). INV-3 exists only as a marker on item-3,
 * with a $100 payment on it, and as a backfilled invoice record ($400).
 */
async function seed() {
  await Promise.all([Board, Business, Item, PDFLink, Invoice].map((m) => m.deleteMany({})));
  await Board.create({ boardId: BOARD, workspaceId: WORKSPACE, name: 'NDIS', label: 'Care Management NDIS 2026 Pricing' });
  await Business.create({
    workspaceId: WORKSPACE,
    name: 'Dev-Test11',
    abn: '12 345 678 901',
    bankDetails: { accountName: 'D', bankName: 'CBA', bsb: '062-000', accountNumber: '12345678' },
  });
  await Item.create(personItem('item-1', 'INV-1205', 100));
  await Item.create(personItem('item-3', 'INV-3', 100));
  await PDFLink.create({
    workspaceId: WORKSPACE,
    boardId: BOARD,
    itemId: 'item-1',
    participant: PARTICIPANT,
    type: PDFLINK_TYPE_NDIS_INVOICE,
    invoiceNumber: 'INV-1205',
    invoiceTotal: 250,
    pdfLink: 'https://s3.example/inv-1205.pdf',
    createdAt: new Date('2026-08-05T00:00:00.000Z'),
  });
  await Invoice.create(invoiceRecord('INV-1205', 250, 'item-1'));
  await Invoice.create(invoiceRecord('INV-3', 400, 'item-3', {
    issuedAt: new Date('2026-08-10T00:00:00.000Z'), origin: 'backfill',
  }));
}

const run = () => generateStatementsForBoard({
  workspaceId: WORKSPACE, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD_KEY,
});

const saved = process.env.INVOICE_LEDGER_READ;

beforeEach(async () => {
  renderedInputs.length = 0;
  vi.clearAllMocks();
  await seed();
  await buildInvoiceIndexes(mongoose.connection);
});

afterEach(() => {
  if (saved === undefined) delete process.env.INVOICE_LEDGER_READ; else process.env.INVOICE_LEDGER_READ = saved;
});

describe('INVOICE_LEDGER_READ=off', () => {
  it('never reads the invoice record', async () => {
    delete process.env.INVOICE_LEDGER_READ;
    const find = vi.spyOn(Invoice, 'find');
    await run();
    expect(find).not.toHaveBeenCalled();
    find.mockRestore();
  });

  it('states only the invoice with a document row and drops the payment on the marker-only one', async () => {
    delete process.env.INVOICE_LEDGER_READ;
    await run();

    // $250 charged, $100 received on INV-1205; INV-3 and its $100 payment are absent.
    expect(closingBalance()).toBe('$150.00');
    expect(JSON.parse(statementRender().transactions).some((row) => row.includes('INV-3'))).toBe(false);
  });
});

describe('INVOICE_LEDGER_READ=shadow', () => {
  it('serves the old answer and logs each difference with its class', async () => {
    process.env.INVOICE_LEDGER_READ = 'shadow';
    await run();

    expect(closingBalance()).toBe('$150.00');
    // Expected classes are informational (one line each); only unexpected ones warn.
    const logged = info.mock.calls.filter((call) => call[1] === 'Shadow difference');
    expect(logged.map((call) => call[2].class).sort()).toEqual(['ledger_only_invoice', 'payment_newly_applied']);
    expect(logged.every((call) => call[2].participant === PARTICIPANT)).toBe(true);
    expect(warn.mock.calls.filter((call) => call[1] === 'Shadow difference')).toEqual([]);
    const summary = info.mock.calls.find((call) => call[1] === 'Shadow summary');
    expect(summary[2]).toMatchObject({ participant: PARTICIPANT, unexpected: 0, closing: { legacy: 150, ledger: 450 } });
  });

  it('warns for a difference no known class explains', async () => {
    process.env.INVOICE_LEDGER_READ = 'shadow';
    await Invoice.updateOne({ number: 'INV-1205' }, { $set: { total: 275 } });
    await run();

    const unexpected = warn.mock.calls.filter((call) => call[1] === 'Shadow difference');
    expect(unexpected.map((call) => call[2].class)).toEqual(['total_differs']);
  });

  it('says nothing when the two agree', async () => {
    process.env.INVOICE_LEDGER_READ = 'shadow';
    await Invoice.deleteOne({ number: 'INV-3' });
    await Item.deleteOne({ itemId: 'item-3' });
    await run();

    expect(info.mock.calls.filter((call) => call[1] === 'Shadow difference')).toEqual([]);
    expect(warn.mock.calls.filter((call) => call[1] === 'Shadow difference')).toEqual([]);
  });

  it('never fails the statement when the comparison cannot run', async () => {
    process.env.INVOICE_LEDGER_READ = 'shadow';
    const spy = vi.spyOn(Invoice, 'find').mockRejectedValue(new Error('boom'));
    await run();
    spy.mockRestore();

    expect(closingBalance()).toBe('$150.00');
    expect(warn.mock.calls.some((call) => /could not be compared/i.test(call[1]))).toBe(true);
  });
});

describe('INVOICE_LEDGER_READ=on', () => {
  it('states the marker-only invoice and applies the payment recorded against it', async () => {
    process.env.INVOICE_LEDGER_READ = 'on';
    await run();

    const rows = JSON.parse(statementRender().transactions);
    expect(rows.some((row) => row.includes('INV-3'))).toBe(true);
    // $250 + $400 charged, $100 + $100 received.
    expect(closingBalance()).toBe('$450.00');
  });

  it('charges an invoice covering several items once, from the invoice total', async () => {
    process.env.INVOICE_LEDGER_READ = 'on';
    await Item.create(personItem('item-4', 'INV-3', 0));
    await Invoice.updateOne({ number: 'INV-3' }, { $set: { lines: [{ itemId: 'item-3', amount: 200 }, { itemId: 'item-4', amount: 200 }] } });
    await run();

    expect(closingBalance()).toBe('$450.00');
  });

  it('matches a payment by the item, not by the text of its marker', async () => {
    process.env.INVOICE_LEDGER_READ = 'on';
    await Item.updateOne({ itemId: 'item-3' }, { $set: { invoicedBy: 'INV-3 (ISO+™)' } });
    await run();

    expect(closingBalance()).toBe('$450.00');
  });

  it('reports a payment on an item that is on no invoice instead of dropping it silently', async () => {
    process.env.INVOICE_LEDGER_READ = 'on';
    await Invoice.deleteOne({ number: 'INV-3' });
    await run();

    expect(closingBalance()).toBe('$150.00');
    expect(warn.mock.calls.some((call) => /left off the statement/i.test(call[1]))).toBe(true);
  });

  it('applies two payments on one invoice', async () => {
    process.env.INVOICE_LEDGER_READ = 'on';
    await Item.create(personItem('item-4', 'INV-3', 60));
    await Invoice.updateOne({ number: 'INV-3' }, { $set: { lines: [{ itemId: 'item-3', amount: 200 }, { itemId: 'item-4', amount: 200 }] } });
    await run();

    // $250 + $400 charged; $100 + $100 + $60 received.
    expect(closingBalance()).toBe('$390.00');
  });

  it('ages and credits two invoices that print one number separately', async () => {
    process.env.INVOICE_LEDGER_READ = 'on';
    await Item.create(personItem('item-5', 'INV-1205', 0));
    await Invoice.create(invoiceRecord('INV-1205', 100, 'item-5', { source: 'xero', legacyNumbers: ['INV-1205 (Xero)'], issuedAt: new Date('2026-08-12T00:00:00.000Z') }));
    await run();

    // $250 + $400 + $100 charged, $200 received: both same-numbered invoices are charged.
    expect(closingBalance()).toBe('$550.00');
  });

  it('uses the due date the invoice carries, not issue plus fourteen days', async () => {
    process.env.INVOICE_LEDGER_READ = 'on';
    await Invoice.updateOne({ number: 'INV-3' }, { $set: { dueDate: new Date('2026-12-31T00:00:00.000Z') } });
    await run();

    const rows = JSON.parse(statementRender().transactions);
    expect(rows.some((row) => row.includes('31/12/2026'))).toBe(true);
  });

  it('leaves out an invoice whose documents have all been deleted, as the old statement does', async () => {
    process.env.INVOICE_LEDGER_READ = 'on';
    await PDFLink.updateOne({ invoiceNumber: 'INV-1205' }, { $set: { isDeleted: true } });
    await run();

    expect(JSON.parse(statementRender().transactions).some((row) => row.includes('INV-1205'))).toBe(false);
  });

  it('keeps an invoice that has no document at all (a backfilled marker-only one)', async () => {
    process.env.INVOICE_LEDGER_READ = 'on';
    await run();
    expect(JSON.parse(statementRender().transactions).some((row) => row.includes('INV-3'))).toBe(true);
  });

  it('leaves out a job invoice and an invoice with no total, and says so', async () => {
    process.env.INVOICE_LEDGER_READ = 'on';
    await Invoice.create(invoiceRecord('INV-J1', 80, 'item-j', { kind: 'job' }));
    await Invoice.collection.insertOne({ ...invoiceRecord('INV-X9', 1, 'item-x'), total: null, createdAt: new Date(), updatedAt: new Date() });
    await run();

    expect(closingBalance()).toBe('$450.00');
    expect(warn.mock.calls.some((call) => /left out of the statement/i.test(call[1]))).toBe(true);
  });
});

describe('INVOICE_LEDGER_READ=shadow and deleted documents', () => {
  it('compares against the same documents the old statement uses, so a deleted one is not a difference', async () => {
    process.env.INVOICE_LEDGER_READ = 'shadow';
    await PDFLink.updateOne({ invoiceNumber: 'INV-1205' }, { $set: { isDeleted: true } });
    await Invoice.deleteOne({ number: 'INV-3' });
    await Item.deleteOne({ itemId: 'item-3' });
    await run();

    expect(warn.mock.calls.filter((call) => call[1] === 'Shadow difference')).toEqual([]);
  });
});
