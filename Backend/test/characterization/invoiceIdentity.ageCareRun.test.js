import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import Board from '../../src/models/Board.js';
import Business from '../../src/models/Business.js';
import Item from '../../src/models/Item.js';
import InvoiceNumber from '../../src/models/InvoiceNumber.js';
import PDFLink from '../../src/models/PDFLink.js';
import { invalidateCacheForWorkspace } from '../../src/utils/transformCache.js';

vi.mock('../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

const { generateInvoicesForBoard } = await import('../../src/services/automation/generateDocuments.js');
const { warn } = await import('../../src/utils/logger.js');

/**
 * KAN-303. Scheduled invoice runs TODAY, end to end through the real generators in
 * offline mode, on the committed Care Management fixture (workspace 55390). No
 * earlier test ran the Age Care path past an empty period. Recorded ahead of
 * KAN-302; see docs/superpowers/specs/2026-10-04-invoice-source-of-truth-design.md.
 *
 *   marker = Item.invoicedBy    log = InvoiceNumber    ledger = PDFLink
 *
 * Boards, from the fixture: jpjztrn14pJ is the Age Care (SaH) board, o24sGM1FoST an
 * NDIS board on legacy pricing, dwV23F5WcQL an NDIS board on 2026 pricing. The fixture
 * numbers invoices from INV-1004.
 */

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/care-management-automation.json', import.meta.url), 'utf8',
));
const WS = fixture.business.workspaceId;
const SAH = 'jpjztrn14pJ';
const NDIS_LEGACY = 'o24sGM1FoST';
const NDIS_2026 = 'dwV23F5WcQL';
const TZ = 'Australia/Sydney';
const SLOT = new Date('2025-01-31T22:00:00Z');
const PERIOD_KEY = '20250201-0900';
const MONTHLY = { every: { n: 1, unit: 'month' } };

const SKELETON_DECOY = '55390000-eeee-4001-8001-000000000001';
const ZERO_DECOY = '55390000-eeee-4002-8002-000000000001';
const JANES_BILLABLE = '55390000-aaaa-4003-8003-000000000001';

const saved = {};
let root;

const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('$')));

const run = (boardId = SAH) => generateInvoicesForBoard({
  workspaceId: WS, boardId, slot: SLOT, timezone: TZ, periodKey: PERIOD_KEY, schedule: MONTHLY,
});

const markerByItem = async (boardId = SAH) => Object.fromEntries(
  (await Item.find({ workspaceId: WS, boardId }).lean())
    .filter((i) => i.invoicedBy).map((i) => [i.itemId, i.invoicedBy]),
);

/** One entry per invoice: participant, number, billed total, how many items it carries. */
const summary = (results) => results
  .map((r) => [r.participant, r.invoiceNumber])
  .sort((a, b) => a[1].localeCompare(b[1]));

const ledgerTotals = async (boardId) => {
  const rows = await PDFLink.find({ workspaceId: WS, boardId }).lean();
  return Object.fromEntries([...new Map(rows.map((r) => [r.invoiceNumber, r.invoiceTotal]))]);
};

const savedWriteFlag = process.env.INVOICE_LEDGER_WRITE;

beforeEach(async () => {
  // These pin the flag-off behaviour whatever Backend/.env says.
  delete process.env.INVOICE_LEDGER_WRITE;
  saved.offline = process.env.ISOPLUS_OFFLINE;
  saved.root = process.env.LOCAL_FILE_ROOT;
  process.env.ISOPLUS_OFFLINE = '1';
  root = mkdtempSync(join(tmpdir(), 'age-care-run-'));
  process.env.LOCAL_FILE_ROOT = root;
  vi.clearAllMocks();
  // The list helper caches transformed rows per item for the process; start clean.
  invalidateCacheForWorkspace(WS);

  const { defaultLogo, featureToggles, ...business } = clean(fixture.business);
  await Business.create(business);
  for (const board of fixture.boards) await Board.create(clean(board));
  await Item.insertMany(fixture.items.map((i) => ({ ...clean(i), workspaceId: WS })));
});

afterEach(() => {
  if (savedWriteFlag === undefined) delete process.env.INVOICE_LEDGER_WRITE; else process.env.INVOICE_LEDGER_WRITE = savedWriteFlag;
  vi.restoreAllMocks();
  if (saved.offline === undefined) delete process.env.ISOPLUS_OFFLINE; else process.env.ISOPLUS_OFFLINE = saved.offline;
  if (saved.root === undefined) delete process.env.LOCAL_FILE_ROOT; else process.env.LOCAL_FILE_ROOT = saved.root;
  rmSync(root, { recursive: true, force: true });
});

describe('a scheduled Age Care run records the invoice in all three places', () => {
  it('produces one invoice per participant profile, numbered in order from the counter', async () => {
    const results = await run();
    expect(summary(results)).toEqual([['Jane Smith', 'INV-1004'], ['David Brown', 'INV-1005']]);
  });

  it('marks every billed item with its invoice number, and the log and the ledger agree', async () => {
    await run();
    const marker = await markerByItem();
    const log = Object.fromEntries((await InvoiceNumber.find({ workspaceId: WS, type: 'PDF' }).lean())
      .map((r) => [r.itemId, r.invoiceNumber]));
    const ledger = Object.fromEntries((await PDFLink.find({ workspaceId: WS }).lean())
      .map((r) => [r.itemId, r.invoiceNumber]));

    const billed = Object.keys(marker);
    expect(billed).toHaveLength(7);
    expect(Object.keys(log).sort()).toEqual([...billed].sort());
    expect(Object.keys(ledger).sort()).toEqual([...billed].sort());
    billed.forEach((id) => {
      expect(log[id]).toBe(marker[id]);
      expect(ledger[id]).toBe(marker[id]);
    });
  });

  it('records the participant contribution as the billed total on a standard Age Care board', async () => {
    await run();
    expect(await ledgerTotals(SAH)).toEqual({ 'INV-1004': 279.85, 'INV-1005': 3.75 });
  });

  it('types each ledger row Participant Tax Invoice and stamps the period', async () => {
    await run();
    const rows = await PDFLink.find({ workspaceId: WS }).lean();
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((row) => {
      expect(row.type).toBe('Participant Tax Invoice');
      expect(row.periodKey).toBe(PERIOD_KEY);
    });
  });

  it('writes the plain invoice number, with no suffix (KAN-294)', async () => {
    await run();
    Object.values(await markerByItem()).forEach((m) => expect(m).not.toMatch(/ISO\+/));
  });
});

describe('the billed total depends on the board: Low Cat bills the full amount (design case m)', () => {
  it('records the full service amount on a Low Cat board, not the participant contribution', async () => {
    await Board.updateOne({ boardId: SAH }, { $set: { label: 'Care Management - SaH - Low Cat' } });

    await run();

    expect(await ledgerTotals(SAH)).toEqual({ 'INV-1004': 5559.5, 'INV-1005': 75 });
  });
});

describe('NDIS boards on legacy and on 2026 pricing (design case n)', () => {
  it('bills the legacy-pricing board and marks its items, with log and ledger agreeing', async () => {
    const results = await run(NDIS_LEGACY);

    expect(summary(results)).toEqual([['David Smith', 'INV-1004'], ['Martin Space', 'INV-1005']]);
    expect(await ledgerTotals(NDIS_LEGACY)).toEqual({ 'INV-1004': 577.5, 'INV-1005': 240 });
    const marker = await markerByItem(NDIS_LEGACY);
    expect(Object.keys(marker)).toHaveLength(3);
    const log = await InvoiceNumber.find({ workspaceId: WS, boardId: NDIS_LEGACY, type: 'PDF' }).lean();
    log.forEach((row) => expect(row.invoiceNumber).toBe(marker[row.itemId]));
  });

  it('bills the 2026-pricing board the same way, with a different price rule', async () => {
    const results = await run(NDIS_2026);

    expect(summary(results)).toEqual([['Mike Bird', 'INV-1004']]);
    expect(await ledgerTotals(NDIS_2026)).toEqual({ 'INV-1004': 395 });
    expect(Object.keys(await markerByItem(NDIS_2026)).length).toBeGreaterThan(0);
  });
});

describe('rows the Age Care run does not bill on their own', () => {
  it('leaves the item with no participant profile unbilled and logs it (KAN-293)', async () => {
    await run();
    expect((await markerByItem())[SKELETON_DECOY]).toBeUndefined();
    expect(warn.mock.calls.some(([, message]) => /no Participant Profile/i.test(message))).toBe(true);
  });

  it('KNOWN GAP: marks a zero-value row with the invoice of a participant who has other billable items', async () => {
    // The zero-value decoy has a real profile and a total of 0. It is grouped into that
    // participant's invoice and marked invoiced with it. Pinned as it is today; the
    // design does not change it, and a zero-value row on a real invoice is harmless to
    // the total but is worth knowing about.
    await run();
    const marker = await markerByItem();
    expect(marker[ZERO_DECOY]).toBeDefined();
    expect(marker[ZERO_DECOY]).toBe(marker[JANES_BILLABLE]);
  });
});

describe('running the same period again', () => {
  it('does not bill again, and returns the documents the slot already produced', async () => {
    const first = await run();
    const markersBefore = await markerByItem();
    const ledgerBefore = await PDFLink.countDocuments({ workspaceId: WS });

    const second = await run();

    expect(summary(second)).toEqual(summary(first));
    expect(await markerByItem()).toEqual(markersBefore);
    expect(await PDFLink.countDocuments({ workspaceId: WS })).toBe(ledgerBefore);
  });

  it('skips an item the log already holds even when its marker and ledger rows are gone (the Age Care list guard)', async () => {
    await run();
    await Item.updateMany({ workspaceId: WS, boardId: SAH }, { $unset: { invoicedBy: '' } });
    await PDFLink.deleteMany({ workspaceId: WS });

    const results = await run();

    expect(results).toEqual([]);
    expect(Object.keys(await markerByItem())).toEqual([]);
  });
});
