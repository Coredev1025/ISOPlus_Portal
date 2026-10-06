import { describe, it, expect, beforeEach } from 'vitest';

import Board from '../../src/models/Board.js';
import Invoice from '../../src/models/Invoice.js';
import InvoiceNumber from '../../src/models/InvoiceNumber.js';
import Item from '../../src/models/Item.js';
import PDFLink from '../../src/models/PDFLink.js';

const { loadBackfillInputs, workspacesWithInvoices } = await import('../../src/utils/invoiceLedger/backfill/loader.js');

/**
 * KAN-311: the loader reads the three old stores (and what the invoice collection already
 * holds) for one workspace, in the shape the planner takes. Nothing else is read: of the
 * half-million items a production workspace holds, only the ones an invoice mentions.
 */

const WS = 'ws-load';
const OTHER = 'ws-other';

const item = (itemId, over = {}) => ({
  workspaceId: WS, boardId: 'b1', folderId: 'f', itemId, data: { 'Participant Full Name': 'Jane Smith' }, ...over,
});

beforeEach(async () => {
  await Promise.all([Board, Invoice, InvoiceNumber, Item, PDFLink].map((m) => m.deleteMany({})));
  await Board.create({ boardId: 'b1', workspaceId: WS, name: 'NDIS', label: 'Care Management NDIS 2026 Pricing' });
  await Item.insertMany([
    item('marked', { invoicedBy: 'INV-3', invoicedAt: new Date('2026-08-01T00:00:00Z') }),
    item('logged'),
    item('ledgered'),
    item('unrelated'),
    item('other-ws', { workspaceId: OTHER }),
  ]);
  await InvoiceNumber.create({ workspaceId: WS, boardId: 'b1', itemId: 'logged', invoiceNumber: 'INV-24 (ISO+™)', type: 'PDF', pdfLink: 'https://s3/24.pdf' });
  await InvoiceNumber.create({ workspaceId: OTHER, boardId: 'b1', itemId: 'other-ws', invoiceNumber: 'INV-1', type: 'PDF' });
  await PDFLink.create({
    workspaceId: WS, boardId: 'b1', itemId: 'ledgered', type: 'NDIS Invoice', invoiceNumber: 'INV-5', invoiceTotal: 300, participant: 'Jane Smith', pdfLink: 'https://s3/5.pdf',
  });
  await PDFLink.create({ workspaceId: WS, boardId: 'b1', itemId: 'q1', type: 'Quote', pdfLink: 'https://s3/q.pdf' });
});

describe('loadBackfillInputs', () => {
  it('reads the log rows, the invoice-type ledger rows and the boards of the workspace only', async () => {
    const inputs = await loadBackfillInputs(WS);

    expect(inputs.workspaceId).toBe(WS);
    expect(inputs.boards).toEqual({ b1: { label: 'Care Management NDIS 2026 Pricing' } });
    expect(inputs.logRows.map((r) => [r.itemId, r.invoiceNumber, r.type])).toEqual([['logged', 'INV-24 (ISO+™)', 'PDF']]);
    expect(inputs.ledgerRows.map((r) => [r.itemId, r.invoiceNumber, r.invoiceTotal])).toEqual([['ledgered', 'INV-5', 300]]);
    expect(inputs.ledgerRows[0].id).toBeTruthy();
  });

  it('reads only the items an invoice mentions, with the participant name from their data', async () => {
    const inputs = await loadBackfillInputs(WS);

    expect(inputs.items.map((i) => i.itemId).sort()).toEqual(['ledgered', 'logged', 'marked']);
    const marked = inputs.items.find((i) => i.itemId === 'marked');
    expect(marked).toMatchObject({ boardId: 'b1', invoicedBy: 'INV-3', participantName: 'Jane Smith' });
    expect(marked.invoicedAt).toEqual(new Date('2026-08-01T00:00:00Z'));
  });

  it('takes the participant name from the profile the item references when the item carries none', async () => {
    await Item.insertMany([
      item('noname', { data: { 'Participant Full Name': '', 'Participant Profile': [{ id: 'prof-1' }] } }),
      item('noname-ids', { data: { 'Participant Profile': ['prof-1'] } }),
      item('prof-1', { data: { 'Full Name/Preferred Name': 'Pat Profile' } }),
    ]);
    await InvoiceNumber.create({ workspaceId: WS, boardId: 'b1', itemId: 'noname', invoiceNumber: 'INV-30', type: 'PDF' });
    await InvoiceNumber.create({ workspaceId: WS, boardId: 'b1', itemId: 'noname-ids', invoiceNumber: 'INV-31', type: 'PDF' });
    const inputs = await loadBackfillInputs(WS);

    expect(inputs.items.find((i) => i.itemId === 'noname').participantName).toBe('Pat Profile');
    expect(inputs.items.find((i) => i.itemId === 'noname-ids').participantName).toBe('Pat Profile');
    expect(inputs.items.find((i) => i.itemId === 'marked').participantName).toBe('Jane Smith');
  });

  it('reads the invoices that already exist, with their items, participant and Xero number', async () => {
    await Invoice.create({
      workspaceId: WS, boardId: 'b1', number: 'INV-7', kind: 'ndis', participant: { name: 'Jane Smith' },
      lines: [{ itemId: 'logged', amount: 5 }], total: 5, issuedAt: new Date('2026-07-01T00:00:00Z'), xero: { invoiceNumber: 'INV-0900' },
    });
    const inputs = await loadBackfillInputs(WS);

    expect(inputs.existing).toEqual([expect.objectContaining({
      source: 'portal', number: 'INV-7', duplicateOrdinal: 0, boardId: 'b1', participantName: 'Jane Smith',
      itemIds: ['logged'], xero: { invoiceNumber: 'INV-0900' },
    })]);
    expect(inputs.existing[0].id).toBeTruthy();
  });

  it('copes with a workspace that holds nothing', async () => {
    const inputs = await loadBackfillInputs('ws-empty');
    expect(inputs).toMatchObject({ items: [], logRows: [], ledgerRows: [], existing: [], boards: {} });
  });
});

describe('workspacesWithInvoices', () => {
  it('lists every workspace that has a log row, an invoice ledger row or a marked item', async () => {
    expect((await workspacesWithInvoices()).sort()).toEqual([WS, OTHER]);
  });
});
