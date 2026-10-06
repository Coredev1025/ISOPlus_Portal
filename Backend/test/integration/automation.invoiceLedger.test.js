import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';

import Board from '../../src/models/Board.js';
import Business from '../../src/models/Business.js';
import Invoice from '../../src/models/Invoice.js';
import Item from '../../src/models/Item.js';
import PDFLink from '../../src/models/PDFLink.js';
import { up as buildInvoiceIndexes } from '../../migrations/1791102300000-invoice-ledger-indexes.js';
import { up as buildPeriodIndex } from '../../migrations/1787186180650-pdflink-invoice-period.js';
import { invalidateCacheForWorkspace } from '../../src/utils/transformCache.js';
import { auditInvoices } from '../../src/utils/invoiceLedger/audit.js';
import { repairInvoice } from '../../src/utils/invoiceLedger/issue.js';
import * as markerModule from '../../src/utils/invoicedMarker.js';

vi.mock('../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

const { generateInvoicesForBoard } = await import('../../src/services/automation/generateDocuments.js');

/**
 * KAN-305. Scheduled invoice runs write the new invoice record when
 * INVOICE_LEDGER_WRITE is on, and write nothing new when it is off. Real generators,
 * offline mode, on the committed Care Management fixture (workspace 55390). The older
 * writes (marker, log, ledger) are pinned by test/characterization; this adds the
 * invoice record and its agreement with them.
 */

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/care-management-automation.json', import.meta.url), 'utf8',
));
const WS = fixture.business.workspaceId;
const SAH = 'jpjztrn14pJ';
const NDIS_LEGACY = 'o24sGM1FoST';
const NDIS_2026 = 'dwV23F5WcQL';
const JANE_PROFILE = '55390000-aaaa-4001-8001-000000000001';
const TZ = 'Australia/Sydney';
const SLOT = new Date('2025-01-31T22:00:00Z');
const PERIOD_KEY = '20250201-0900';
const MONTHLY = { every: { n: 1, unit: 'month' } };

const saved = {};
let root;
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('$')));
const run = (boardId = SAH) => generateInvoicesForBoard({
  workspaceId: WS, boardId, slot: SLOT, timezone: TZ, periodKey: PERIOD_KEY, schedule: MONTHLY,
});
const invoicesOn = (boardId) => Invoice.find({ workspaceId: WS, boardId }).sort({ number: 1 }).lean();
const sumOfLines = (invoice) => Math.round(invoice.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;

beforeEach(async () => {
  saved.offline = process.env.ISOPLUS_OFFLINE;
  saved.root = process.env.LOCAL_FILE_ROOT;
  saved.write = process.env.INVOICE_LEDGER_WRITE;
  process.env.ISOPLUS_OFFLINE = '1';
  process.env.INVOICE_LEDGER_WRITE = 'on';
  root = mkdtempSync(join(tmpdir(), 'ledger-run-'));
  process.env.LOCAL_FILE_ROOT = root;
  vi.clearAllMocks();
  invalidateCacheForWorkspace(WS);

  await buildInvoiceIndexes(mongoose.connection);
  await buildPeriodIndex(mongoose.connection);
  const { defaultLogo, featureToggles, ...business } = clean(fixture.business);
  await Business.create(business);
  for (const board of fixture.boards) await Board.create(clean(board));
  await Item.insertMany(fixture.items.map((i) => ({ ...clean(i), workspaceId: WS })));
});

afterEach(() => {
  vi.restoreAllMocks();
  const restore = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  restore('ISOPLUS_OFFLINE', saved.offline);
  restore('LOCAL_FILE_ROOT', saved.root);
  restore('INVOICE_LEDGER_WRITE', saved.write);
  rmSync(root, { recursive: true, force: true });
});

describe('an Age Care run with the write flag on', () => {
  it('commits one invoice per participant profile, carrying what the run knew', async () => {
    await run();

    const invoices = await invoicesOn(SAH);
    expect(invoices.map((i) => [i.number, i.participant.name, i.total])).toEqual([
      ['INV-1004', 'Jane Smith', 279.85], ['INV-1005', 'David Brown', 3.75],
    ]);
    const jane = invoices[0];
    expect(jane).toMatchObject({
      kind: 'age_care', source: 'portal', status: 'issued', origin: 'live', trigger: 'automation',
      periodKey: PERIOD_KEY, boardId: SAH, participant: { profileId: JANE_PROFILE, name: 'Jane Smith' },
    });
    expect(jane.lowCat).toBe(false);
    expect(jane.pdf.pdfLink).toBeTruthy();
  });

  it('dates the invoice and sets its due date from the slot, as the ledger rows are', async () => {
    await run();

    const [invoice] = await invoicesOn(SAH);
    const row = await PDFLink.findOne({ invoiceId: invoice._id }).lean();
    expect(invoice.issuedAt).toEqual(row.invoiceDate);
    expect(invoice.dueDate).toBeInstanceOf(Date);
    expect(invoice.dueDate.getTime()).toBeGreaterThan(invoice.issuedAt.getTime());
    expect(invoice.periodStart).toEqual(row.periodStart);
    expect(invoice.periodEnd).toEqual(row.periodEnd);
  });

  it('lists each billed item with the amount it contributed, and the amounts add up to the total', async () => {
    await run();

    const invoices = await invoicesOn(SAH);
    expect(invoices).toHaveLength(2);
    for (const invoice of invoices) {
      expect(invoice.lines.length).toBeGreaterThan(0);
      expect(sumOfLines(invoice)).toBeCloseTo(invoice.total, 2);
    }
  });

  it('links the older writes to the invoice and points the items at it', async () => {
    await run();

    const invoices = await invoicesOn(SAH);
    expect(invoices).toHaveLength(2);
    for (const invoice of invoices) {
      const ids = invoice.lines.map((l) => l.itemId);
      const rows = await PDFLink.find({ workspaceId: WS, itemId: { $in: ids }, invoiceNumber: invoice.number }).lean();
      expect(rows).toHaveLength(ids.length);
      rows.forEach((row) => expect(String(row.invoiceId)).toBe(String(invoice._id)));
      const items = await Item.find({ itemId: { $in: ids } }).lean();
      items.forEach((item) => {
        expect(item.invoicedBy).toBe(invoice.number);
        expect(String(item.activeInvoiceId)).toBe(String(invoice._id));
      });
    }
  });

  it('leaves every invariant intact', async () => {
    await run();
    expect(await Invoice.countDocuments({ workspaceId: WS })).toBe(2);
    const { violations } = await auditInvoices(WS);
    Object.entries(violations).forEach(([name, list]) => expect(list, name).toEqual([]));
  });

  it('writes nothing new when the same period runs again', async () => {
    await run();
    const before = await Invoice.find({ workspaceId: WS }).lean();
    expect(before).toHaveLength(2);

    await run();

    expect(await Invoice.countDocuments({ workspaceId: WS })).toBe(2);
  });

  it('records a Low Cat board as Low Cat, with the full service amount as the total', async () => {
    await Board.updateOne({ boardId: SAH }, { $set: { label: 'Care Management - SaH - Low Cat' } });

    await run();

    const invoices = await invoicesOn(SAH);
    expect(invoices.map((i) => [i.total, i.lowCat])).toEqual([[5559.5, true], [75, true]]);
    invoices.forEach((invoice) => expect(sumOfLines(invoice)).toBeCloseTo(invoice.total, 2));
  });
});

describe('NDIS runs with the write flag on', () => {
  it('commits the legacy-pricing board\'s invoices with line amounts that add up', async () => {
    await run(NDIS_LEGACY);

    const invoices = await invoicesOn(NDIS_LEGACY);
    expect(invoices.map((i) => [i.number, i.participant.name, i.total, i.kind])).toEqual([
      ['INV-1004', 'David Smith', 577.5, 'ndis'], ['INV-1005', 'Martin Space', 240, 'ndis'],
    ]);
    invoices.forEach((invoice) => expect(sumOfLines(invoice)).toBeCloseTo(invoice.total, 2));
    expect(invoices[0].lowCat).toBeUndefined();
  });

  it('commits the 2026-pricing board\'s invoice the same way', async () => {
    await run(NDIS_2026);

    const invoices = await invoicesOn(NDIS_2026);
    expect(invoices.map((i) => [i.number, i.participant.name, i.total])).toEqual([['INV-1004', 'Mike Bird', 395]]);
    expect(sumOfLines(invoices[0])).toBe(395);
    const { violations } = await auditInvoices(WS);
    Object.entries(violations).forEach(([name, list]) => expect(list, name).toEqual([]));
  });
});

describe('failures after the invoice record exists or before it is written', () => {
  it('a failed marker rewrite leaves the invoice issued and the claim pending, and repair finishes it', async () => {
    vi.spyOn(markerModule, 'markItemsInvoiced').mockRejectedValueOnce(new Error('marker rewrite failed'));

    await expect(run()).rejects.toThrow(/marker rewrite failed/);

    const invoices = await Invoice.find({ workspaceId: WS, boardId: SAH }).lean();
    expect(invoices.length).toBeGreaterThan(0);
    const broken = await auditInvoices(WS);
    expect(broken.reported.needsRepair.length).toBeGreaterThan(0);

    for (const invoice of invoices) await repairInvoice(invoice._id);

    const { violations, reported } = await auditInvoices(WS);
    Object.entries(violations).forEach(([name, list]) => expect(list, name).toEqual([]));
    expect(reported.needsRepair).toEqual([]);
  });

  it('a failed invoice write keeps the claim pending, writes no invoice, and leaves the older rows unlinked', async () => {
    vi.spyOn(Invoice, 'findOneAndUpdate').mockReturnValue({
      lean: async () => { throw new Error('invoice write failed'); },
    });

    await expect(run()).rejects.toThrow(/invoice write failed/);

    expect(await Invoice.countDocuments({})).toBe(0);
    const items = await Item.find({ workspaceId: WS, boardId: SAH, invoicedBy: { $ne: null } }).lean();
    expect(items.length).toBeGreaterThan(0);
    items.forEach((item) => expect(item.invoicedBy).toMatch(/^pending:/));
    const rows = await PDFLink.find({ workspaceId: WS }).lean();
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((row) => expect(row.invoiceId).toBeUndefined());
  });
});

describe('with the write flag off', () => {
  it('writes no invoice record and no pointer, and the ledger rows carry no invoice id', async () => {
    delete process.env.INVOICE_LEDGER_WRITE;

    await run();
    await run(NDIS_LEGACY);

    expect(await Invoice.countDocuments({})).toBe(0);
    expect(await Item.countDocuments({ activeInvoiceId: { $ne: null } })).toBe(0);
    const rows = await PDFLink.find({ workspaceId: WS }).lean();
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((row) => expect(row.invoiceId).toBeUndefined());
  });
});
