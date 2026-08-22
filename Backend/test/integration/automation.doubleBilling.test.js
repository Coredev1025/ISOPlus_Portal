import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
import mongoose from 'mongoose';

import Board from '../../src/models/Board.js';
import Business from '../../src/models/Business.js';
import Item from '../../src/models/Item.js';
import PDFLink from '../../src/models/PDFLink.js';
import { saveInvoiceNumber } from '../../src/utils/invoicePdfSupport.js';
import { up as createPeriodIndex } from '../../migrations/1787186180650-pdflink-invoice-period.js';

/**
 * Steps 5 and 6 of the invoice selection spec's build sequence, which it calls
 * out as the ones that stop a wrong document reaching a participant:
 *
 *   5. Run the same period twice, confirm the second run selects nothing.
 *   6. Manually invoice an item, then run automation, confirm it is not
 *      billed again.
 *
 * Driven through the real `generateInvoicesForBoard`, against a real database,
 * with the real claim, the real PDFLink writes and the real unique index. Only
 * the two leaf boundaries are stubbed — the Invoice Generator list query and
 * the pdfme/S3 render — because neither is what these tests are about and both
 * need network.
 *
 * This is the end-to-end coverage for the feature. There is no Playwright
 * spec because the feature has no UI surface yet: selection and the invoiced
 * marker are entirely backend, and nothing in Frontend/ reads them. When the
 * statement or the marker becomes visible in the portal, that needs its own
 * spec under Frontend/e2e/.
 */

const WS = 'ws-double-bill';
const BOARD = 'board-ndis-1';
const TIMEZONE = 'Australia/Sydney';

// A January slot, so the period covers December. January in Sydney is +11:00.
const SLOT = new Date('2026-01-15T22:00:00Z');
const SCHEDULE = { every: { n: 1, unit: 'month' } };

const listed = { items: [], total: 0 };
let renderedInvoices = 0;

vi.mock('../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual, info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  };
});

vi.mock('../../src/utils/ndisInvoiceGeneratorRouteHelpers.js', () => ({
  getNdisInvoiceGeneratorData: vi.fn(async () => listed),
}));

vi.mock('../../src/services/automation/ndisInvoiceGeneratorPdf.js', () => ({
  generateNdisInvoiceGeneratorPdf: vi.fn(async ({ masterItemIds }) => {
    if (!masterItemIds || masterItemIds.length === 0) return { empty: true };
    renderedInvoices += 1;
    return {
      invoiceNumber: `INV-${1000 + renderedInvoices} (ISO+™)`,
      fileUrl: `https://s3.example/invoice-${renderedInvoices}.pdf`,
      invoiceTotal: 100 * masterItemIds.length,
      itemCount: masterItemIds.length,
      lineCount: masterItemIds.length,
    };
  }),
}));

const { error } = await import('../../src/utils/logger.js');
const { generateInvoicesForBoard } = await import('../../src/services/automation/generateDocuments.js');

const shift = (itemId) => ({
  workspaceId: WS,
  boardId: BOARD,
  folderId: 'f1',
  itemId,
  data: {
    'Participant Full Name': 'Jane Smith',
    'Job Status': 'Completed',
    // Inside the slot's service-delivery window (2025-12-15 → 2026-01-15 UTC).
    // It used to be 2025-12-10, which the mocked list happily returned and the
    // real list never would have; selection reads the stored item, so the
    // fixture has to be the row the period actually contains.
    'Actual Shift Start Date and Time': '2025-12-20T09:00:00.000000+11:00',
  },
});

const listRow = (itemId) => ({ sourceItemId: itemId, participant: 'Jane Smith' });

const runOnce = () => generateInvoicesForBoard({
  workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TIMEZONE, schedule: SCHEDULE,
});

const markerOn = async (itemId) => (await Item.findOne({ itemId }).lean())?.invoicedBy ?? null;

beforeEach(async () => {
  vi.clearAllMocks();
  renderedInvoices = 0;
  listed.items = [listRow('shift-1'), listRow('shift-2')];
  listed.total = 2;

  await createPeriodIndex(mongoose.connection);
  await Business.create({
    workspaceId: WS,
    name: 'Sample Care Services',
    abn: '00 000 000 000',
    headOfficeTimezone: TIMEZONE,
    address: {
      street: '1 St', suburb: 'S', state: 'VIC', postcode: '3000', country: 'AU',
    },
    bankDetails: {
      accountName: 'A', bankName: 'B', bsb: '000-000', accountNumber: '1', accountsReceivableTerms: '14 days',
    },
  });
  await Board.create({
    workspaceId: WS,
    boardId: BOARD,
    name: 'Shift Planning and Reporting',
    label: 'Care Management - NDIS - Certification',
  });
  await Item.insertMany([shift('shift-1'), shift('shift-2')]);
});

describe('step 5 — running the same period twice', () => {
  it('bills the period once and produces no second invoice on a re-run', async () => {
    const first = await runOnce();
    expect(first).toHaveLength(1);
    expect(renderedInvoices).toBe(1);

    const second = await runOnce();

    // No new document was rendered. The re-run returns what the slot already
    // produced, which is what the email is composed from.
    expect(renderedInvoices).toBe(1);
    expect(second).toHaveLength(1);
    expect(second[0].invoiceNumber).toBe(first[0].invoiceNumber);
  });

  it('leaves exactly one document row per item, not two', async () => {
    await runOnce();
    await runOnce();

    const rows = await PDFLink.find({ workspaceId: WS, boardId: BOARD }).lean();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.itemId).sort()).toEqual(['shift-1', 'shift-2']);
  });

  it('records the period and the billed total on each document', async () => {
    await runOnce();
    const row = await PDFLink.findOne({ itemId: 'shift-1' }).lean();
    expect(row.invoiceType).toBe('ndis-certification');
    expect(row.periodStart).toBeInstanceOf(Date);
    expect(row.invoiceTotal).toBe(200);
  });

  it('marks both items with the invoice that billed them', async () => {
    const [first] = await runOnce();
    expect(await markerOn('shift-1')).toBe(first.invoiceNumber);
    expect(await markerOn('shift-2')).toBe(first.invoiceNumber);
  });
});

describe('step 6 — an item invoiced by hand first', () => {
  it('is not billed again by the scheduled run', async () => {
    // The manual path, exactly as the webhook generators call it.
    await saveInvoiceNumber(WS, BOARD, 'shift-1', 'INV-MANUAL-1 (ISO+™)', 'PDF', 'https://s3/manual.pdf');

    await runOnce();

    // The manual claim stands, and the automated invoice covered only the
    // other item.
    expect(await markerOn('shift-1')).toBe('INV-MANUAL-1 (ISO+™)');
    const { generateNdisInvoiceGeneratorPdf } = await import('../../src/services/automation/ndisInvoiceGeneratorPdf.js');
    expect(generateNdisInvoiceGeneratorPdf).toHaveBeenCalledWith(
      expect.objectContaining({ masterItemIds: ['shift-2'] }),
    );
  });

  it('produces no invoice at all when every item was already invoiced by hand', async () => {
    await saveInvoiceNumber(WS, BOARD, 'shift-1', 'INV-MANUAL-1 (ISO+™)', 'PDF', 'https://s3/a.pdf');
    await saveInvoiceNumber(WS, BOARD, 'shift-2', 'INV-MANUAL-2 (ISO+™)', 'PDF', 'https://s3/b.pdf');

    const results = await runOnce();

    // Section 3.5: no document, and nothing for an email to be composed from.
    expect(renderedInvoices).toBe(0);
    expect(results).toEqual([]);
  });
});

describe('a failed render leaves the items billable', () => {
  it('releases the claim so the next run picks them up', async () => {
    const { generateNdisInvoiceGeneratorPdf } = await import('../../src/services/automation/ndisInvoiceGeneratorPdf.js');
    generateNdisInvoiceGeneratorPdf.mockRejectedValueOnce(new Error('pdfme exploded'));

    await expect(runOnce()).rejects.toThrow('pdfme exploded');

    expect(await markerOn('shift-1')).toBe(null);
    expect(await markerOn('shift-2')).toBe(null);

    // And the retry bills them properly.
    const results = await runOnce();
    expect(results).toHaveLength(1);
    expect(await markerOn('shift-1')).toBe(results[0].invoiceNumber);
  });
});

describe('a claim left behind by a run that never finished', () => {
  /**
   * The gap section 3.4 accepts: a process that dies between the claim and the
   * release leaves a `pending:` token on items nothing will ever bill. The
   * items are excluded from this run and from every run after it, so without
   * an alarm the participant is quietly under-billed and the marker is the
   * only evidence.
   */
  it('raises an alarm naming the items it is silently skipping', async () => {
    await Item.updateOne(
      { itemId: 'shift-1' },
      {
        $set: {
          invoicedBy: 'pending:NDIS Invoice:20260115-0900:Jane Smith',
          invoicedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      },
    );

    await runOnce();

    const alarm = error.mock.calls.find(([, message]) => /never completed/i.test(message));
    expect(alarm).toBeTruthy();
    expect(alarm[2]).toMatchObject({ workspaceId: WS, boardId: BOARD, count: 1 });
    expect(alarm[2].itemIds).toEqual(['shift-1']);
  });

  it('still bills the items that are free, rather than failing the whole run', async () => {
    await Item.updateOne(
      { itemId: 'shift-1' },
      {
        $set: {
          invoicedBy: 'pending:NDIS Invoice:20260115-0900:Jane Smith',
          invoicedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      },
    );

    const results = await runOnce();

    expect(results).toHaveLength(1);
    // The held item keeps its stale token — detection does not clear it, since
    // clearing a claim a live run might still hold is the double bill the
    // protocol exists to prevent.
    expect(await markerOn('shift-1')).toMatch(/^pending:/);
    expect(await markerOn('shift-2')).toMatch(/^INV-/);
  });

  it('says nothing on an ordinary run', async () => {
    await runOnce();
    expect(error.mock.calls.filter(([, m]) => /never completed/i.test(m))).toEqual([]);
  });
});

describe('a ledger write that fails after the document exists', () => {
  /**
   * The window Arnold's review named: the items were marked with the REAL
   * invoice number before the PDFLink rows were written, so a failure here left
   * items that carry a finished-looking marker, have no ledger row, are invisible
   * to the stale-claim alarm (which only knows the `pending:` prefix), and can
   * never be re-claimed — the deterministic token no longer matches. Permanent,
   * silent under-billing.
   *
   * The marker must therefore stay provisional until the ledger row exists.
   */
  it('leaves a pending: token rather than a finished-looking marker', async () => {
    const create = vi.spyOn(PDFLink, 'create').mockRejectedValue(new Error('ledger write failed'));

    await expect(runOnce()).rejects.toThrow('ledger write failed');
    create.mockRestore();

    expect(await markerOn('shift-1')).toMatch(/^pending:/);
    expect(await markerOn('shift-2')).toMatch(/^pending:/);
    expect(await PDFLink.countDocuments({ workspaceId: WS })).toBe(0);
  });

  it('is picked up by the stale-claim alarm once the cutoff passes', async () => {
    const create = vi.spyOn(PDFLink, 'create').mockRejectedValue(new Error('ledger write failed'));
    await expect(runOnce()).rejects.toThrow('ledger write failed');
    create.mockRestore();

    // Age the abandoned claim past the cutoff; the next run reports it.
    await Item.updateMany({ workspaceId: WS }, { $set: { invoicedAt: new Date('2020-01-01T00:00:00.000Z') } });
    listed.items = [];
    listed.total = 0;
    await runOnce();

    const alarm = error.mock.calls.find(([, message]) => /never completed/i.test(message));
    expect(alarm).toBeTruthy();
    expect(alarm[2].itemIds.sort()).toEqual(['shift-1', 'shift-2']);
  });

  it('lets the retry reclaim its own items and bill them', async () => {
    const create = vi.spyOn(PDFLink, 'create').mockRejectedValue(new Error('ledger write failed'));
    await expect(runOnce()).rejects.toThrow('ledger write failed');
    create.mockRestore();

    const results = await runOnce();

    expect(results).toHaveLength(1);
    expect(await markerOn('shift-1')).toBe(results[0].invoiceNumber);
    expect(await markerOn('shift-2')).toBe(results[0].invoiceNumber);
    expect(await PDFLink.countDocuments({ workspaceId: WS })).toBe(2);
  });
});

describe('selection decides what of the listed period is billable', () => {
  /**
   * Section 2 of the spec, reaching production. The Invoice Generator list
   * decides what the period contains; the type's date-and-status conditions
   * decide what of it is billable. Before this, the list was the only rule and
   * `selectInvoiceableItems` was library code nothing called.
   */
  it('leaves off a listed item whose status does not qualify', async () => {
    await Item.updateOne({ itemId: 'shift-2' }, { $set: { 'data.Job Status': 'In Progress' } });

    await runOnce();

    const { generateNdisInvoiceGeneratorPdf } = await import('../../src/services/automation/ndisInvoiceGeneratorPdf.js');
    expect(generateNdisInvoiceGeneratorPdf).toHaveBeenCalledWith(
      expect.objectContaining({ masterItemIds: ['shift-1'] }),
    );
    // Unbilled and unclaimed, so it is picked up when its status moves on.
    expect(await markerOn('shift-2')).toBe(null);
  });

  it('leaves off a listed item dated outside the period', async () => {
    await Item.updateOne(
      { itemId: 'shift-2' },
      { $set: { 'data.Actual Shift Start Date and Time': '2025-10-10T09:00:00.000000+11:00' } },
    );

    await runOnce();

    const { generateNdisInvoiceGeneratorPdf } = await import('../../src/services/automation/ndisInvoiceGeneratorPdf.js');
    expect(generateNdisInvoiceGeneratorPdf).toHaveBeenCalledWith(
      expect.objectContaining({ masterItemIds: ['shift-1'] }),
    );
  });

  it('produces no invoice at all when nothing in the period qualifies', async () => {
    await Item.updateMany({ workspaceId: WS }, { $set: { 'data.Job Status': 'In Progress' } });

    const results = await runOnce();

    expect(renderedInvoices).toBe(0);
    expect(results).toEqual([]);
  });

  it('counts what it removed, because the risk it carries is under-billing', async () => {
    await Item.updateOne({ itemId: 'shift-2' }, { $set: { 'data.Job Status': 'In Progress' } });

    await runOnce();

    const { warn } = await import('../../src/utils/logger.js');
    const line = warn.mock.calls.find(([, message]) => /selection removed/i.test(message));
    expect(line[2]).toMatchObject({
      boardId: BOARD, invoiceType: 'ndis-certification', listed: 2, selected: 1, dropped: 1,
    });
  });
});
