import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';

import Board from '../../src/models/Board.js';
import Business from '../../src/models/Business.js';
import Invoice from '../../src/models/Invoice.js';
import InvoiceNumber from '../../src/models/InvoiceNumber.js';
import Item from '../../src/models/Item.js';
import PDFLink from '../../src/models/PDFLink.js';
import { up as buildInvoiceIndexes } from '../../migrations/1791102300000-invoice-ledger-indexes.js';

const { runBackfill, AcknowledgementError } = await import('../../src/utils/invoiceLedger/backfill/run.js');
const { applyPlan } = await import('../../src/utils/invoiceLedger/backfill/apply.js');
const { missingAcknowledgements, parseAcks } = await import('../../src/utils/invoiceLedger/backfill/acks.js');

/**
 * KAN-311: the backfill end to end against the in-memory database, with a stub for the
 * total derivation (its own test pins it to the generators). Dry run writes nothing; the
 * real run refuses unless every category the plan found was acknowledged; a second run
 * creates nothing; undo removes only what the backfill made.
 */

const WS = 'ws-run';
const deriveTotalFor = () => async ({ itemIds, knownTotal }) => ({
  total: knownTotal ?? 100 * itemIds.length,
  perItem: Object.fromEntries(itemIds.map((id) => [id, (knownTotal ?? 100 * itemIds.length) / itemIds.length])),
});

const item = (itemId, over = {}) => ({
  workspaceId: WS, boardId: 'b1', folderId: 'f', itemId, data: { 'Participant Full Name': 'Jane Smith' }, ...over,
});

/**
 * Production-like: item `a`,`b` on a logged invoice INV-24 (no markers), a Xero row on `a`;
 * `c` marker-only INV-3 with a stale older log entry (INV-22); `d` on a ledger invoice INV-5
 * with a printed total.
 */
async function seed() {
  await Promise.all([Board, Business, Invoice, InvoiceNumber, Item, PDFLink].map((m) => m.deleteMany({})));
  await Board.create({ boardId: 'b1', workspaceId: WS, name: 'NDIS', label: 'Care Management NDIS 2026 Pricing' });
  await Business.create({ workspaceId: WS, name: 'Biz' });
  await Item.insertMany([
    item('a'), item('b'),
    item('c', { invoicedBy: 'INV-3', invoicedAt: new Date('2026-08-01T00:00:00Z') }),
    item('d', { invoicedBy: 'INV-5' }),
  ]);
  const log = (itemId, invoiceNumber, type = 'PDF') => InvoiceNumber.create({
    workspaceId: WS, boardId: 'b1', itemId, invoiceNumber, type, pdfLink: type === 'PDF' ? 'https://s3/24.pdf' : null,
  });
  await log('a', 'INV-24 (ISO+™)');
  await log('b', 'INV-24 (ISO+™)');
  await log('a', 'INV-0501 (Xero)', 'Xero');
  // Item c is marked INV-3, so its older log entry is stale.
  await log('c', 'INV-22');
  await PDFLink.create({
    workspaceId: WS, boardId: 'b1', itemId: 'd', type: 'NDIS Invoice', invoiceNumber: 'INV-5', invoiceTotal: 300,
    participant: 'Jane Smith', pdfLink: 'https://s3/5.pdf', createdAt: new Date('2026-07-02T00:00:00Z'),
  });
}

beforeEach(async () => {
  await seed();
  await buildInvoiceIndexes(mongoose.connection);
});

const run = (options = {}) => runBackfill({ workspaceIds: [WS], deriveTotalFor, ...options });

/** A real run as an operator does it: read the dry run, then apply the plan it showed. */
const apply = async (options = {}) => {
  const dry = await run();
  return run({
    apply: true, acks: { staleLegacy: 1 }, planHash: dry.planHash, ...options,
  });
};

describe('a dry run', () => {
  it('reports what it would create and writes nothing', async () => {
    const result = await run();

    expect(result.applied).toBe(false);
    expect(result.totals.created).toEqual({ ledger: 1, 'marker-only': 1, 'log-only': 1 });
    expect(await Invoice.countDocuments({})).toBe(0);
    expect(await PDFLink.countDocuments({ invoiceId: { $exists: true } })).toBe(0);
    expect(await Item.countDocuments({ activeInvoiceId: { $ne: null } })).toBe(0);
  });
});

describe('the real run', () => {
  it('refuses unless every category the plan found is acknowledged with its count', async () => {
    const dry = await run();
    expect(dry.totals.found).toEqual({ staleLegacy: 1 });

    const { planHash } = dry;
    await expect(run({ apply: true, planHash })).rejects.toThrow(AcknowledgementError);
    await expect(run({ apply: true, planHash, acks: { staleLegacy: 2 } })).rejects.toThrow(/staleLegacy/);
    expect(await Invoice.countDocuments({})).toBe(0);
  });

  it('creates the invoices, stamps the ledger rows, points the items and attaches the Xero number', async () => {
    const result = await apply();

    expect(result.applied).toBe(true);
    const invoices = await Invoice.find({}).lean();
    expect(invoices.map((i) => i.number).sort()).toEqual(['INV-24', 'INV-3', 'INV-5']);
    expect(invoices.every((i) => i.origin === 'backfill' && i.status === 'issued')).toBe(true);

    const five = invoices.find((i) => i.number === 'INV-5');
    expect(five).toMatchObject({ total: 300, totalDerived: false });
    expect((await PDFLink.findOne({ itemId: 'd' }).lean()).invoiceId.toString()).toBe(five._id.toString());

    const twentyFour = invoices.find((i) => i.number === 'INV-24');
    expect(twentyFour.xero).toEqual({ invoiceNumber: 'INV-0501' });
    expect(twentyFour.lines.map((l) => l.itemId).sort()).toEqual(['a', 'b']);
    expect(String((await Item.findOne({ itemId: 'a' }).lean()).activeInvoiceId)).toBe(String(twentyFour._id));
    expect(String((await Item.findOne({ itemId: 'c' }).lean()).activeInvoiceId)).toBe(String(invoices.find((i) => i.number === 'INV-3')._id));
  });

  it('a second run creates nothing and changes nothing', async () => {
    await apply();
    const before = JSON.stringify(await Invoice.find({}).sort({ number: 1 }).lean());

    const again = await apply();

    expect(again.totals.created).toEqual({});
    expect(await Invoice.countDocuments({})).toBe(3);
    expect(JSON.stringify(await Invoice.find({}).sort({ number: 1 }).lean())).toBe(before);
  });

  it('changes no old store: markers, the log and the ledger rows keep what they had', async () => {
    const markersBefore = (await Item.find({}).lean()).map((i) => [i.itemId, i.invoicedBy]);
    const logBefore = await InvoiceNumber.countDocuments({});
    await apply();

    expect((await Item.find({}).lean()).map((i) => [i.itemId, i.invoicedBy])).toEqual(markersBefore);
    expect(await InvoiceNumber.countDocuments({})).toBe(logBefore);
    expect((await PDFLink.findOne({ itemId: 'd' }).lean()).invoiceNumber).toBe('INV-5');
  });

  it('refuses to run without the unique number index, because a rerun could then duplicate', async () => {
    await Invoice.collection.dropIndexes();
    await expect(apply()).rejects.toThrow(/invoice-ledger-indexes/);
  });
});

describe('--undo', () => {
  it('removes only what the backfill created and what it stamped and pointed, and leaves live invoices alone', async () => {
    const live = await Invoice.create({
      workspaceId: WS, boardId: 'b1', number: 'INV-77', kind: 'ndis', participant: { name: 'Jane Smith' },
      lines: [{ itemId: 'z', amount: 5 }], total: 5, issuedAt: new Date('2026-09-01T00:00:00Z'), origin: 'live', trigger: 'manual',
    });
    await Item.create(item('z', { activeInvoiceId: live._id }));
    await apply();
    expect(await Invoice.countDocuments({})).toBe(4);

    const undone = await run({ undo: true, apply: true });

    expect(undone.undone).toMatchObject({ invoices: 3, stamped: 1, pointed: 4, skipped: [], preview: false });
    expect((await Invoice.find({}).lean()).map((i) => i.number)).toEqual(['INV-77']);
    expect((await PDFLink.findOne({ itemId: 'd' }).lean()).invoiceId).toBeUndefined();
    expect((await Item.findOne({ itemId: 'a' }).lean()).activeInvoiceId ?? null).toBeNull();
    expect(String((await Item.findOne({ itemId: 'z' }).lean()).activeInvoiceId)).toBe(String(live._id));
  });

  it('a backfill after an undo recreates the same invoices', async () => {
    await apply();
    await run({ undo: true, apply: true });
    await apply();
    expect(await Invoice.countDocuments({})).toBe(3);
  });
});

describe('acknowledgements', () => {
  const report = { lists: { doubleBilled: [{}, {}, {}], markerMissing: [], staleLegacy: [{}] } };

  it('lists the categories found, with their counts, that were not acknowledged', () => {
    expect(missingAcknowledgements(report, {})).toEqual([
      { category: 'doubleBilled', found: 3, acknowledged: undefined },
      { category: 'staleLegacy', found: 1, acknowledged: undefined },
    ]);
  });

  it('is satisfied by the exact count, and not by a different one', () => {
    expect(missingAcknowledgements(report, { doubleBilled: 3, staleLegacy: 1 })).toEqual([]);
    expect(missingAcknowledgements(report, { doubleBilled: 2, staleLegacy: 1 })).toEqual([
      { category: 'doubleBilled', found: 3, acknowledged: 2 },
    ]);
  });

  it('reads --ack values in kebab case', () => {
    expect(parseAcks(['double-billed=3', 'stale-legacy=1'])).toEqual({ doubleBilled: 3, staleLegacy: 1 });
    expect(() => parseAcks(['double-billed'])).toThrow(/category=count/);
    expect(() => parseAcks(['double-billed=x'])).toThrow(/category=count/);
  });
});

describe('review: the plan that is applied is the plan that was read', () => {
  it('a dry run gives a plan hash, and a real run refuses without it or with a different one', async () => {
    const dry = await run();
    expect(dry.planHash).toMatch(/^[0-9a-f]{12}$/);

    await expect(run({ apply: true, acks: { staleLegacy: 1 } })).rejects.toThrow(/--plan/);
    await expect(run({ apply: true, acks: { staleLegacy: 1 }, planHash: '000000000000' })).rejects.toThrow(/changed since the dry run/);
    expect(await Invoice.countDocuments({})).toBe(0);
  });

  it('refuses when the stores changed between the dry run and the apply', async () => {
    const dry = await run();
    await Item.updateOne({ itemId: 'c' }, { $unset: { invoicedBy: '' } });

    await expect(run({ apply: true, acks: { staleLegacy: 1 }, planHash: dry.planHash })).rejects.toThrow(/changed since the dry run/);
    expect(await Invoice.countDocuments({})).toBe(0);
  });

  it('writes nothing for any workspace when one workspace\'s plan holds a record that would be refused', async () => {
    await Item.create(item('w2a', { workspaceId: 'ws-run-2' }));
    await InvoiceNumber.create({ workspaceId: 'ws-run-2', boardId: 'b1', itemId: 'w2a', invoiceNumber: 'INV-50', type: 'PDF', pdfLink: 'https://s3/50.pdf' });
    // The second workspace derives a total that is not a number: its record fails the model validation.
    const badSecond = (scope) => (scope.workspaceId === 'ws-run-2'
      ? async ({ itemIds }) => ({ total: Number.NaN, perItem: Object.fromEntries(itemIds.map((id) => [id, 1])) })
      : deriveTotalFor(scope));
    const options = { workspaceIds: [WS, 'ws-run-2'], deriveTotalFor: badSecond };
    const dry = await runBackfill(options);

    await expect(runBackfill({
      ...options, apply: true, acks: { staleLegacy: 1 }, planHash: dry.planHash,
    })).rejects.toThrow(/validation/i);
    expect(await Invoice.countDocuments({})).toBe(0);
  });

  it('reports what was written for the workspaces already done when a later one fails', async () => {
    await Item.create(item('w2a', { workspaceId: 'ws-run-2' }));
    await Business.create({ workspaceId: 'ws-run-2', name: 'Biz 2' });
    await Board.create({ boardId: 'b1', workspaceId: 'ws-run-2', name: 'NDIS', label: 'Care Management NDIS 2026 Pricing' }).catch(() => {});
    await InvoiceNumber.create({ workspaceId: 'ws-run-2', boardId: 'b1', itemId: 'w2a', invoiceNumber: 'INV-50', type: 'PDF', pdfLink: 'https://s3/50.pdf' });
    const written = [];
    const options = {
      workspaceIds: [WS, 'ws-run-2'], deriveTotalFor, apply: true, acks: { staleLegacy: 1 },
    };
    const dry = await runBackfill({ ...options, apply: false });
    // The second workspace's invoice number is taken by a different live invoice that appears after the plan.
    let calls = 0;
    const result = runBackfill({
      ...options,
      planHash: dry.planHash,
      onWorkspaceApplied: async (done) => {
        written.push(done.workspaceId);
        calls += 1;
        if (calls === 1) await Invoice.create({ workspaceId: 'ws-run-2', boardId: 'b1', number: 'INV-50', kind: 'ndis', participant: { name: 'Someone Else' }, lines: [{ itemId: 'zz', amount: 1 }], total: 1, issuedAt: new Date(), trigger: 'manual', origin: 'live' });
      },
    });

    await expect(result).rejects.toMatchObject({ results: [expect.objectContaining({ workspaceId: WS })] });
    expect(written).toEqual([WS]);
  });
});

describe('review: undo previews, and leaves alone what live code has since changed', () => {
  it('without --apply it only says what it would remove', async () => {
    await apply();
    const preview = await run({ undo: true });

    expect(preview.undone).toMatchObject({ invoices: 3, preview: true });
    expect(await Invoice.countDocuments({})).toBe(3);
    expect(await Item.countDocuments({ activeInvoiceId: { $ne: null } })).toBe(4);
  });

  it('skips and lists a backfilled invoice that has been changed since it was created', async () => {
    await apply();
    const touched = await Invoice.findOne({ number: 'INV-5' });
    // Live code adopts it later: a Xero stamp, minutes after it was created.
    await Invoice.collection.updateOne(
      { _id: touched._id },
      { $set: { xero: { invoiceNumber: 'INV-0900' }, updatedAt: new Date(Date.now() + 60_000) } },
    );

    const undone = await run({ undo: true, apply: true });

    expect(undone.undone.skipped).toEqual([{ number: 'INV-5', reason: 'changed-since-created', workspaceId: WS }]);
    expect(undone.undone.invoices).toBe(2);
    expect(await Invoice.findOne({ number: 'INV-5' })).toBeTruthy();
    expect(String((await Item.findOne({ itemId: 'd' }).lean()).activeInvoiceId)).toBe(String(touched._id));
  });
});

describe('review: the apply refuses to take over a live invoice, and never overwrites a pointer that moved', () => {
  it('stops when the number it would create already belongs to a different invoice', async () => {
    const dry = await run();
    await Invoice.create({
      workspaceId: WS, boardId: 'b1', number: 'INV-24', kind: 'ndis', participant: { name: 'Someone Else' },
      lines: [{ itemId: 'zz', amount: 1 }], total: 1, issuedAt: new Date(), trigger: 'manual', origin: 'live',
    });

    await expect(run({ apply: true, acks: { staleLegacy: 1 }, planHash: dry.planHash })).rejects.toThrow(/changed since the dry run/);
  });

  it('applyPlan refuses to take over a live invoice that now holds a planned number', async () => {
    const { planned } = await run();
    await Invoice.create({
      workspaceId: WS, boardId: 'b1', number: 'INV-24', kind: 'ndis', participant: { name: 'Someone Else' },
      lines: [{ itemId: 'zz', amount: 1 }], total: 1, issuedAt: new Date(), trigger: 'manual', origin: 'live',
    });

    await expect(applyPlan(planned[0].plan, WS)).rejects.toThrow(/not the one this plan describes/);
    expect((await PDFLink.findOne({ itemId: 'd' }).lean()).invoiceId).toBeUndefined();
  });

  it('applyPlan leaves a pointer that moved after planning and counts it', async () => {
    const { planned } = await run();
    const live = new mongoose.Types.ObjectId();
    await Item.updateOne({ itemId: 'a' }, { $set: { activeInvoiceId: live } });

    const result = await applyPlan(planned[0].plan, WS);

    expect(String((await Item.findOne({ itemId: 'a' }).lean()).activeInvoiceId)).toBe(String(live));
    expect(result.pointerSkipped).toBe(1);
    expect(result.pointed).toBe(3);
  });
});
