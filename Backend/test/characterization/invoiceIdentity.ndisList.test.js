import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getNdisInvoiceGeneratorData } from '../../src/utils/ndisInvoiceGeneratorRouteHelpers.js';
import { bulkFetchReferenceItemsFromDB } from '../../src/utils/ndisInvoiceGeneratorInvoicing.js';
import { isUuidLike } from '../../src/utils/ndisServiceRecords.js';
import Item from '../../src/models/Item.js';
import Business from '../../src/models/Business.js';
import InvoiceNumber from '../../src/models/InvoiceNumber.js';

/**
 * KAN-303. What the NDIS Invoice Generator list shows as "invoiced", and which
 * invoice number and PDF link it shows, TODAY. The list reads the InvoiceNumber
 * log (type PDF) and ignores the item marker (invoicedBy). Recorded ahead of
 * KAN-302; see docs/superpowers/specs/2026-10-04-invoice-source-of-truth-design.md.
 *
 * Design cases pinned: b, c, d, e, g, h, i, l, and the scheduled run's use of
 * the list's own `pending` status as a first guard against billing twice.
 *
 * Harness copied from test/unit/utils/ndisInvoiceGeneratorRouteHelpers.test.js.
 */

const WORKSPACE = '55369';
const BOARD = 'eNiJpH14PN3';
const CATALOGUE_BOARD = 'zzCatalogue';
const SP_ID = '11111111-1111-4111-8111-111111111111';
const PP_ID = '22222222-1111-4111-8111-222222222222';
const SUPPORT_CAT_ID = '66666666-1111-4111-8111-666666666666';

const createItem = (itemId, data, overrides = {}) => Item.create({
  workspaceId: WORKSPACE, boardId: BOARD, folderId: 'folder-master', itemId, data, ...overrides,
});

async function seedPlanAndParticipant() {
  await createItem(SUPPORT_CAT_ID, {
    'Support Item Number': '01_011_0107_1_1',
    'Support Item Name': 'Assistance With Self-Care Activities',
  }, { boardId: CATALOGUE_BOARD, folderId: 'folder-cat' });
  await createItem(SP_ID, {
    'Direct Support Item Number': [{ id: SUPPORT_CAT_ID, name: 'Assistance' }],
    'Unit (Direct Support)': 'Hour(H)',
    'Agreed Unit Price for Direct Support ($)': '70.00',
  }, { boardId: CATALOGUE_BOARD, folderId: 'folder-cat' });
  await createItem(PP_ID, {
    'Full Name/Preferred Name': 'Samuel Rivers', 'NDIS Number': '430123456',
  }, { boardId: CATALOGUE_BOARD, folderId: 'folder-cat' });
}

const shift = (itemId, itemOverrides = {}) => createItem(itemId, {
  'Timesheet Approval': 'Approved',
  'Job Status': 'Completed',
  'Payment Status': 'Unpaid',
  'Service Plan': [{ id: SP_ID }],
  'Participant Profile': [{ id: PP_ID }],
  'Scheduled Shift Start Date & Time': '2026-01-14T21:00:00.000Z',
  'Actual Shift Start Date and Time': '2026-01-14T22:00:00.000Z',
  'Actual Shift End Date and Time': '2026-01-15T00:30:00.000Z',
  'Actual Shift Duration(Hr.)': '2.5',
  'Direct Support Value($) - Time Based Support': '175.00',
}, itemOverrides);

const logRow = (itemId, invoiceNumber, extra = {}) => InvoiceNumber.create({
  itemId, workspaceId: WORKSPACE, boardId: BOARD, invoiceNumber, type: 'PDF', ...extra,
});

const deps = () => ({
  Item, Business, InvoiceNumber,
  getFolderIds: vi.fn().mockResolvedValue([]),
  bulkFetchReferenceItemsFromDB, isUuidLike, warn: vi.fn(),
});

const list = (query = {}) => getNdisInvoiceGeneratorData(
  { workspaceId: WORKSPACE, boardId: BOARD, query, req: null }, deps(),
);
const rowOf = (result, itemId) => result.items.find((r) => r.sourceItemId === itemId);

beforeEach(seedPlanAndParticipant);

describe('the list takes "invoiced", the number and the link from the log alone', () => {
  it('shows a marker-only item as pending: the marker is ignored (case d)', async () => {
    await shift('mp-1', { invoicedBy: 'INV-3 (ISO+™)' });

    const row = rowOf(await list(), 'mp-1');
    expect(row.status).toBe('pending');
    expect(row.invoiceNumber).toBeFalsy();
  });

  it('shows an item with a pending: claim and no log row as pending (case l)', async () => {
    await shift('mp-1', { invoicedBy: 'pending:ndis:20260101-0900:Samuel Rivers' });

    expect(rowOf(await list(), 'mp-1').status).toBe('pending');
  });

  it('shows an item whose only record is a Xero marker and a Xero log row as pending (case c)', async () => {
    await shift('mp-1', { invoicedBy: 'INV-0001 (Xero)' });
    await InvoiceNumber.create({
      itemId: 'mp-1', workspaceId: WORKSPACE, boardId: BOARD, invoiceNumber: 'INV-0001 (Xero)', type: 'Xero',
    });

    expect(rowOf(await list(), 'mp-1').status).toBe('pending');
  });

  it('shows a log-only item as invoiced with its number and link, with no marker at all (case e)', async () => {
    await shift('mp-1');
    await logRow('mp-1', 'INV-22', { pdfLink: 'https://s3/inv-22.pdf' });

    const row = rowOf(await list(), 'mp-1');
    expect(row.status).toBe('invoiced');
    expect(row.invoiceNumber).toBe('INV-22');
    expect(row.fileUrl).toBe('https://s3/inv-22.pdf');
  });

  it('shows the log\'s number when the marker names a different one (cases g and i)', async () => {
    await shift('mp-1', { invoicedBy: 'INV-1' });
    await logRow('mp-1', 'INV-2', { pdfLink: 'https://s3/inv-2.pdf' });

    expect(rowOf(await list(), 'mp-1').invoiceNumber).toBe('INV-2');
  });

  it('shows a number as stored, suffix included (case b)', async () => {
    await shift('mp-1');
    await logRow('mp-1', 'INV-24 (ISO+™)', { pdfLink: 'https://s3/inv-24.pdf' });

    expect(rowOf(await list(), 'mp-1').invoiceNumber).toBe('INV-24 (ISO+™)');
  });

  it('shows invoiced with no file link when the log row has none (case h)', async () => {
    await shift('mp-1');
    await logRow('mp-1', 'INV-5');

    const row = rowOf(await list(), 'mp-1');
    expect(row.status).toBe('invoiced');
    expect(row.fileUrl ?? null).toBeNull();
  });

  it('counts invoiced and pending rows from the log', async () => {
    await shift('mp-1');
    await shift('mp-2', { invoicedBy: 'INV-9' });
    await logRow('mp-1', 'INV-1', { pdfLink: 'https://s3/1.pdf' });

    const result = await list();
    expect(result.invoiced).toBe(1);
    expect(result.pending).toBe(1);
  });
});

describe('the scheduled run asks for status pending, so the log is its first guard against billing twice', () => {
  it('leaves out an item that has a PDF log row, whatever its marker says', async () => {
    await shift('mp-1');
    await shift('mp-2', { invoicedBy: 'INV-1' });
    await logRow('mp-1', 'INV-1', { pdfLink: 'https://s3/1.pdf' });
    await logRow('mp-2', 'INV-1', { pdfLink: 'https://s3/1.pdf' });

    const result = await list({ status: 'pending' });
    expect(result.items.map((r) => r.sourceItemId)).toEqual([]);
  });

  it('keeps an item that is marked but has no log row, so only the marker guard then stops it (case d)', async () => {
    await shift('mp-1', { invoicedBy: 'INV-3' });

    const result = await list({ status: 'pending' });
    expect(result.items.map((r) => r.sourceItemId)).toEqual(['mp-1']);
  });

  it('keeps an item whose only log row is Xero: neither list guard covers it, and a missing marker leaves it open (case c)', async () => {
    await shift('mp-1');
    await InvoiceNumber.create({
      itemId: 'mp-1', workspaceId: WORKSPACE, boardId: BOARD, invoiceNumber: 'INV-0001 (Xero)', type: 'Xero',
    });

    const result = await list({ status: 'pending' });
    expect(result.items.map((r) => r.sourceItemId)).toEqual(['mp-1']);
  });
});
