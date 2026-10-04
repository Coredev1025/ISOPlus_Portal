import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';

import Invoice from '../../../src/models/Invoice.js';
import Item from '../../../src/models/Item.js';
import PDFLink from '../../../src/models/PDFLink.js';
import { up } from '../../../migrations/1791102300000-invoice-ledger-indexes.js';
import { auditInvoices } from '../../../src/utils/invoiceLedger/audit.js';

/**
 * The invariants of the invoice ledger (KAN-302 design section 10), as one read-only
 * report. The audit script and the tests share it.
 */

const WS = 'ws-a';
const BOARD = 'b-a';

const item = (itemId, over = {}) => Item.create({
  workspaceId: WS, boardId: BOARD, folderId: 'f', itemId, data: {}, ...over,
});
const invoice = (number, itemIds, over = {}) => Invoice.create({
  workspaceId: WS, boardId: BOARD, number, kind: 'ndis', total: 10,
  lines: itemIds.map((itemId) => ({ itemId, amount: 5 })), issuedAt: new Date('2026-07-01Z'), ...over,
});
const document = (itemId, over = {}) => PDFLink.create({
  itemId, workspaceId: WS, boardId: BOARD, type: 'NDIS Invoice', pdfLink: 'https://s3/x.pdf',
  invoiceNumber: 'INV-1', invoiceTotal: 10, ...over,
});

const names = (list, key = 'itemId') => list.map((v) => v[key]).sort();

beforeEach(async () => {
  await up(mongoose.connection);
});

describe('a consistent state', () => {
  it('reports no violations', async () => {
    const inv = await invoice('INV-1', ['a', 'b']);
    await item('a', { invoicedBy: 'INV-1', activeInvoiceId: inv._id });
    await item('b', { invoicedBy: 'INV-1', activeInvoiceId: inv._id });
    await document('a', { invoiceId: inv._id });
    await document('b', { invoiceId: inv._id });

    const { violations } = await auditInvoices(WS);
    Object.values(violations).forEach((list) => expect(list).toEqual([]));
  });

  it('accepts a legacy-suffixed marker against the plain invoice number', async () => {
    const inv = await invoice('INV-1', ['a'], { legacyNumbers: ['INV-1 (ISO+™)'] });
    await item('a', { invoicedBy: 'INV-1 (ISO+™)', activeInvoiceId: inv._id });

    const { violations } = await auditInvoices(WS);
    expect(violations.markerWithoutInvoice).toEqual([]);
    expect(violations.activePointerMismatch).toEqual([]);
  });
});

describe('1: every marker has an issued invoice that lists the item', () => {
  it('flags a marker with no invoice (marker-only)', async () => {
    await item('a', { invoicedBy: 'INV-3' });
    expect(names((await auditInvoices(WS)).violations.markerWithoutInvoice)).toEqual(['a']);
  });

  it('flags a marker whose invoice does not list the item', async () => {
    await invoice('INV-3', ['other']);
    await item('a', { invoicedBy: 'INV-3' });
    expect(names((await auditInvoices(WS)).violations.markerWithoutInvoice)).toEqual(['a']);
  });

  it('flags a marker that names a number the item is not listed under, even when another invoice lists it', async () => {
    await invoice('INV-3', ['a']);
    await item('a', { invoicedBy: 'INV-5' });
    expect(names((await auditInvoices(WS)).violations.markerWithoutInvoice)).toEqual(['a']);
  });

  it('flags a portal marker when only a Xero invoice of that number lists the item', async () => {
    await invoice('INV-3', ['a'], { source: 'xero', legacyNumbers: ['INV-3 (Xero)'] });
    await item('a', { invoicedBy: 'INV-3' });
    expect(names((await auditInvoices(WS)).violations.markerWithoutInvoice)).toEqual(['a']);
  });

  it('flags a marker whose only invoice is void', async () => {
    await invoice('INV-3', ['a'], { status: 'void' });
    await item('a', { invoicedBy: 'INV-3' });
    expect(names((await auditInvoices(WS)).violations.markerWithoutInvoice)).toEqual(['a']);
  });

  it('ignores a provisional claim: that is invariant 5', async () => {
    await item('a', { invoicedBy: 'pending:ndis:p:x', invoicedAt: new Date() });
    expect((await auditInvoices(WS)).violations.markerWithoutInvoice).toEqual([]);
  });

  it('is scoped to the workspace', async () => {
    await Item.create({ workspaceId: 'other', boardId: 'b', folderId: 'f', itemId: 'z', invoicedBy: 'INV-9', data: {} });
    expect((await auditInvoices(WS)).violations.markerWithoutInvoice).toEqual([]);
  });
});

describe('2: the active pointer agrees with the marker', () => {
  it('flags a pointer to an invoice that does not list the item', async () => {
    const inv = await invoice('INV-1', ['other']);
    await item('a', { invoicedBy: 'INV-1', activeInvoiceId: inv._id });
    expect(names((await auditInvoices(WS)).violations.activePointerMismatch)).toEqual(['a']);
  });

  it('flags a pointer to an invoice that does not exist', async () => {
    await item('a', { invoicedBy: 'INV-1', activeInvoiceId: new mongoose.Types.ObjectId() });
    expect(names((await auditInvoices(WS)).violations.activePointerMismatch)).toEqual(['a']);
  });

  it('flags a marker that names a different number from the invoice it points at', async () => {
    const inv = await invoice('INV-1', ['a']);
    await item('a', { invoicedBy: 'INV-2', activeInvoiceId: inv._id });
    expect(names((await auditInvoices(WS)).violations.activePointerMismatch)).toEqual(['a']);
  });

  it('flags a pointer to a Xero invoice when the marker is a plain portal number', async () => {
    const xero = await invoice('INV-1', ['a'], { source: 'xero', legacyNumbers: ['INV-1 (Xero)'] });
    await item('a', { invoicedBy: 'INV-1', activeInvoiceId: xero._id });
    expect(names((await auditInvoices(WS)).violations.activePointerMismatch)).toEqual(['a']);
  });

  it('reports, but does not fail, an item that is on two issued invoices (double billed)', async () => {
    const first = await invoice('INV-1', ['a']);
    await invoice('INV-2', ['a']);
    await item('a', { invoicedBy: 'INV-1', activeInvoiceId: first._id });

    const report = await auditInvoices(WS);
    expect(report.violations.activePointerMismatch).toEqual([]);
    expect(names(report.reported.doubleBilled)).toEqual(['a']);
  });
});

describe('3: one invoice owns a number', () => {
  it('reports flagged duplicates, which are not violations', async () => {
    await invoice('INV-1', ['a']);
    await invoice('INV-1', ['b'], { duplicateOrdinal: 1 });

    const report = await auditInvoices(WS);
    expect(names(report.reported.duplicateNumbers, 'number')).toEqual(['INV-1']);
    expect(report.violations.duplicateOwner).toEqual([]);
  });
});

describe('4: every numbered invoice document has an invoice', () => {
  it('flags a document row with a number and no invoice id', async () => {
    await document('a');
    expect(names((await auditInvoices(WS)).violations.documentWithoutInvoice)).toEqual(['a']);
  });

  it('flags a document row whose invoice id points at nothing', async () => {
    await document('a', { invoiceId: new mongoose.Types.ObjectId() });
    expect(names((await auditInvoices(WS)).violations.documentWithoutInvoice)).toEqual(['a']);
  });

  it('ignores rows that are not invoices, or carry no number', async () => {
    await document('a', { type: 'Monthly Statement' });
    await document('b', { invoiceNumber: undefined });
    expect((await auditInvoices(WS)).violations.documentWithoutInvoice).toEqual([]);
  });
});

describe('5: no stale provisional claim without an invoice', () => {
  it('flags a claim older than the cutoff', async () => {
    await item('a', { invoicedBy: 'pending:ndis:p:x', invoicedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) });
    expect(names((await auditInvoices(WS)).violations.stalePending)).toEqual(['a']);
  });

  it('does not flag a fresh claim', async () => {
    await item('a', { invoicedBy: 'pending:ndis:p:x', invoicedAt: new Date() });
    expect((await auditInvoices(WS)).violations.stalePending).toEqual([]);
  });

  it('does not flag an old claim whose item an issued invoice lists under that claim: repair finishes that one', async () => {
    await invoice('INV-1', ['a'], { claimToken: 'pending:ndis:p:x' });
    await item('a', { invoicedBy: 'pending:ndis:p:x', invoicedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) });
    const report = await auditInvoices(WS);
    expect(report.violations.stalePending).toEqual([]);
    expect(names(report.reported.needsRepair)).toEqual(['a']);
  });
});

describe('5b: a claim that is not the invoice\'s own is not repairable', () => {
  it('flags an old claim on an item an issued invoice lists under a different claim', async () => {
    await invoice('INV-1', ['a'], { claimToken: 'pending:ndis:p:x' });
    await item('a', { invoicedBy: 'pending:ndis:p:other', invoicedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) });
    const report = await auditInvoices(WS);
    expect(names(report.violations.stalePending)).toEqual(['a']);
    expect(report.reported.needsRepair).toEqual([]);
  });
});

describe('6: the invoice total matches its document rows', () => {
  it('flags an invoice whose document rows carry a different total', async () => {
    const inv = await invoice('INV-1', ['a'], { total: 10 });
    await document('a', { invoiceId: inv._id, invoiceTotal: 99 });
    expect(names((await auditInvoices(WS)).violations.totalMismatch, 'number')).toEqual(['INV-1']);
  });

  it('accepts an invoice whose rows have no total, and a derived total', async () => {
    const inv = await invoice('INV-1', ['a'], { total: 10, totalDerived: true });
    await document('a', { invoiceId: inv._id, invoiceTotal: undefined });
    expect((await auditInvoices(WS)).violations.totalMismatch).toEqual([]);
  });
});
