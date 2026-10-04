import { describe, it, expect } from 'vitest';

import Invoice from '../../../../src/models/Invoice.js';
import { planBackfill } from '../../../../src/utils/invoiceLedger/backfill/plan.js';

/**
 * The backfill planner (KAN-310): turns the three old stores into the invoices the new
 * record should hold, by design section 6. Pure: inputs in, a plan and a report out.
 * `deriveTotal` is injected; here it splits a fixed total evenly.
 */

const NDIS = 'b-ndis';
const AGE = 'b-age';
const LOWCAT = 'b-low';
const BOARDS = {
  [NDIS]: { label: 'Care Management NDIS 2026 Pricing' },
  [AGE]: { label: 'Care Management - SaH' },
  [LOWCAT]: { label: 'Care Management - SaH - Low Cat' },
};

// A marked item has been dated since the marker was written; the planner never invents a date.
const item = (itemId, over = {}) => ({
  itemId,
  boardId: NDIS,
  invoicedBy: undefined,
  invoicedAt: over.invoicedBy ? new Date('2026-07-15T00:00:00Z') : undefined,
  participantName: 'Jane Smith',
  ...over,
});
const log = (itemId, invoiceNumber, over = {}) => ({
  itemId, boardId: NDIS, invoiceNumber, type: 'PDF', pdfLink: `https://s3/${invoiceNumber}.pdf`,
  createdAt: new Date('2026-07-01T00:00:00Z'), updatedAt: new Date('2026-07-01T00:00:00Z'), ...over,
});
const ledger = (id, itemId, invoiceNumber, over = {}) => ({
  id, itemId, boardId: NDIS, type: 'NDIS Invoice', invoiceNumber, invoiceTotal: 300, participant: 'Jane Smith',
  pdfLink: `https://s3/${invoiceNumber ?? id}.pdf`, createdAt: new Date('2026-07-02T00:00:00Z'), isDeleted: false, ...over,
});

const deriveTotal = async ({ itemIds, knownTotal }) => {
  const total = knownTotal ?? 90 * itemIds.length;
  return { total, perItem: Object.fromEntries(itemIds.map((id) => [id, Math.round((total / itemIds.length) * 100) / 100])) };
};

const plan = (inputs, opts = {}) => planBackfill({
  workspaceId: 'ws-bf', boards: BOARDS, items: [], logRows: [], ledgerRows: [], existing: [], ...inputs,
}, { deriveTotal, ...opts });

const byNumber = (result, number, source = 'portal') => result.invoices.find((i) => i.number === number && i.source === source);

describe('rule 1: a numbered ledger group becomes an invoice', () => {
  it('lists the group items, carries the repeated total and the date, and stamps the rows', async () => {
    const result = await plan({
      items: [item('a', { invoicedBy: 'INV-5' }), item('b', { invoicedBy: 'INV-5' })],
      ledgerRows: [ledger('r1', 'a', 'INV-5', { invoiceDate: new Date('2026-06-20T00:00:00Z') }), ledger('r2', 'b', 'INV-5', { invoiceDate: new Date('2026-06-20T00:00:00Z') })],
    });

    const inv = byNumber(result, 'INV-5');
    expect(inv).toMatchObject({
      boardId: NDIS, kind: 'ndis', total: 300, totalDerived: false, origin: 'backfill', status: 'issued', trigger: 'manual',
      participant: { name: 'Jane Smith' }, backfill: { reason: 'ledger' },
    });
    expect(inv.lines.map((l) => l.itemId)).toEqual(['a', 'b']);
    expect(inv.issuedAt).toEqual(new Date('2026-06-20T00:00:00Z'));
    expect(inv.pdf).toEqual({ pdfLink: 'https://s3/INV-5.pdf' });
    expect(result.stamps.map((s) => s.ledgerRowId).sort()).toEqual(['r1', 'r2']);
    expect(result.stamps.every((s) => s.ref === inv.ref)).toBe(true);
  });

  it('falls back to the row creation date when the row has no invoice date', async () => {
    const result = await plan({ items: [item('a')], ledgerRows: [ledger('r1', 'a', 'INV-5')] });
    expect(byNumber(result, 'INV-5').issuedAt).toEqual(new Date('2026-07-02T00:00:00Z'));
  });

  it('derives the total, flagged, when the ledger rows carry none', async () => {
    const result = await plan({ items: [item('a')], ledgerRows: [ledger('r1', 'a', 'INV-5', { invoiceTotal: undefined })] });
    expect(byNumber(result, 'INV-5')).toMatchObject({ total: 90, totalDerived: true });
  });

  it('normalises a suffixed number and keeps the original as a legacy number', async () => {
    const result = await plan({ items: [item('a')], ledgerRows: [ledger('r1', 'a', 'INV-24 (ISO+™)')] });
    expect(byNumber(result, 'INV-24')).toMatchObject({ number: 'INV-24', legacyNumbers: ['INV-24 (ISO+™)'] });
  });

  it('takes the kind from the board: Age Care, and Low Cat by its label', async () => {
    const result = await plan({
      items: [item('a', { boardId: AGE }), item('b', { boardId: LOWCAT })],
      ledgerRows: [
        ledger('r1', 'a', 'INV-6', { boardId: AGE, type: 'Participant Tax Invoice' }),
        ledger('r2', 'b', 'INV-7', { boardId: LOWCAT, type: 'Participant Tax Invoice' }),
      ],
    });
    expect(byNumber(result, 'INV-6')).toMatchObject({ kind: 'age_care', lowCat: false });
    expect(byNumber(result, 'INV-7')).toMatchObject({ kind: 'age_care', lowCat: true });
  });

  it('reports an invoice on a board it cannot place, and creates nothing', async () => {
    const result = await plan({
      items: [item('a', { boardId: 'b-other' })],
      ledgerRows: [ledger('r1', 'a', 'INV-8', { boardId: 'b-other' })],
    });
    expect(result.invoices).toEqual([]);
    expect(result.report.lists.unplaceable.map((u) => u.number)).toEqual(['INV-8']);
  });
});

describe('rule 2: a ledger row with no number is placed through the log or not at all', () => {
  it('finds the number by the document link', async () => {
    const result = await plan({
      items: [item('a')],
      ledgerRows: [ledger('r1', 'a', undefined, { pdfLink: 'https://s3/x.pdf', invoiceTotal: undefined })],
      logRows: [log('a', 'INV-9 (ISO+™)', { pdfLink: 'https://s3/x.pdf' })],
    });
    expect(byNumber(result, 'INV-9')).toBeTruthy();
    expect(result.stamps).toHaveLength(1);
  });

  it('then by the item', async () => {
    const result = await plan({
      items: [item('a')],
      ledgerRows: [ledger('r1', 'a', undefined, { pdfLink: 'https://s3/other.pdf' })],
      logRows: [log('a', 'INV-9')],
    });
    expect(byNumber(result, 'INV-9')).toBeTruthy();
  });

  it('reports a row that cannot be placed and does not turn it into an invoice', async () => {
    const result = await plan({ items: [item('a')], ledgerRows: [ledger('r1', 'a', undefined)] });
    expect(result.invoices).toEqual([]);
    expect(result.report.lists.unplaceableLedgerRows).toEqual([{ ledgerRowId: 'r1', itemId: 'a' }]);
  });
});

describe('rule 3: an invoice with no ledger group is built from the marker or the log', () => {
  it('marker-only: the marked items, the earliest marked date, reason marker-only', async () => {
    const result = await plan({
      items: [
        item('a', { invoicedBy: 'INV-3', invoicedAt: new Date('2026-08-10T00:00:00Z') }),
        item('b', { invoicedBy: 'INV-3', invoicedAt: new Date('2026-08-05T00:00:00Z') }),
      ],
    });
    const inv = byNumber(result, 'INV-3');
    expect(inv.lines.map((l) => l.itemId)).toEqual(['a', 'b']);
    expect(inv).toMatchObject({ totalDerived: true, total: 180, backfill: { reason: 'marker-only' } });
    expect(inv.issuedAt).toEqual(new Date('2026-08-05T00:00:00Z'));
  });

  it('marker-only takes its date and document from the log row when the items have no date', async () => {
    const result = await plan({
      items: [item('a', { invoicedBy: 'INV-3', invoicedAt: undefined })],
      logRows: [log('a', 'INV-3', { createdAt: new Date('2026-06-01T00:00:00Z') })],
    });
    const inv = byNumber(result, 'INV-3');
    expect(inv.issuedAt).toEqual(new Date('2026-06-01T00:00:00Z'));
    expect(inv.pdf).toEqual({ pdfLink: 'https://s3/INV-3.pdf' });
  });

  it('log-only (the production case): no marker, no ledger number, the PDF log rows are the record', async () => {
    const result = await plan({
      items: [item('a'), item('b')],
      logRows: [
        log('a', 'INV-24 (ISO+™)', { createdAt: new Date('2026-05-02T00:00:00Z') }),
        log('b', 'INV-24 (ISO+™)', { createdAt: new Date('2026-05-01T00:00:00Z') }),
      ],
    });
    const inv = byNumber(result, 'INV-24');
    expect(inv).toMatchObject({ backfill: { reason: 'log-only' }, totalDerived: true, legacyNumbers: ['INV-24 (ISO+™)'] });
    expect(inv.lines.map((l) => l.itemId).sort()).toEqual(['a', 'b']);
    expect(inv.issuedAt).toEqual(new Date('2026-05-01T00:00:00Z'));
  });

  it('log-only leaves out items that sync has since deleted, and says so', async () => {
    const result = await plan({
      items: [item('a')],
      logRows: [log('a', 'INV-24'), log('gone', 'INV-24')],
    });
    expect(byNumber(result, 'INV-24').lines.map((l) => l.itemId)).toEqual(['a']);
    expect(result.report.lists.deletedItems).toEqual([{ itemId: 'gone', number: 'INV-24' }]);
  });

  it('a (Xero) marker with no portal group becomes a Xero invoice', async () => {
    const result = await plan({ items: [item('a', { invoicedBy: 'INV-0001 (Xero)' })] });
    expect(byNumber(result, 'INV-0001', 'xero')).toMatchObject({ source: 'xero', legacyNumbers: ['INV-0001 (Xero)'] });
  });

  it('is not created when no date can be found, rather than being dated today', async () => {
    const result = await plan({ items: [item('a', { invoicedBy: 'INV-3', invoicedAt: undefined })] });
    expect(result.invoices).toEqual([]);
    expect(result.report.lists.unplaceable[0]).toMatchObject({ number: 'INV-3', reason: 'date-unknown' });
  });

  it('is not created when the participant cannot be determined', async () => {
    const result = await plan({ items: [item('a', { invoicedBy: 'INV-3', participantName: undefined })] });
    expect(result.invoices).toEqual([]);
    expect(result.report.lists.unplaceable[0]).toMatchObject({ number: 'INV-3', reason: 'participant-unknown' });
  });

  it('is not created when the total cannot be derived', async () => {
    const result = await plan({ items: [item('a', { invoicedBy: 'INV-3' })] }, { deriveTotal: async () => null });
    expect(result.invoices).toEqual([]);
    expect(result.report.lists.unplaceable[0]).toMatchObject({ number: 'INV-3', reason: 'total-underivable' });
  });
});

describe('rule 7: a log row for an item whose marker names a different invoice is stale', () => {
  it('creates nothing from it and lists it (INV-22)', async () => {
    const result = await plan({
      items: [item('a', { invoicedBy: 'INV-3' })],
      logRows: [log('a', 'INV-22')],
    });
    expect(byNumber(result, 'INV-22')).toBeUndefined();
    expect(byNumber(result, 'INV-3')).toBeTruthy();
    expect(result.report.lists.staleLegacy).toEqual([{ itemId: 'a', number: 'INV-22', marker: 'INV-3' }]);
  });

  it('an item with no marker is the production case: the log row is the record', async () => {
    const result = await plan({ items: [item('a')], logRows: [log('a', 'INV-22')] });
    expect(byNumber(result, 'INV-22')).toBeTruthy();
    expect(result.report.lists.staleLegacy).toEqual([]);
  });
});

describe('rule 5: Xero rows', () => {
  it('an item with both a PDF and a Xero row is one billing: the Xero number is attached to the portal invoice (D8)', async () => {
    const result = await plan({
      items: [item('a')],
      logRows: [log('a', 'INV-24 (ISO+™)'), log('a', 'INV-0501 (Xero)', { type: 'Xero', pdfLink: null })],
    });
    expect(result.invoices).toHaveLength(1);
    expect(byNumber(result, 'INV-24').xero).toEqual({ invoiceNumber: 'INV-0501' });
  });

  it('a Xero number over items on two portal invoices is attached to each and reported', async () => {
    const result = await plan({
      items: [item('a'), item('b')],
      logRows: [
        log('a', 'INV-24'), log('b', 'INV-25'),
        log('a', 'INV-0501 (Xero)', { type: 'Xero', pdfLink: null }), log('b', 'INV-0501 (Xero)', { type: 'Xero', pdfLink: null }),
      ],
    });
    expect(byNumber(result, 'INV-24').xero.invoiceNumber).toBe('INV-0501');
    expect(byNumber(result, 'INV-25').xero.invoiceNumber).toBe('INV-0501');
    expect(result.report.lists.xeroSpansInvoices).toEqual([{ xeroNumber: 'INV-0501', invoices: ['INV-24', 'INV-25'] }]);
  });

  it('an item with only a Xero row becomes a Xero-source invoice', async () => {
    const result = await plan({
      items: [item('a')],
      logRows: [log('a', 'INV-0600 (Xero)', { type: 'Xero', pdfLink: null })],
    });
    expect(byNumber(result, 'INV-0600', 'xero')).toMatchObject({ source: 'xero', backfill: { reason: 'xero-only' } });
  });

  it('a draft push (a ledger row carrying xeroInvoiceNumber) sets invoice.xero', async () => {
    const result = await plan({
      items: [item('a')],
      ledgerRows: [ledger('r1', 'a', 'INV-5', { xeroInvoiceNumber: 'INV-0700' })],
    });
    expect(byNumber(result, 'INV-5').xero).toEqual({ invoiceNumber: 'INV-0700' });
  });
});

describe('section 6.3: the cases that need an explicit rule', () => {
  it('two different invoices sharing a number are both created, the later with a duplicate ordinal', async () => {
    const result = await plan({
      items: [item('a'), item('b', { participantName: 'Other Person' })],
      ledgerRows: [
        ledger('r1', 'a', 'INV-5', { pdfLink: 'https://s3/1.pdf', createdAt: new Date('2026-07-01Z') }),
        ledger('r2', 'b', 'INV-5', { participant: 'Other Person', pdfLink: 'https://s3/2.pdf', createdAt: new Date('2026-07-05Z') }),
      ],
    });
    const same = result.invoices.filter((i) => i.number === 'INV-5');
    expect(same.map((i) => i.duplicateOrdinal).sort()).toEqual([0, 1]);
    expect(same.find((i) => i.duplicateOrdinal === 0).participant.name).toBe('Jane Smith');
    expect(result.report.lists.duplicateNumbers.map((d) => d.number)).toEqual(['INV-5']);
  });

  it('two groups that are the same invoice (a hand-regenerated PDF) are one invoice with the extra document kept', async () => {
    const result = await plan({
      items: [item('a'), item('b')],
      ledgerRows: [
        ledger('r1', 'a', 'INV-5', { pdfLink: 'https://s3/1.pdf' }), ledger('r2', 'b', 'INV-5', { pdfLink: 'https://s3/1.pdf' }),
        ledger('r3', 'a', 'INV-5', { pdfLink: 'https://s3/2.pdf' }), ledger('r4', 'b', 'INV-5', { pdfLink: 'https://s3/2.pdf' }),
      ],
    });
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0].pdf.pdfLink).toBe('https://s3/1.pdf');
    expect(result.invoices[0].extraPdfLinks).toEqual(['https://s3/2.pdf']);
    expect(result.report.lists.regeneratedDocuments).toHaveLength(1);
    expect(result.stamps).toHaveLength(4);
  });

  it('one item on two invoices keeps both, points at the invoice its marker names, and is listed double-billed', async () => {
    const result = await plan({
      items: [item('a', { invoicedBy: 'INV-5' })],
      ledgerRows: [ledger('r1', 'a', 'INV-5'), ledger('r2', 'a', 'INV-6', { pdfLink: 'https://s3/6.pdf', createdAt: new Date('2026-08-01Z') })],
    });
    expect(result.invoices.map((i) => i.number).sort()).toEqual(['INV-5', 'INV-6']);
    expect(result.pointers).toEqual([{ itemId: 'a', ref: byNumber(result, 'INV-5').ref }]);
    expect(result.report.lists.doubleBilled).toEqual([{ itemId: 'a', invoices: ['INV-5', 'INV-6'] }]);
  });

  it('with no marker the item points at the latest invoice that lists it', async () => {
    const result = await plan({
      items: [item('a')],
      ledgerRows: [
        ledger('r1', 'a', 'INV-5', { invoiceDate: new Date('2026-07-01Z') }),
        ledger('r2', 'a', 'INV-6', { pdfLink: 'https://s3/6.pdf', invoiceDate: new Date('2026-08-01Z') }),
      ],
    });
    expect(result.pointers[0].ref).toBe(byNumber(result, 'INV-6').ref);
  });

  it('a ledger invoice whose items carry no marker is created and reported marker-missing', async () => {
    const result = await plan({ items: [item('a')], ledgerRows: [ledger('r1', 'a', 'INV-5')] });
    expect(byNumber(result, 'INV-5')).toBeTruthy();
    expect(result.report.lists.markerMissing).toEqual([{ number: 'INV-5' }]);
  });

  it('a document that has been deleted is not an invoice, and the old log cannot bring it back', async () => {
    const result = await plan({
      items: [item('a')],
      ledgerRows: [ledger('r1', 'a', 'INV-5', { isDeleted: true })],
      logRows: [log('a', 'INV-5')],
    });
    expect(result.invoices).toEqual([]);
    expect(result.report.lists.deletedDocuments).toEqual([{ number: 'INV-5' }]);
  });
});

describe('rule 6: pending tokens are not invoices', () => {
  it('lists them and creates nothing', async () => {
    const result = await plan({ items: [item('a', { invoicedBy: 'pending:ndis:20260701-0900:Jane' })] });
    expect(result.invoices).toEqual([]);
    expect(result.report.lists.pendingTokens).toEqual([{ itemId: 'a', marker: 'pending:ndis:20260701-0900:Jane' }]);
  });
});

describe('idempotency: what already exists is not created again', () => {
  it('skips a group the invoice collection already holds', async () => {
    const result = await plan({
      items: [item('a', { invoicedBy: 'INV-5' })],
      ledgerRows: [ledger('r1', 'a', 'INV-5')],
      existing: [{ source: 'portal', number: 'INV-5', duplicateOrdinal: 0, itemIds: ['a'], issuedAt: new Date('2026-07-02Z') }],
    });
    expect(result.invoices).toEqual([]);
    expect(result.report.counts.alreadyRecorded).toBe(1);
  });

  it('still stamps the ledger rows of an invoice that already exists', async () => {
    const result = await plan({
      items: [item('a', { invoicedBy: 'INV-5' })],
      ledgerRows: [ledger('r1', 'a', 'INV-5')],
      existing: [{ id: 'inv-live', source: 'portal', number: 'INV-5', duplicateOrdinal: 0, itemIds: ['a'], issuedAt: new Date('2026-07-02Z') }],
    });
    expect(result.stamps).toEqual([{ ledgerRowId: 'r1', invoiceId: 'inv-live' }]);
  });

  it('a second run over the same inputs plus its own output creates nothing', async () => {
    const inputs = { items: [item('a'), item('b')], logRows: [log('a', 'INV-24'), log('b', 'INV-24')] };
    const first = await plan(inputs);
    const existing = first.invoices.map((i) => ({
      id: `id-${i.ref}`, source: i.source, number: i.number, duplicateOrdinal: i.duplicateOrdinal, itemIds: i.lines.map((l) => l.itemId), issuedAt: i.issuedAt,
    }));
    const second = await plan({ ...inputs, existing });
    expect(second.invoices).toEqual([]);
  });
});

describe('the report', () => {
  it('counts invoices by reason and items linked', async () => {
    const result = await plan({
      items: [item('a', { invoicedBy: 'INV-3' }), item('b'), item('c')],
      ledgerRows: [ledger('r1', 'c', 'INV-5')],
      logRows: [log('b', 'INV-24')],
    });
    expect(result.report.counts.created).toEqual({ ledger: 1, 'marker-only': 1, 'log-only': 1 });
    expect(result.report.counts.itemsLinked).toBe(3);
  });
});

describe('review: production-shape inputs', () => {
  it('a ledger row with no board takes the board from its item (the old routes never stored one)', async () => {
    const result = await plan({
      items: [item('a')],
      ledgerRows: [ledger('r1', 'a', undefined, { boardId: undefined, participant: undefined })],
      logRows: [log('a', 'INV-9')],
    });
    expect(byNumber(result, 'INV-9')).toMatchObject({ boardId: NDIS, participant: { name: 'Jane Smith' } });
    expect(result.report.lists.unplaceable).toEqual([]);
  });

  it('the log extends a ledger invoice of the same number, board and participant instead of minting a second one', async () => {
    const result = await plan({
      items: [item('a'), item('b'), item('c')],
      ledgerRows: [ledger('r1', 'a', 'INV-9')],
      logRows: [log('a', 'INV-9'), log('b', 'INV-9'), log('c', 'INV-9')],
    });
    const nine = result.invoices.filter((i) => i.number === 'INV-9');
    expect(nine).toHaveLength(1);
    expect(nine[0].lines.map((l) => l.itemId).sort()).toEqual(['a', 'b', 'c']);
    // The printed total covers the whole invoice; the extra items do not change it.
    expect(nine[0]).toMatchObject({ total: 300, totalDerived: false, duplicateOrdinal: 0 });
    expect(result.report.lists.duplicateNumbers).toEqual([]);
  });

  it('a marker extends a ledger invoice the same way', async () => {
    const result = await plan({
      items: [item('a', { invoicedBy: 'INV-5' }), item('b', { invoicedBy: 'INV-5' })],
      ledgerRows: [ledger('r1', 'a', 'INV-5')],
    });
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0].lines.map((l) => l.itemId)).toEqual(['a', 'b']);
  });

  it('does not give an old document the item\'s latest number when the document links differ', async () => {
    const result = await plan({
      items: [item('a'), item('b')],
      ledgerRows: [ledger('old', 'a', undefined, { pdfLink: 'https://s3/old.pdf', createdAt: new Date('2026-05-01Z') })],
      logRows: [log('a', 'INV-9', { pdfLink: 'https://s3/new.pdf' })],
    });
    expect(result.report.lists.unplaceableLedgerRows).toEqual([{ ledgerRowId: 'old', itemId: 'a' }]);
    expect(result.invoices.filter((i) => i.number === 'INV-9').map((i) => i.lines.map((l) => l.itemId))).toEqual([['a']]);
  });

  it('places by item when the log row has no document link to contradict it', async () => {
    const result = await plan({
      items: [item('a')],
      ledgerRows: [ledger('r1', 'a', undefined, { pdfLink: 'https://s3/x.pdf' })],
      logRows: [log('a', 'INV-9', { pdfLink: null })],
    });
    expect(byNumber(result, 'INV-9')).toBeTruthy();
  });

  it('keeps two participants under one logged number as two invoices', async () => {
    const result = await plan({
      items: [item('a'), item('b', { participantName: 'Bob Jones' })],
      logRows: [log('a', 'INV-9'), log('b', 'INV-9')],
    });
    const nine = result.invoices.filter((i) => i.number === 'INV-9');
    expect(nine.map((i) => i.participant.name).sort()).toEqual(['Bob Jones', 'Jane Smith']);
    expect(nine.map((i) => i.duplicateOrdinal).sort()).toEqual([0, 1]);
    expect(result.report.lists.duplicateNumbers).toHaveLength(1);
  });

  it('treats participant names that differ only in spacing or case as one participant', async () => {
    const result = await plan({
      items: [item('a'), item('b', { participantName: ' jane  SMITH ' })],
      ledgerRows: [ledger('r1', 'a', 'INV-5', { participant: 'Jane Smith ' }), ledger('r2', 'b', 'INV-5', { participant: 'Jane Smith' })],
    });
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0].participant.name).toBe('Jane Smith');
  });

  it('is idempotent with Xero rows: a second run attaches nothing and creates nothing', async () => {
    const inputs = {
      items: [item('a')],
      logRows: [log('a', 'INV-24 (ISO+™)'), log('a', 'INV-0501 (Xero)', { type: 'Xero', pdfLink: null })],
    };
    const first = await plan(inputs);
    const existing = first.invoices.map((i) => ({
      id: `id-${i.ref}`, source: i.source, number: i.number, duplicateOrdinal: i.duplicateOrdinal,
      itemIds: i.lines.map((l) => l.itemId), issuedAt: i.issuedAt, xero: i.xero,
    }));
    const second = await plan({ ...inputs, existing });
    expect(second.invoices).toEqual([]);
    expect(second.xeroAttachments).toEqual([]);
  });

  it('asks to attach a Xero number to an invoice that already exists without one', async () => {
    const result = await plan({
      items: [item('a')],
      logRows: [log('a', 'INV-24'), log('a', 'INV-0501 (Xero)', { type: 'Xero', pdfLink: null })],
      existing: [{ id: 'inv-1', source: 'portal', number: 'INV-24', duplicateOrdinal: 0, itemIds: ['a'], issuedAt: new Date('2026-07-01Z') }],
    });
    expect(result.invoices).toEqual([]);
    expect(result.xeroAttachments).toEqual([{ invoiceId: 'inv-1', xero: { invoiceNumber: 'INV-0501' } }]);
  });

  it('keeps a printed total when the total cannot be derived, and says the amounts are unknown', async () => {
    const result = await plan({ items: [item('a')], ledgerRows: [ledger('r1', 'a', 'INV-5')] }, { deriveTotal: async () => null });
    expect(byNumber(result, 'INV-5')).toMatchObject({ total: 300, totalDerived: false });
    expect(byNumber(result, 'INV-5').lines).toEqual([{ itemId: 'a', amount: 0 }]);
    expect(result.report.lists.amountsUnknown).toEqual([{ number: 'INV-5' }]);
  });

  it('lists a ledger row whose item sync has deleted, and still creates the invoice', async () => {
    const result = await plan({ items: [], ledgerRows: [ledger('r1', 'gone', 'INV-5')] }, { deriveTotal: async () => null });
    expect(byNumber(result, 'INV-5').lines.map((l) => l.itemId)).toEqual(['gone']);
    expect(result.report.lists.deletedItems).toEqual([{ itemId: 'gone', number: 'INV-5' }]);
  });

  it('reports a regenerated document whose total differs, and takes the latest total', async () => {
    const result = await plan({
      items: [item('a')],
      ledgerRows: [
        ledger('r1', 'a', 'INV-5', { pdfLink: 'https://s3/1.pdf', invoiceTotal: 100, createdAt: new Date('2026-07-01Z') }),
        ledger('r2', 'a', 'INV-5', { pdfLink: 'https://s3/2.pdf', invoiceTotal: 250, createdAt: new Date('2026-07-09Z') }),
      ],
    });
    expect(byNumber(result, 'INV-5').total).toBe(250);
    expect(result.report.lists.regeneratedDocuments).toEqual([{ number: 'INV-5', totalsDiffer: true }]);
  });

  it('reports a second Xero number on one invoice and keeps the earlier', async () => {
    const result = await plan({
      items: [item('a')],
      logRows: [
        log('a', 'INV-24'),
        log('a', 'INV-0502 (Xero)', { type: 'Xero', pdfLink: null, createdAt: new Date('2026-07-09Z') }),
        log('a', 'INV-0501 (Xero)', { type: 'Xero', pdfLink: null, createdAt: new Date('2026-07-05Z') }),
      ],
    });
    expect(byNumber(result, 'INV-24').xero).toEqual({ invoiceNumber: 'INV-0501' });
    expect(result.report.lists.xeroConflicts).toEqual([{ invoice: 'INV-24', kept: 'INV-0501', dropped: 'INV-0502' }]);
  });

  it('reports a Xero number that covers a portal invoice and an item on no invoice', async () => {
    const result = await plan({
      items: [item('a'), item('b')],
      logRows: [
        log('a', 'INV-24'),
        log('a', 'INV-0501 (Xero)', { type: 'Xero', pdfLink: null }), log('b', 'INV-0501 (Xero)', { type: 'Xero', pdfLink: null }),
      ],
    });
    expect(result.report.lists.xeroSpansInvoices).toEqual([{ xeroNumber: 'INV-0501', invoices: ['INV-24', '(xero only)'] }]);
  });

  it('a deleted INV-5 on one board does not suppress INV-5 on another, and a suppressed marker is listed', async () => {
    const other = await plan({
      items: [item('a'), item('y', { boardId: AGE, invoicedBy: 'INV-5' })],
      ledgerRows: [ledger('r1', 'a', 'INV-5', { isDeleted: true })],
    });
    expect(other.invoices.map((i) => i.boardId)).toEqual([AGE]);

    const same = await plan({
      items: [item('a', { invoicedBy: 'INV-5' })],
      ledgerRows: [ledger('r1', 'a', 'INV-5', { isDeleted: true })],
    });
    expect(same.invoices).toEqual([]);
    expect(same.report.lists.suppressedMarkers).toEqual([{ itemId: 'a', marker: 'INV-5' }]);
  });

  it('an item with no marker that another invoice lists still gets its own logged invoice, and is double-billed', async () => {
    const result = await plan({
      items: [item('a'), item('b')],
      ledgerRows: [ledger('r1', 'a', 'INV-5'), ledger('r2', 'b', 'INV-5')],
      logRows: [log('a', 'INV-9')],
    });
    expect(byNumber(result, 'INV-9').lines.map((l) => l.itemId)).toEqual(['a']);
    expect(result.report.lists.doubleBilled).toEqual([{ itemId: 'a', invoices: ['INV-5', 'INV-9'] }]);
  });

  it('adds the items of an invoice already recorded to the pointers (resume after a partial apply)', async () => {
    const result = await plan({
      items: [item('a', { invoicedBy: 'INV-5' })],
      ledgerRows: [ledger('r1', 'a', 'INV-5')],
      existing: [{ id: 'inv-1', source: 'portal', number: 'INV-5', duplicateOrdinal: 0, itemIds: ['a'], issuedAt: new Date('2026-07-02Z') }],
    });
    expect(result.pointers).toEqual([{ itemId: 'a', invoiceId: 'inv-1' }]);
  });

  it('reports items a draft has beyond an invoice that already exists, instead of minting a duplicate', async () => {
    const result = await plan({
      items: [item('a'), item('b')],
      logRows: [log('a', 'INV-9'), log('b', 'INV-9')],
      existing: [{
        id: 'inv-1', boardId: NDIS, participantName: 'Jane Smith', source: 'portal', number: 'INV-9', duplicateOrdinal: 0, itemIds: ['a'], issuedAt: new Date('2026-07-02Z'),
      }],
    });
    expect(result.invoices).toEqual([]);
    expect(result.report.lists.existingMissingItems).toEqual([{ number: 'INV-9', itemIds: ['b'] }]);
  });

  it('keeps the trigger and period of an automated ledger invoice', async () => {
    const result = await plan({
      items: [item('a')],
      ledgerRows: [ledger('r1', 'a', 'INV-5', { periodKey: '20260701-0900', periodStart: new Date('2026-06-01Z'), periodEnd: new Date('2026-06-30Z') })],
    });
    expect(byNumber(result, 'INV-5')).toMatchObject({ trigger: 'automation', periodKey: '20260701-0900' });
  });

  it('marks an invoice dated from a revisited log row as approximate and counts it', async () => {
    const result = await plan({
      items: [item('a')],
      logRows: [log('a', 'INV-24', { createdAt: new Date('2026-05-01T00:00:00Z'), updatedAt: new Date('2026-07-01T00:00:00Z') })],
    });
    expect(byNumber(result, 'INV-24').backfill.notes).toContain('issued-at-approximate');
    expect(result.report.counts.revisitedLogRows).toBe(1);
  });

  it('gives unplaceable and duplicate entries the board and the items, so someone can act on them', async () => {
    const result = await plan({
      items: [item('a', { boardId: 'b-other' })],
      ledgerRows: [ledger('r1', 'a', 'INV-8', { boardId: 'b-other' })],
    });
    expect(result.report.lists.unplaceable[0]).toMatchObject({ number: 'INV-8', boardId: 'b-other', itemIds: ['a'] });
  });

  it('ignores an invalid invoice date and a blank total on a ledger row', async () => {
    const result = await plan({
      items: [item('a')],
      ledgerRows: [ledger('r1', 'a', 'INV-5', { invoiceDate: new Date('nope'), invoiceTotal: '' })],
    });
    expect(byNumber(result, 'INV-5')).toMatchObject({ issuedAt: new Date('2026-07-02T00:00:00Z'), totalDerived: true });
  });
});

describe('the invoices it plans are valid records', () => {
  it('every planned invoice passes the model validation, whatever its source', async () => {
    const result = await plan({
      items: [item('a', { invoicedBy: 'INV-3' }), item('b'), item('c', { boardId: LOWCAT }), item('d')],
      ledgerRows: [
        ledger('r1', 'c', 'INV-7', { boardId: LOWCAT, type: 'Participant Tax Invoice' }),
        ledger('r2', 'd', 'INV-8', { periodKey: '20260701-0900', periodStart: new Date('2026-06-01Z'), periodEnd: new Date('2026-06-30Z') }),
      ],
      logRows: [
        log('b', 'INV-24 (ISO+™)'), log('b', 'INV-0501 (Xero)', { type: 'Xero', pdfLink: null }),
        log('a', 'INV-0600 (Xero)', { type: 'Xero', pdfLink: null }),
      ],
    });
    expect(result.invoices.length).toBeGreaterThanOrEqual(4);
    for (const doc of result.invoices) await expect(new Invoice(doc).validate()).resolves.toBeUndefined();
  });
});
