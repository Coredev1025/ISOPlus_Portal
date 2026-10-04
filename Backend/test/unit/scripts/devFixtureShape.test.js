import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import {
  normalizeFixture,
  stripDollarKeys,
  isLocalMongoUri,
  isGeneratorFixturePath,
  fixtureFromModule,
} from '../../../scripts/devFixtureShape.mjs';
import {
  buildStatementPermutationsFixture,
} from '../../fixtures/generators/statementPermutations.mjs';

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

  describe('invoices (ledger)', () => {
    const entry = (over = {}) => ({
      boardId: 'board-a',
      number: 'INV-0001',
      lines: [{ itemId: 'i-1', amount: 100 }],
      total: 100,
      ...over,
    });

    it('defaults the ledger fields and pins the workspace to the fixture', () => {
      const [inv] = normalizeFixture({
        ...twoBoards(),
        invoices: [entry({ workspaceId: 'ws-somewhere-else' })],
      }).invoices;
      expect(inv).toMatchObject({
        workspaceId: 'ws-1',
        boardId: 'board-a',
        number: 'INV-0001',
        source: 'portal',
        kind: 'ndis',
        status: 'issued',
        origin: 'live',
        duplicateOrdinal: 0,
        legacyNumbers: [],
      });
    });

    it('keeps declared values', () => {
      const [inv] = normalizeFixture({
        ...twoBoards(),
        invoices: [entry({ kind: 'age_care', source: 'xero', legacyNumbers: ['INV-0001 (Xero)'] })],
      }).invoices;
      expect(inv).toMatchObject({ kind: 'age_care', source: 'xero', legacyNumbers: ['INV-0001 (Xero)'] });
    });

    it('is empty when the fixture declares none', () => {
      expect(normalizeFixture(twoBoards()).invoices).toEqual([]);
    });

    it('rejects an entry missing boardId, number or lines', () => {
      expect(() => normalizeFixture({
        ...twoBoards(),
        invoices: [{ boardId: 'board-a', number: 'INV-1' }],
      })).toThrow(/invoices.*boardId.*number.*lines/);
    });

    it('rejects a line without an itemId', () => {
      expect(() => normalizeFixture({
        ...twoBoards(),
        invoices: [entry({ lines: [{ amount: 5 }] })],
      })).toThrow(/itemId/);
    });

    it('rejects a boardId that is not one of the fixture boards', () => {
      expect(() => normalizeFixture({
        ...twoBoards(),
        invoices: [entry({ boardId: 'nope' })],
      })).toThrow(/board-a|boards/);
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

    it('pins workspaceId to the fixture, ignoring one declared on the entry', () => {
      // The entry used to be spread last, so its own workspaceId won on the
      // write while --remove still deleted by the fixture's — the row was
      // written into another workspace and then never cleaned up.
      const [entry] = normalizeFixture({
        ...twoBoards(),
        invoiceNumbers: [
          {
            itemId: 'i-1',
            boardId: 'board-a',
            invoiceNumber: 'INV-0004',
            workspaceId: 'ws-somewhere-else',
          },
        ],
      }).invoiceNumbers;
      expect(entry.workspaceId).toBe('ws-1');
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

describe('isLocalMongoUri', () => {
  // The loader writes invented business and participant records, so it refuses
  // any non-local database and promises there is no override flag. The guard
  // that promise rested on was an unanchored substring match, which two
  // ordinary-looking URIs walked straight past.
  it('accepts the local hosts the dev stack uses', () => {
    expect(isLocalMongoUri('mongodb://localhost:27017/business-dashboard')).toBe(true);
    expect(isLocalMongoUri('mongodb://127.0.0.1:27017/business-dashboard')).toBe(true);
    expect(isLocalMongoUri('mongodb://mongo:27017/business-dashboard')).toBe(true);
    expect(isLocalMongoUri('mongodb://user:pw@localhost:27017/db?replicaSet=rs0')).toBe(true);
    expect(isLocalMongoUri('mongodb://[::1]:27017/db')).toBe(true);
  });

  it('rejects a multi-host URI where only the first host is local', () => {
    expect(isLocalMongoUri('mongodb://mongo:27017,prod.example.com:27017/db')).toBe(false);
  });

  it('rejects a remote host wearing a local-looking username', () => {
    expect(isLocalMongoUri('mongodb://localhost:pw@prod.example.com/')).toBe(false);
  });

  it('rejects an Atlas SRV URI', () => {
    expect(isLocalMongoUri('mongodb+srv://user:pw@cluster0.abc.mongodb.net/db')).toBe(false);
  });

  it('rejects anything it cannot parse rather than assuming it is local', () => {
    expect(isLocalMongoUri('')).toBe(false);
    expect(isLocalMongoUri('not-a-uri')).toBe(false);
    expect(isLocalMongoUri('mongodb://')).toBe(false);
    expect(isLocalMongoUri(undefined)).toBe(false);
  });
});

describe('generated fixtures', () => {
  // --file takes either committed JSON or a module that builds the fixture.
  // Extension is the whole decision, so it is worth pinning: a JSON path must
  // never be dynamically imported, and a generator path must never be parsed.
  it('treats .mjs and .js paths as generators and everything else as JSON', () => {
    expect(isGeneratorFixturePath('test/fixtures/generators/statementPermutations.mjs')).toBe(true);
    expect(isGeneratorFixturePath('/abs/path/gen.js')).toBe(true);
    expect(isGeneratorFixturePath('test/fixtures/ndis-quote-board.json')).toBe(false);
    expect(isGeneratorFixturePath('')).toBe(false);
    expect(isGeneratorFixturePath(undefined)).toBe(false);
  });

  it('calls a default-exported function, and accepts a plain object too', () => {
    const built = { boards: [{ boardId: 'b-1', workspaceId: 'ws-1' }] };
    expect(fixtureFromModule({ default: () => built })).toBe(built);
    expect(fixtureFromModule({ default: built })).toBe(built);
  });

  it('names the file rather than failing later inside normalizeFixture', () => {
    expect(() => fixtureFromModule({}, 'gen.mjs')).toThrow(/gen\.mjs must default-export/);
    expect(() => fixtureFromModule({ default: 'nope' }, 'gen.mjs')).toThrow(/default-export/);
  });

  it('normalizes the statement-permutation generator like any committed fixture', () => {
    // The generator replaced a 38k-line JSON file; the loader must not have to
    // know which of the two it is holding.
    const shape = normalizeFixture(buildStatementPermutationsFixture({ years: [2025, 2026] }));

    expect(shape.workspaceId).toBe('55390');
    expect(shape.boards).toHaveLength(4);
    // 10 references + 9 profiles + (9 participants x 2 years x 12 months)
    // + (3 SaH participants x 6 streams x 2 years x 12 months).
    expect(shape.items).toHaveLength(10 + 9 + 216 + 432);
    for (const item of shape.items) {
      expect(item.workspaceId).toBe('55390');
      expect(item.isoPlusItemId).toBe(item.itemId);
    }
    // Data only — loading it can never arm a scheduler tick.
    expect(shape.automationSettings).toBeNull();
    expect(shape.scheduledJobs).toEqual([]);
    expect(shape.invoiceNumbers).toEqual([]);
  });
});

describe('stripDollarKeys', () => {
  it('drops $-prefixed annotation keys and keeps the rest', () => {
    expect(stripDollarKeys({ $case: 'note', itemId: 'i-1', data: { $x: 1 } }))
      .toEqual({ itemId: 'i-1', data: { $x: 1 } });
  });
});
