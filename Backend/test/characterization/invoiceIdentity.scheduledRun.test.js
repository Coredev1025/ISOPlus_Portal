import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import mongoose from 'mongoose';

import Board from '../../src/models/Board.js';
import Business from '../../src/models/Business.js';
import Item from '../../src/models/Item.js';
import PDFLink from '../../src/models/PDFLink.js';
import InvoiceNumber from '../../src/models/InvoiceNumber.js';
import { up as createPeriodIndex } from '../../migrations/1787186180650-pdflink-invoice-period.js';

/**
 * KAN-303. What a scheduled NDIS run leaves behind in the three places that
 * record an invoice (marker, log, ledger), for the happy path and for failures
 * between the steps, TODAY. Recorded ahead of KAN-302; see
 * docs/superpowers/specs/2026-10-04-invoice-source-of-truth-design.md section 2.3.
 *
 *   marker = Item.invoicedBy     log = InvoiceNumber     ledger = PDFLink
 *
 * test/integration/automation.doubleBilling.test.js pins the replay, the failed
 * render, the stale claim and the ledger failure. This file adds what it does
 * not: the state of all three stores after each outcome, with a generator that
 * writes the log the way the real one does (saveInvoiceNumber per item), and the
 * windows after the log is written. Where a test records a state that is a bug or a
 * gap the design removes, its name starts with KNOWN GAP.
 */

const WS = 'ws-char-run';
const BOARD = 'board-char-ndis';
const TIMEZONE = 'Australia/Sydney';
const SLOT = new Date('2026-01-15T22:00:00Z');
const SCHEDULE = { every: { n: 1, unit: 'month' } };

const listed = { items: [], total: 0 };
let rendered = 0;
let failMarkOnce = false;

vi.mock('../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

// The real list derives each row's status from the log (a PDF row means invoiced) and
// the scheduled run asks for status 'pending', so a row the log already holds is not
// listed. The stand-in does the same, or a retry would see rows production never shows it.
vi.mock('../../src/utils/ndisInvoiceGeneratorRouteHelpers.js', async () => {
  const { default: InvoiceNumberModel } = await import('../../src/models/InvoiceNumber.js');
  return {
    getNdisInvoiceGeneratorData: vi.fn(async ({ workspaceId, boardId, query }) => {
      if (query?.status !== 'pending') return listed;
      const held = new Set((await InvoiceNumberModel.find({
        workspaceId, boardId, type: 'PDF', itemId: { $in: listed.items.map((r) => r.sourceItemId) },
      }).lean()).map((r) => r.itemId));
      const items = listed.items.filter((r) => !held.has(r.sourceItemId));
      return { items, total: items.length };
    }),
  };
});

vi.mock('../../src/utils/invoicedMarker.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    markItemsInvoiced: vi.fn(async (...args) => {
      if (failMarkOnce) {
        failMarkOnce = false;
        throw new Error('marker rewrite failed');
      }
      return actual.markItemsInvoiced(...args);
    }),
  };
});

// The real generator records the log row per item through saveInvoiceNumber
// after it has rendered; this stand-in does the same so the log is in play.
vi.mock('../../src/services/automation/ndisInvoiceGeneratorPdf.js', async () => {
  const { saveInvoiceNumber } = await import('../../src/utils/invoicePdfSupport.js');
  return {
    generateNdisInvoiceGeneratorPdf: vi.fn(async ({ workspaceId, boardId, masterItemIds }) => {
      if (!masterItemIds || masterItemIds.length === 0) return { empty: true };
      rendered += 1;
      const invoiceNumber = `INV-${2000 + rendered}`;
      const fileUrl = `https://s3.example/char-${rendered}.pdf`;
      await Promise.all(masterItemIds.map((id) => saveInvoiceNumber(
        workspaceId, boardId, id, invoiceNumber, 'PDF', fileUrl,
      )));
      return {
        invoiceNumber, fileUrl, invoiceTotal: 100 * masterItemIds.length,
        itemCount: masterItemIds.length, lineCount: masterItemIds.length,
      };
    }),
  };
});

const { generateInvoicesForBoard } = await import('../../src/services/automation/generateDocuments.js');

const shift = (itemId) => ({
  workspaceId: WS,
  boardId: BOARD,
  folderId: 'f1',
  itemId,
  data: {
    'Participant Full Name': 'Jane Smith',
    'Participant Profile': [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }],
    'Job Status': 'Completed',
    'Actual Shift Start Date and Time': '2025-12-20T09:00:00.000000+11:00',
  },
});

const runOnce = () => generateInvoicesForBoard({
  workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TIMEZONE, schedule: SCHEDULE,
});

/** What the three stores hold, keyed by item. */
const state = async () => {
  const items = await Item.find({ workspaceId: WS }).sort({ itemId: 1 }).lean();
  const log = await InvoiceNumber.find({ workspaceId: WS, type: 'PDF' }).sort({ itemId: 1 }).lean();
  const ledger = await PDFLink.find({ workspaceId: WS }).sort({ itemId: 1 }).lean();
  return {
    marker: Object.fromEntries(items.map((i) => [i.itemId, i.invoicedBy ?? null])),
    log: Object.fromEntries(log.map((r) => [r.itemId, r.invoiceNumber])),
    ledger: Object.fromEntries(ledger.map((r) => [r.itemId, r.invoiceNumber ?? null])),
  };
};

const savedWriteFlag = process.env.INVOICE_LEDGER_WRITE;

beforeEach(async () => {
  // These pin the flag-off behaviour whatever Backend/.env says.
  delete process.env.INVOICE_LEDGER_WRITE;
  vi.clearAllMocks();
  rendered = 0;
  failMarkOnce = false;
  listed.items = [
    { sourceItemId: 'shift-1', participant: 'Jane Smith' },
    { sourceItemId: 'shift-2', participant: 'Jane Smith' },
  ];
  listed.total = 2;

  await createPeriodIndex(mongoose.connection);
  await Business.create({
    workspaceId: WS,
    name: 'Sample Care Services',
    abn: '00 000 000 000',
    headOfficeTimezone: TIMEZONE,
    address: { street: '1 St', suburb: 'S', state: 'VIC', postcode: '3000', country: 'AU' },
    bankDetails: {
      accountName: 'A', bankName: 'B', bsb: '000-000', accountNumber: '1', accountsReceivableTerms: '14 days',
    },
  });
  await Board.create({
    workspaceId: WS, boardId: BOARD, name: 'Shift Planning and Reporting',
    label: 'Care Management - NDIS - Certification',
  });
  await Item.insertMany([shift('shift-1'), shift('shift-2')]);
});

afterEach(() => {
  if (savedWriteFlag === undefined) delete process.env.INVOICE_LEDGER_WRITE; else process.env.INVOICE_LEDGER_WRITE = savedWriteFlag;
  vi.restoreAllMocks();
});

describe('the happy path leaves the same number in all three places', () => {
  it('marker, log and ledger all carry the invoice number for each item', async () => {
    const [invoice] = await runOnce();

    expect(await state()).toEqual({
      marker: { 'shift-1': invoice.invoiceNumber, 'shift-2': invoice.invoiceNumber },
      log: { 'shift-1': invoice.invoiceNumber, 'shift-2': invoice.invoiceNumber },
      ledger: { 'shift-1': invoice.invoiceNumber, 'shift-2': invoice.invoiceNumber },
    });
  });

  it('leaves the marker provisional at the moment the ledger is written', async () => {
    // Real: generateUnderClaim keeps the pending: token until the ledger rows exist.
    // The log rows are there first only because the stand-in generator writes them
    // before it returns, as the real generator does (ndisInvoiceGeneratorPdf.js).
    const seen = {};
    const real = PDFLink.create.bind(PDFLink);
    const spy = vi.spyOn(PDFLink, 'create').mockImplementation(async (doc, ...rest) => {
      seen.markerWhenLedgerWritten ??= (await Item.findOne({ itemId: doc.itemId }).lean()).invoicedBy;
      seen.logRowsWhenLedgerWritten ??= await InvoiceNumber.countDocuments({ workspaceId: WS, type: 'PDF' });
      return real(doc, ...rest);
    });
    await runOnce();
    spy.mockRestore();

    expect(seen.markerWhenLedgerWritten).toMatch(/^pending:/);
    expect(seen.logRowsWhenLedgerWritten).toBe(2);
  });
});

describe('KNOWN GAP: the marker rewrite fails after the log and the ledger were written', () => {
  it('leaves a pending: token while log and ledger both name the invoice', async () => {
    failMarkOnce = true;
    await expect(runOnce()).rejects.toThrow('marker rewrite failed');

    const after = await state();
    expect(after.marker['shift-1']).toMatch(/^pending:/);
    expect(after.marker['shift-2']).toMatch(/^pending:/);
    expect(after.log['shift-1']).toBe('INV-2001');
    expect(after.ledger['shift-1']).toBe('INV-2001');
  });

  it('then never bills those items again: the retry lists nothing, because the log already holds them', async () => {
    failMarkOnce = true;
    await expect(runOnce()).rejects.toThrow('marker rewrite failed');

    // The list drops rows whose log row exists, so the retry finds no group and returns
    // what the slot already produced. No second invoice is rendered, and the items keep
    // their pending: token for good. Only the hourly stale-claim alarm reports them, and
    // nothing ever finishes the rewrite.
    const retry = await runOnce();

    expect(rendered).toBe(1);
    expect(retry.map((r) => r.invoiceNumber)).toEqual(['INV-2001']);
    const after = await state();
    expect(after.marker['shift-1']).toMatch(/^pending:/);
    expect(after.log['shift-1']).toBe('INV-2001');
  });
});

describe('KNOWN GAP: only some of the ledger rows are written', () => {
  it('leaves the claim pending, the log complete and the ledger partial', async () => {
    const real = PDFLink.create.bind(PDFLink);
    let calls = 0;
    let firstWritten;
    const spy = vi.spyOn(PDFLink, 'create').mockImplementation(async (doc, ...rest) => {
      calls += 1;
      if (calls === 1) {
        firstWritten = real(doc, ...rest);
        return firstWritten;
      }
      // Let the first write finish before the second fails, so the count is not a race.
      await firstWritten;
      throw new Error('second ledger write failed');
    });
    await expect(runOnce()).rejects.toThrow('second ledger write failed');
    spy.mockRestore();

    const after = await state();
    expect(Object.keys(after.ledger)).toHaveLength(1);
    expect(Object.keys(after.log)).toHaveLength(2);
    expect(Object.values(after.marker).every((m) => /^pending:/.test(m))).toBe(true);
  });
});

describe('KNOWN GAP: the log write fails and the run carries on', () => {
  it('completes with the marker and the ledger set and nothing in the log, so the list shows the items as billable and the pdf-link lookup cannot find the invoice', async () => {
    const spy = vi.spyOn(InvoiceNumber, 'findOneAndUpdate').mockRejectedValue(new Error('log write failed'));
    const [invoice] = await runOnce();
    spy.mockRestore();

    const after = await state();
    expect(after.marker).toEqual({ 'shift-1': invoice.invoiceNumber, 'shift-2': invoice.invoiceNumber });
    expect(after.ledger).toEqual({ 'shift-1': invoice.invoiceNumber, 'shift-2': invoice.invoiceNumber });
    expect(after.log).toEqual({});
  });
});
