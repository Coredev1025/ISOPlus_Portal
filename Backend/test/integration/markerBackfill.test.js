import { describe, it, expect, beforeEach } from 'vitest';

import Invoice from '../../src/models/Invoice.js';
import InvoiceNumber from '../../src/models/InvoiceNumber.js';
import Item from '../../src/models/Item.js';

const { runMarkerBackfill, MARKER_SENTINEL } = await import('../../src/utils/invoiceLedger/markers/run.js');
const { applyMarkers } = await import('../../src/utils/invoiceLedger/markers/apply.js');
const { repairInvoice } = await import('../../src/utils/invoiceLedger/issue.js');
const { claimItemsForInvoice } = await import('../../src/utils/invoicedMarker.js');

/**
 * KAN-312: the marker backfill against the in-memory database. Dry run writes nothing; the
 * real run needs the plan hash and only fills items that have no marker; a second run does
 * nothing; undo clears only the markers this script set.
 */

const WS = 'ws-marker';
const item = (itemId, over = {}) => ({ workspaceId: WS, boardId: 'b1', folderId: 'f', itemId, data: {}, ...over });

beforeEach(async () => {
  await Promise.all([Invoice, InvoiceNumber, Item].map((m) => m.deleteMany({})));
  await Item.insertMany([item('a'), item('b'), item('c'), item('d', { invoicedBy: 'INV-1', invoicedAt: new Date('2026-01-01T00:00:00Z') })]);
  const log = (itemId, invoiceNumber, type = 'PDF', createdAt = new Date('2026-07-01T00:00:00Z')) => InvoiceNumber.create({
    workspaceId: WS, boardId: 'b1', itemId, invoiceNumber, type, createdAt, updatedAt: createdAt,
  });
  await log('a', 'INV-24 (ISO+™)');
  await log('b', 'INV-24 (ISO+™)');
  await log('a', 'INV-0501 (Xero)', 'Xero', new Date('2026-06-01T00:00:00Z'));
  await log('c', 'INV-0600 (Xero)', 'Xero');
  await log('d', 'INV-99');
  await log('gone', 'INV-24 (ISO+™)');
});

const run = (options = {}) => runMarkerBackfill({ workspaceIds: [WS], ...options });
const apply = async () => run({ apply: true, planHash: (await run()).planHash });
const marker = async (itemId) => (await Item.findOne({ itemId }).lean());

describe('a dry run', () => {
  it('reports what it would mark and writes nothing', async () => {
    const result = await run();
    expect(result.applied).toBe(false);
    expect(result.totals).toMatchObject({ toMark: 3, alreadyMarked: 1, deletedItems: 1 });
    expect((await marker('a')).invoicedBy).toBeNull();
  });
});

describe('the real run', () => {
  it('needs the plan hash of the dry run, and refuses when the stores changed since', async () => {
    await expect(run({ apply: true })).rejects.toThrow(/--plan/);
    const { planHash } = await run();
    await Item.updateOne({ itemId: 'a' }, { $set: { invoicedBy: 'INV-77' } });
    await expect(run({ apply: true, planHash })).rejects.toThrow(/changed since the dry run/);
  });

  it('sets the marker, the date and the sentinel, and nothing else on the item', async () => {
    const before = await marker('a');
    await apply();
    const a = await marker('a');

    expect(a).toMatchObject({ invoicedBy: 'INV-24 (ISO+™)', invoicedPeriodKey: MARKER_SENTINEL });
    expect(a.invoicedAt).toEqual(new Date('2026-07-01T00:00:00Z'));
    expect(a.data).toEqual(before.data);
    expect(a.boardId).toBe(before.boardId);
    expect((await marker('c')).invoicedBy).toBe('INV-0600 (Xero)');
  });

  it('leaves an item that already had a marker exactly as it was', async () => {
    const before = await marker('d');
    await apply();
    expect(await marker('d')).toEqual(before);
  });

  it('a second run marks nothing', async () => {
    await apply();
    const again = await run();
    expect(again.totals.toMark).toBe(0);
    expect((await apply()).results[0].marked).toBe(0);
  });

  it('does not overwrite a marker a live claim set between the dry run and the write', async () => {
    const { planHash } = await run();
    // A live claim lands on item b after the plan was read; the plan for b no longer holds,
    // and the conditional write would not take it either.
    await claimItemsForInvoice({ workspaceId: WS, boardId: 'b1', itemIds: ['b'], invoiceNumber: 'INV-500', periodKey: null });
    await expect(run({ apply: true, planHash })).rejects.toThrow(/changed since the dry run/);
    expect((await marker('b')).invoicedBy).toBe('INV-500');
  });

  it('after it, a manual claim for a marked item is refused, which is the guard', async () => {
    await apply();
    const { claimed, rejected } = await claimItemsForInvoice({
      workspaceId: WS, boardId: 'b1', itemIds: ['a'], invoiceNumber: 'INV-1000', periodKey: null,
    });
    expect(claimed).toEqual([]);
    expect(rejected).toEqual(['a']);
  });
});

describe('--undo', () => {
  it('previews by default, then clears only the markers this script set', async () => {
    await apply();
    const preview = await run({ undo: true });
    expect(preview.undone).toMatchObject({ preview: true, items: 3 });
    expect((await marker('a')).invoicedBy).toBe('INV-24 (ISO+™)');

    const done = await run({ undo: true, apply: true });
    expect(done.undone).toMatchObject({ preview: false, items: 3 });
    const a = await marker('a');
    // The fields are removed, which every reader treats as no marker (`{ invoicedBy: null }` matches an absent field).
    expect(a.invoicedBy ?? null).toBeNull();
    expect(a.invoicedAt ?? null).toBeNull();
    expect(a.invoicedPeriodKey ?? null).toBeNull();
    expect((await marker('d')).invoicedBy).toBe('INV-1');
  });

  it('leaves a marker a live claim has since taken over', async () => {
    await apply();
    await Item.updateOne({ itemId: 'a' }, { $set: { invoicedPeriodKey: '20260901-0900' } });
    const done = await run({ undo: true, apply: true });
    expect(done.undone.items).toBe(2);
    expect((await marker('a')).invoicedBy).toBe('INV-24 (ISO+™)');
  });
});

describe('the conditional write itself (not the plan hash) keeps a marker that exists', () => {
  const marker = { itemId: 'a', invoicedBy: 'INV-24 (ISO+™)', invoicedAt: new Date('2026-07-01T00:00:00Z') };

  it('does not take an item that already carries a marker, or a pending claim', async () => {
    await Item.updateOne({ itemId: 'a' }, { $set: { invoicedBy: 'LIVE-1' } });
    await Item.updateOne({ itemId: 'b' }, { $set: { invoicedBy: 'pending:ndis:20260701-0900:Jane' } });

    const result = await applyMarkers([marker, { ...marker, itemId: 'b' }], WS);

    expect(result.marked).toBe(0);
    expect((await Item.findOne({ itemId: 'a' }).lean()).invoicedBy).toBe('LIVE-1');
    expect((await Item.findOne({ itemId: 'b' }).lean()).invoicedBy).toMatch(/^pending:/);
    expect((await Item.findOne({ itemId: 'a' }).lean()).invoicedPeriodKey ?? null).toBeNull();
  });

  it('takes an unmarked item, whether the field is null, empty or absent', async () => {
    await Item.updateOne({ itemId: 'b' }, { $set: { invoicedBy: '' } });
    await Item.collection.updateOne({ itemId: 'c' }, { $unset: { invoicedBy: '' } });
    const result = await applyMarkers([marker, { ...marker, itemId: 'b' }, { ...marker, itemId: 'c' }], WS);
    expect(result.marked).toBe(3);
  });
});

describe('a marker a live path repairs is no longer the backfill\'s to undo', () => {
  it('repairInvoice clears the sentinel on an item it re-confirms, so undo leaves it', async () => {
    await apply();
    const live = await Invoice.create({
      workspaceId: WS, boardId: 'b1', number: 'INV-24', legacyNumbers: ['INV-24 (ISO+™)'], kind: 'ndis', participant: { name: 'Jane Smith' },
      lines: [{ itemId: 'a', amount: 5 }], total: 5, issuedAt: new Date('2026-07-01T00:00:00Z'), trigger: 'manual', origin: 'live',
    });

    await repairInvoice(live._id);

    expect((await marker('a')).invoicedPeriodKey ?? null).toBeNull();
    const done = await run({ undo: true, apply: true });
    expect(done.undone.items).toBe(2);
    expect((await marker('a')).invoicedBy).toBe('INV-24 (ISO+™)');
  });
});

describe('arguments and reporting', () => {
  it('the same workspace named twice is planned and written once', async () => {
    const { planHash } = await runMarkerBackfill({ workspaceIds: [WS, WS] });
    const result = await runMarkerBackfill({ workspaceIds: [WS, WS], apply: true, planHash });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].marked).toBe(3);
  });
});
