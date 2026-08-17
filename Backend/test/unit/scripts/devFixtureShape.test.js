import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { normalizeFixture, stripDollarKeys } from '../../../scripts/devFixtureShape.mjs';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ndisFixture = JSON.parse(
  readFileSync(join(backendRoot, 'test', 'fixtures', 'ndis-quote-board.json'), 'utf8'),
);

const twoBoards = () => ({
  business: { workspaceId: 'ws-1', name: 'Two Board Co' },
  boards: [
    { boardId: 'board-a', workspaceId: 'ws-1', name: 'Board A' },
    { boardId: 'board-b', workspaceId: 'ws-1', name: 'Board B' },
  ],
});

describe('normalizeFixture', () => {
  describe('singular-board back-compat (ndis-quote-board.json)', () => {
    it('normalizes the shipped fixture to one board with every item assigned to it', () => {
      const shape = normalizeFixture(ndisFixture);

      expect(shape.workspaceId).toBe('55369');
      expect(shape.business.name).toBe('Local Fixture Care Services');
      expect(shape.boards).toHaveLength(1);
      expect(shape.boards[0].boardId).toBe('eNiJpH14PN3');
      expect(shape.items).toHaveLength(ndisFixture.items.length);
      for (const item of shape.items) {
        expect(item.boardId).toBe('eNiJpH14PN3');
        expect(item.workspaceId).toBe('55369');
        expect(item.isoPlusItemId).toBe(item.itemId);
      }
      // folderId and data pass through untouched, matching today's loader.
      const ref = shape.items.find((i) => i.itemId === 'fixture-ref-service-area');
      expect(ref.folderId).toBe('fixture-folder-reference-data');
      expect(ref.data).toEqual({ 'Service Area': 'Non-Remote (NSW)' });
    });

    it('yields empty defaults for the optional automation sections', () => {
      const shape = normalizeFixture(ndisFixture);
      expect(shape.automationSettings).toBeNull();
      expect(shape.scheduledJobs).toEqual([]);
    });
  });

  describe('multi-board fixtures', () => {
    it('assigns each item to its declared board', () => {
      const shape = normalizeFixture({
        ...twoBoards(),
        items: [
          { itemId: 'i-1', boardId: 'board-a', folderId: 'f-1', data: {} },
          { itemId: 'i-2', boardId: 'board-b', folderId: 'f-2', data: {} },
        ],
      });
      expect(shape.items.map((i) => i.boardId)).toEqual(['board-a', 'board-b']);
    });

    it('rejects an item with no boardId when the fixture has multiple boards', () => {
      expect(() => normalizeFixture({
        ...twoBoards(),
        items: [{ itemId: 'i-1', folderId: 'f-1', data: {} }],
      })).toThrow(/item "i-1".*boardId/);
    });

    it('rejects an item whose boardId matches none of the fixture boards', () => {
      expect(() => normalizeFixture({
        ...twoBoards(),
        items: [{ itemId: 'i-1', boardId: 'board-nope', folderId: 'f-1', data: {} }],
      })).toThrow(/item "i-1".*"board-nope"/);
    });
  });

  describe('validation', () => {
    it('rejects a fixture with no board at all', () => {
      expect(() => normalizeFixture({ business: { workspaceId: 'ws-1', name: 'X' } }))
        .toThrow(/at least one board/);
    });

    it('rejects a board without a boardId', () => {
      expect(() => normalizeFixture({
        business: { workspaceId: 'ws-1', name: 'X' },
        boards: [{ name: 'No Id' }],
      })).toThrow(/boardId/);
    });

    it('falls back to boards[0].workspaceId when business has none', () => {
      const shape = normalizeFixture({
        boards: [{ boardId: 'board-a', workspaceId: 'ws-9' }],
      });
      expect(shape.workspaceId).toBe('ws-9');
    });

    it('rejects a fixture with no workspaceId anywhere', () => {
      expect(() => normalizeFixture({ boards: [{ boardId: 'board-a' }] }))
        .toThrow(/workspaceId/);
    });
  });

  describe('scheduledJobs', () => {
    const base = () => ({
      ...twoBoards(),
      scheduledJobs: [
        {
          kind: 'invoice_issuance',
          targetId: 'ws-1',
          workspaceId: 'ws-1',
          cron: null,
          schedule: {
            every: { n: 1, unit: 'month' },
            runOn: 1,
            runAt: '09:00',
            startDate: '2026-08-01T00:00:00.000Z',
          },
          nextRunAt: '2026-09-01T23:00:00.000Z',
        },
      ],
    });

    it('coerces nextRunAt and schedule.startDate ISO strings to Date', () => {
      const [job] = normalizeFixture(base()).scheduledJobs;
      expect(job.nextRunAt).toBeInstanceOf(Date);
      expect(job.nextRunAt.toISOString()).toBe('2026-09-01T23:00:00.000Z');
      expect(job.schedule.startDate).toBeInstanceOf(Date);
      expect(job.schedule.startDate.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    });

    it('leaves an absent schedule.startDate alone', () => {
      const fixture = base();
      delete fixture.scheduledJobs[0].schedule.startDate;
      const [job] = normalizeFixture(fixture).scheduledJobs;
      expect(job.schedule.startDate).toBeUndefined();
    });

    it('rejects a job missing kind or targetId', () => {
      const fixture = base();
      delete fixture.scheduledJobs[0].targetId;
      expect(() => normalizeFixture(fixture)).toThrow(/kind.*targetId|targetId/);
    });
  });

  describe('invoiceNumbers', () => {
    it('defaults workspaceId to the fixture workspaceId and type to PDF', () => {
      const shape = normalizeFixture({
        ...twoBoards(),
        invoiceNumbers: [
          { itemId: 'i-1', boardId: 'board-a', invoiceNumber: 'INV-0001' },
        ],
      });
      expect(shape.invoiceNumbers).toEqual([
        { itemId: 'i-1', boardId: 'board-a', invoiceNumber: 'INV-0001', workspaceId: 'ws-1', type: 'PDF' },
      ]);
    });

    it('keeps a declared type and passes pdfLink through', () => {
      const [entry] = normalizeFixture({
        ...twoBoards(),
        invoiceNumbers: [
          {
            itemId: 'i-1',
            boardId: 'board-b',
            invoiceNumber: 'INV-0002',
            type: 'Xero',
            pdfLink: 'https://example.com/inv.pdf',
          },
        ],
      }).invoiceNumbers;
      expect(entry.type).toBe('Xero');
      expect(entry.pdfLink).toBe('https://example.com/inv.pdf');
    });

    it('rejects an entry missing itemId, boardId or invoiceNumber', () => {
      expect(() => normalizeFixture({
        ...twoBoards(),
        invoiceNumbers: [{ itemId: 'i-1', boardId: 'board-a' }],
      })).toThrow(/invoiceNumbers.*itemId.*boardId.*invoiceNumber/);
    });

    it('rejects an entry whose boardId matches none of the fixture boards', () => {
      expect(() => normalizeFixture({
        ...twoBoards(),
        invoiceNumbers: [
          { itemId: 'i-1', boardId: 'board-nope', invoiceNumber: 'INV-0003' },
        ],
      })).toThrow(/invoiceNumbers.*"i-1".*"board-nope"/);
    });

    it('normalizes an absent section to an empty array', () => {
      const shape = normalizeFixture(twoBoards());
      expect(shape.invoiceNumbers).toEqual([]);
    });

    it('leaves existing fixtures without the section otherwise unchanged (back-compat)', () => {
      const shape = normalizeFixture(ndisFixture);
      expect(shape.invoiceNumbers).toEqual([]);
      expect(shape.workspaceId).toBe('55369');
      expect(shape.boards).toHaveLength(1);
      expect(shape.items).toHaveLength(ndisFixture.items.length);
      expect(shape.automationSettings).toBeNull();
      expect(shape.scheduledJobs).toEqual([]);
    });
  });

  describe('automationSettings', () => {
    it('passes the section through when declared', () => {
      const shape = normalizeFixture({
        ...twoBoards(),
        automationSettings: { workspaceId: 'ws-1', invoice: { enabled: true } },
      });
      expect(shape.automationSettings).toEqual({ workspaceId: 'ws-1', invoice: { enabled: true } });
    });
  });
});

describe('stripDollarKeys', () => {
  it('drops $-prefixed annotation keys and keeps the rest', () => {
    expect(stripDollarKeys({ $case: 'note', itemId: 'i-1', data: { $x: 1 } }))
      .toEqual({ itemId: 'i-1', data: { $x: 1 } });
  });
});
