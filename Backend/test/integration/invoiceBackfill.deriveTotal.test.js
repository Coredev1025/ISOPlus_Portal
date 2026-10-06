import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import Board from '../../src/models/Board.js';
import Business from '../../src/models/Business.js';
import Item from '../../src/models/Item.js';
import PDFLink from '../../src/models/PDFLink.js';
import { invalidateCacheForWorkspace } from '../../src/utils/transformCache.js';

vi.mock('../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

const { generateInvoicesForBoard } = await import('../../src/services/automation/generateDocuments.js');
const { blockPricingNetwork } = await import('../../src/utils/ndisPricingRules.js');
const { makeDeriveTotal } = await import('../../src/utils/invoiceLedger/backfill/deriveTotal.js');

/**
 * KAN-311: the backfill derives a total (and what each item contributed) when no document
 * total exists. It must give exactly what the real generators printed, per kind, so each
 * case here generates real invoices on the Care Management fixture (workspace 55390), reads
 * back what the ledger says they billed, and derives the same invoice from its items alone.
 */

const fixture = JSON.parse(readFileSync(new URL('../fixtures/care-management-automation.json', import.meta.url), 'utf8'));
const WS = fixture.business.workspaceId;
const SAH = 'jpjztrn14pJ';
const NDIS_LEGACY = 'o24sGM1FoST';
const NDIS_2026 = 'dwV23F5WcQL';
const SLOT = new Date('2025-01-31T22:00:00Z');
const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('$')));

const saved = {};
let root;

beforeEach(async () => {
  saved.write = process.env.INVOICE_LEDGER_WRITE;
  delete process.env.INVOICE_LEDGER_WRITE;
  saved.offline = process.env.ISOPLUS_OFFLINE;
  saved.root = process.env.LOCAL_FILE_ROOT;
  process.env.ISOPLUS_OFFLINE = '1';
  root = mkdtempSync(join(tmpdir(), 'backfill-derive-'));
  process.env.LOCAL_FILE_ROOT = root;
  vi.clearAllMocks();
  invalidateCacheForWorkspace(WS);
  const { defaultLogo, featureToggles, ...business } = clean(fixture.business);
  await Business.create(business);
  for (const board of fixture.boards) await Board.create(clean(board));
  await Item.insertMany(fixture.items.map((i) => ({ ...clean(i), workspaceId: WS })));
});

afterEach(() => {
  if (saved.write === undefined) delete process.env.INVOICE_LEDGER_WRITE; else process.env.INVOICE_LEDGER_WRITE = saved.write;
  vi.restoreAllMocks();
  if (saved.offline === undefined) delete process.env.ISOPLUS_OFFLINE; else process.env.ISOPLUS_OFFLINE = saved.offline;
  if (saved.root === undefined) delete process.env.LOCAL_FILE_ROOT; else process.env.LOCAL_FILE_ROOT = saved.root;
  rmSync(root, { recursive: true, force: true });
});

const generate = (boardId) => generateInvoicesForBoard({
  workspaceId: WS, boardId, slot: SLOT, timezone: 'Australia/Sydney', periodKey: '20250201-0900', schedule: { every: { n: 1, unit: 'month' } },
});

/** What each generated invoice billed, with the items it covers, from the ledger. */
async function billedInvoices(boardId) {
  const rows = await PDFLink.find({ workspaceId: WS, boardId }).lean();
  const byNumber = new Map();
  for (const row of rows) {
    const entry = byNumber.get(row.invoiceNumber) || { number: row.invoiceNumber, total: row.invoiceTotal, itemIds: [] };
    entry.itemIds.push(row.itemId);
    byNumber.set(row.invoiceNumber, entry);
  }
  return [...byNumber.values()];
}

const derive = (boardId, kind, lowCat, itemIds) => makeDeriveTotal({ workspaceId: WS, timezone: 'Australia/Sydney' })({
  boardId, kind, lowCat, itemIds,
});
const sum = (perItem) => Math.round(Object.values(perItem).reduce((a, b) => a + b, 0) * 100) / 100;

describe('the derived total equals what the generator printed', () => {
  it('NDIS on legacy pricing', async () => {
    await generate(NDIS_LEGACY);
    const invoices = await billedInvoices(NDIS_LEGACY);
    expect(invoices.map((i) => i.total).sort()).toEqual([240, 577.5]);
    for (const inv of invoices) {
      const derived = await derive(NDIS_LEGACY, 'ndis', undefined, inv.itemIds);
      expect(derived.total).toBe(inv.total);
      expect(sum(derived.perItem)).toBe(inv.total);
      expect(Object.keys(derived.perItem).sort()).toEqual([...new Set(inv.itemIds)].sort());
    }
  });

  it('NDIS items of several participants priced together (one logged number shared by participants)', async () => {
    await generate(NDIS_LEGACY);
    const invoices = await billedInvoices(NDIS_LEGACY);
    const everyItem = invoices.flatMap((i) => i.itemIds);
    const derived = await derive(NDIS_LEGACY, 'ndis', undefined, everyItem);

    expect(derived.error).toBeUndefined();
    expect(derived.total).toBe(817.5);
    expect(sum(derived.perItem)).toBe(817.5);
  });

  it('says so when an NDIS item has no participant profile reference, instead of guessing an amount', async () => {
    await generate(NDIS_LEGACY);
    const [inv] = await billedInvoices(NDIS_LEGACY);
    await Item.updateOne({ workspaceId: WS, itemId: inv.itemIds[0] }, { $set: { 'data.Participant Profile': [] } });
    const derived = await derive(NDIS_LEGACY, 'ndis', undefined, inv.itemIds);
    expect(derived.error).toMatch(/no participant profile reference/);
  });

  it('NDIS on 2026 pricing', async () => {
    await generate(NDIS_2026);
    const [inv] = await billedInvoices(NDIS_2026);
    expect(inv.total).toBe(395);
    expect((await derive(NDIS_2026, 'ndis', undefined, inv.itemIds)).total).toBe(395);
  });

  it('Age Care bills the participant contribution on a standard board', async () => {
    await generate(SAH);
    const invoices = await billedInvoices(SAH);
    expect(invoices.map((i) => i.total).sort((a, b) => a - b)).toEqual([3.75, 279.85]);
    for (const inv of invoices) {
      const derived = await derive(SAH, 'age_care', false, inv.itemIds);
      expect(derived.total).toBe(inv.total);
      expect(sum(derived.perItem)).toBe(inv.total);
    }
  });

  it('Age Care bills the full amount on a Low Cat board', async () => {
    await Board.updateOne({ boardId: SAH }, { $set: { label: 'Care Management - SaH - Low Cat' } });
    await generate(SAH);
    const invoices = await billedInvoices(SAH);
    expect(invoices.map((i) => i.total).sort((a, b) => a - b)).toEqual([75, 5559.5]);
    for (const inv of invoices) {
      expect((await derive(SAH, 'age_care', true, inv.itemIds)).total).toBe(inv.total);
    }
  });
});

describe('the backfill never calls ISO+ to price an invoice', () => {
  afterEach(() => blockPricingNetwork(false));

  it('prices from the service plan data when the pricing rule can be read from it, with the network blocked', async () => {
    blockPricingNetwork(true);
    await generate(NDIS_LEGACY);
    const [inv] = await billedInvoices(NDIS_LEGACY);
    expect((await derive(NDIS_LEGACY, 'ndis', undefined, inv.itemIds)).total).toBe(inv.total);
  });

  it('says the rule cannot be inferred, rather than calling ISO+ or assuming legacy pricing', async () => {
    await generate(NDIS_2026);
    const [inv] = await billedInvoices(NDIS_2026);
    // Strip the keys the rule is inferred from, from every service plan on the board.
    await Item.updateMany({ workspaceId: WS }, { $unset: { 'data.Direct Support Item Number': '', 'data.Support Item Number': '' } });
    blockPricingNetwork(true);
    const derived = await derive(NDIS_2026, 'ndis', undefined, inv.itemIds);
    // Without the guard the unhandled ISO+ request would fail this test (the mock server refuses it).
    expect(derived.error).toMatch(/pricing rule/i);
  });
});

describe('what it does when it cannot derive', () => {
  it('says the items are gone, for Age Care items that no longer exist', async () => {
    expect(await derive(SAH, 'age_care', false, ['gone-1', 'gone-2'])).toEqual({ error: 'items not found: 2 of 2' });
  });

  it('returns the reason rather than throwing when the NDIS items cannot be priced', async () => {
    const result = await derive(NDIS_LEGACY, 'ndis', undefined, ['not-an-item']);
    expect(result.error).toMatch(/not found/);
  });

  it('keeps a known total and still returns the amounts', async () => {
    await generate(SAH);
    const [inv] = await billedInvoices(SAH);
    const derived = await makeDeriveTotal({ workspaceId: WS, timezone: 'Australia/Sydney' })({
      boardId: SAH, kind: 'age_care', lowCat: false, itemIds: inv.itemIds, knownTotal: 1234.5,
    });
    expect(derived.total).toBe(1234.5);
    expect(Object.keys(derived.perItem).length).toBeGreaterThan(0);
  });
});
