import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import Board from '../../../src/models/Board.js';
import Business from '../../../src/models/Business.js';
import Item from '../../../src/models/Item.js';
import PDFLink from '../../../src/models/PDFLink.js';
import { generateStatementsForBoard } from '../../../src/services/automation/generateStatements.js';

const WS = 'ws-stmt';
const BOARD = 'board-stmt';
const BOARD_2 = 'board-stmt-2';
const SLOT = new Date('2026-08-14T05:09:00.000Z');
const TZ = 'Australia/Sydney';
const PERIOD = '20260814-1509';

async function seedSecondBoard(participant) {
  await Board.create({
    workspaceId: WS, boardId: BOARD_2, name: 'Stmt Board 2', label: 'Care Management',
  });
  await Item.create({
    workspaceId: WS,
    boardId: BOARD_2,
    folderId: 'f-p',
    itemId: 'p2-1',
    data: { 'Full Name/Preferred Name': participant },
  });
}

async function seedWorkspace({ label, participants = ['Alex Rivers'] }) {
  await Business.create({
    workspaceId: WS,
    name: 'Stmt Biz',
    abn: '12 345 678 901',
    address: { street: '1 St', suburb: 'S', state: 'NSW', postcode: '2000', country: 'Australia' },
    bankDetails: { accountName: 'A', bankName: 'B', bsb: '123456', accountNumber: '1234567' },
    documentNumbering: {
      invoice: { prefix: 'IN-', nextNumber: 1 },
      quote: { prefix: 'QT-', nextNumber: 1 },
      purchaseOrder: { prefix: 'PO-', nextNumber: 1 },
    },
  });
  await Board.create({ workspaceId: WS, boardId: BOARD, name: 'Stmt Board', label });
  await Promise.all(participants.map((name, index) => Item.create({
    workspaceId: WS,
    boardId: BOARD,
    folderId: 'f-p',
    itemId: `p-${index + 1}`,
    data: { 'Full Name/Preferred Name': name },
  })));
}

describe('generateStatementsForBoard', () => {
  const saved = {};
  let root;

  beforeEach(async () => {
    saved.ISOPLUS_OFFLINE = process.env.ISOPLUS_OFFLINE;
    saved.LOCAL_FILE_ROOT = process.env.LOCAL_FILE_ROOT;
    process.env.ISOPLUS_OFFLINE = '1';
    root = mkdtempSync(join(tmpdir(), 'gen-stmt-'));
    process.env.LOCAL_FILE_ROOT = root;
  });

  afterEach(async () => {
    process.env.ISOPLUS_OFFLINE = saved.ISOPLUS_OFFLINE;
    process.env.LOCAL_FILE_ROOT = saved.LOCAL_FILE_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  it('no-ops on an NDIS-only board that is not Care Management', async () => {
    await seedWorkspace({ label: 'NDIS' });
    const results = await generateStatementsForBoard({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD,
    });
    expect(results).toEqual([]);
    expect(await PDFLink.countDocuments({ workspaceId: WS })).toBe(0);
  });

  it('no-ops on Care Management Low Cat', async () => {
    await seedWorkspace({ label: 'Care Management - SaH - Low Cat' });
    const results = await generateStatementsForBoard({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD,
    });
    expect(results).toEqual([]);
  });

  it('writes one Monthly Statement PDF per participant for the previous calendar month', async () => {
    await seedWorkspace({
      label: 'Care Management - NDIS',
      participants: ['Alex Rivers', 'Sam Lee'],
    });

    const results = await generateStatementsForBoard({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD,
    });

    expect(results).toHaveLength(2);
    for (const row of results) {
      expect(row.pdfUrl).toContain('monthly-statements/');
      const stored = join(root, decodeURIComponent(row.pdfUrl.split('/api/local-files/')[1]));
      expect(existsSync(stored)).toBe(true);
      expect(readFileSync(stored).subarray(0, 5).toString()).toBe('%PDF-');
    }

    const links = await PDFLink.find({ workspaceId: WS, type: 'Monthly Statement' }).lean();
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.periodKey === PERIOD)).toBe(true);
  });

  // Section 4.1: the statement period follows the configured cadence. The
  // budget statement is a calendar-month document — its template text, its
  // budget query and its quarter banner all say so — so a weekly schedule
  // produces no budget statement at all rather than restating the whole of
  // last month every week under a fresh statement number.
  it('writes no Monthly Statement for a period that is not a calendar month', async () => {
    await seedWorkspace({
      label: 'Care Management - NDIS',
      participants: ['Alex Rivers', 'Sam Lee'],
    });

    const results = await generateStatementsForBoard({
      workspaceId: WS,
      boardId: BOARD,
      slot: SLOT,
      timezone: TZ,
      periodKey: PERIOD,
      schedule: { every: { n: 1, unit: 'week' } },
    });

    expect(results.filter((row) => row.pdfUrl?.includes('monthly-statements/'))).toEqual([]);
    expect(await PDFLink.countDocuments({ workspaceId: WS, type: 'Monthly Statement' })).toBe(0);
    // And no statement number burned on a document that was never produced.
    const business = await Business.findOne({ workspaceId: WS }).lean();
    expect(business.documentNumbering.statement?.nextNumber ?? 1).toBe(1);
  });

  it('still writes the Monthly Statement on an explicitly monthly cadence', async () => {
    await seedWorkspace({ label: 'Care Management - NDIS' });

    await generateStatementsForBoard({
      workspaceId: WS,
      boardId: BOARD,
      slot: SLOT,
      timezone: TZ,
      periodKey: PERIOD,
      schedule: { every: { n: 1, unit: 'month' } },
    });

    expect(await PDFLink.countDocuments({ workspaceId: WS, type: 'Monthly Statement' })).toBe(1);
  });

  it('reuses existing participant PDFs and still generates the missing one', async () => {
    await seedWorkspace({
      label: 'Care Management',
      participants: ['Alex Rivers', 'Sam Lee'],
    });
    await PDFLink.create({
      workspaceId: WS,
      itemId: `statement:${BOARD}:Alex Rivers`,
      type: 'Monthly Statement',
      periodKey: PERIOD,
      pdfLink: 'https://example.test/alex.pdf',
      createdBy: '',
      isDeleted: false,
      SignatureStatus: 'Unsigned',
    });

    const results = await generateStatementsForBoard({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD,
    });

    expect(results).toHaveLength(2);
    const byItem = Object.fromEntries(results.map((row) => [row.itemId, row.pdfUrl]));
    expect(byItem[`statement:${BOARD}:Alex Rivers`]).toBe('https://example.test/alex.pdf');
    expect(byItem[`statement:${BOARD}:Sam Lee`]).toContain('monthly-statements/');
    expect(await PDFLink.countDocuments({ workspaceId: WS, type: 'Monthly Statement' })).toBe(2);
  });
  // The statement counter is `documentNumbering.statement` on Business, which
  // has existed unused since the model declared it. Without a number the email
  // spec's {{statement_number}} renders literally in a customer's inbox.
  it('allocates a statement number per participant and increments the counter once each', async () => {
    await seedWorkspace({
      label: 'Care Management',
      participants: ['Alex Rivers', 'Sam Lee'],
    });

    const results = await generateStatementsForBoard({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD,
    });

    expect(results.map((row) => row.statementNumber).sort()).toEqual(['STM-1', 'STM-2']);
    const business = await Business.findOne({ workspaceId: WS }).lean();
    expect(business.documentNumbering.statement.nextNumber).toBe(3);
    // Persisted on the PDFLink row so the replay below can hand the same
    // number back rather than minting a second one for the same statement.
    const links = await PDFLink.find({ workspaceId: WS, type: 'Monthly Statement' }).lean();
    expect(links.map((link) => link.invoiceNumber).sort()).toEqual(['STM-1', 'STM-2']);
  });

  // A replayed slot must be inert. Re-minting would both burn a number and put
  // a different number in the second email for a PDF the customer already has.
  it('returns the already-allocated number on a replayed slot without re-minting', async () => {
    await seedWorkspace({ label: 'Care Management' });
    await PDFLink.create({
      workspaceId: WS,
      itemId: `statement:${BOARD}:Alex Rivers`,
      type: 'Monthly Statement',
      periodKey: PERIOD,
      pdfLink: 'https://example.test/alex.pdf',
      invoiceNumber: 'STM-77',
      createdBy: '',
      isDeleted: false,
      SignatureStatus: 'Unsigned',
    });

    const results = await generateStatementsForBoard({
      workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD,
    });

    expect(results).toEqual([{
      itemId: `statement:${BOARD}:Alex Rivers`,
      participant: 'Alex Rivers',
      pdfUrl: 'https://example.test/alex.pdf',
      statementNumber: 'STM-77',
    }]);
    const business = await Business.findOne({ workspaceId: WS }).lean();
    expect(business.documentNumbering.statement.nextNumber).toBe(1);
    expect(await PDFLink.countDocuments({ workspaceId: WS, type: 'Monthly Statement' })).toBe(1);
  });

  // Production runs several Elastic Beanstalk instances pulling one automation
  // queue, so two boards in the same workspace generate at the same moment
  // routinely. Read nextNumber, render a PDF, then write nextNumber + 1 back is
  // a lost update across the awaits: both runs read 1, both mint 'STM-1'
  // for different participants, and the counter ends on 2 rather than 3.
  it('never mints the same statement number for two concurrent boards', async () => {
    await seedWorkspace({ label: 'Care Management' });
    await seedSecondBoard('Sam Lee');

    const [first, second] = await Promise.all([
      generateStatementsForBoard({
        workspaceId: WS, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD,
      }),
      generateStatementsForBoard({
        workspaceId: WS, boardId: BOARD_2, slot: SLOT, timezone: TZ, periodKey: PERIOD,
      }),
    ]);

    expect([first[0].statementNumber, second[0].statementNumber].sort())
      .toEqual(['STM-1', 'STM-2']);
    const business = await Business.findOne({ workspaceId: WS }).lean();
    expect(business.documentNumbering.statement.nextNumber).toBe(3);
  });
});
