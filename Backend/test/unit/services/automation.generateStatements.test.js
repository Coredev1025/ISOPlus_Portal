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
const SLOT = new Date('2026-08-14T05:09:00.000Z');
const TZ = 'Australia/Sydney';
const PERIOD = '20260814-1509';

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
    await Promise.all([
      Business.deleteMany({ workspaceId: WS }),
      Board.deleteMany({ boardId: BOARD }),
      Item.deleteMany({ workspaceId: WS }),
      PDFLink.deleteMany({ workspaceId: WS }),
    ]);
  });

  afterEach(async () => {
    process.env.ISOPLUS_OFFLINE = saved.ISOPLUS_OFFLINE;
    process.env.LOCAL_FILE_ROOT = saved.LOCAL_FILE_ROOT;
    rmSync(root, { recursive: true, force: true });
    await Promise.all([
      Business.deleteMany({ workspaceId: WS }),
      Board.deleteMany({ boardId: BOARD }),
      Item.deleteMany({ workspaceId: WS }),
      PDFLink.deleteMany({ workspaceId: WS }),
    ]);
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
});
