import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Business from '../../../src/models/Business.js';
import Board from '../../../src/models/Board.js';
import Item from '../../../src/models/Item.js';
import {
  isOfflineMode,
  hasIsoplusToken,
  getWorkspacePageOffline,
  getBoardPageOffline,
  getBoardAttributesOffline,
  getMemberRoleOffline,
  getItemValuesOffline,
  getReferencesOffline,
  getAttributeOffline,
} from '../../../src/services/offlineIsoplus.js';

// Offline mode decides whether the local stack serves ISO+ collections from
// Mongo or proxies the real API. Getting the decision wrong in production would
// silently serve stub data instead of failing on a misconfigured token, so the
// decision table is tested exhaustively rather than by example.

const ENV_KEYS = ['ISOPLUS_OFFLINE', 'PERSONAL_ACCESS_TOKEN', 'NODE_ENV'];

describe('offlineIsoplus', () => {
  const saved = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('isOfflineMode', () => {
    const cases = [
      // [label,                        ISOPLUS_OFFLINE, token,  NODE_ENV,      expected]
      ['forced on, even with a token', '1', 'tok', 'development', true],
      ['forced off, even without one', '0', '', 'development', false],
      ['auto: on when the token is blank', '', '', 'development', true],
      ['auto: off when a token is present', '', 'tok', 'development', false],
      ['never in production', '', '', 'production', false],
      ['whitespace is not a token', '', '   ', 'development', true],
    ];

    for (const [label, offline, token, nodeEnv, expected] of cases) {
      it(label, () => {
        process.env.ISOPLUS_OFFLINE = offline;
        process.env.PERSONAL_ACCESS_TOKEN = token;
        process.env.NODE_ENV = nodeEnv;
        expect(isOfflineMode()).toBe(expected);
      });
    }

    it('forced on still wins in production, because the flag is explicit', () => {
      process.env.ISOPLUS_OFFLINE = '1';
      process.env.NODE_ENV = 'production';
      expect(isOfflineMode()).toBe(true);
    });
  });

  describe('hasIsoplusToken', () => {
    it('treats a declared-but-empty variable as absent', () => {
      // .env.example ships the key with no value, so "declared" is not
      // "configured" — this is the distinction the whole mode turns on.
      process.env.PERSONAL_ACCESS_TOKEN = '';
      expect(hasIsoplusToken()).toBe(false);
      process.env.PERSONAL_ACCESS_TOKEN = '  ';
      expect(hasIsoplusToken()).toBe(false);
      process.env.PERSONAL_ACCESS_TOKEN = 'real';
      expect(hasIsoplusToken()).toBe(true);
    });
  });

  describe('getWorkspacePageOffline', () => {
    it('returns businesses shaped like the real getWorkspacePage', async () => {
      await Business.create({ workspaceId: '55369', name: 'Test' });

      const result = await getWorkspacePageOffline(null, {});

      // Same keys as services/isoplus.js:getWorkspacePage — the request handler
      // is shared, so a shape difference would break it at a distance.
      expect(Object.keys(result).sort()).toEqual(['after', 'has_more', 'status', 'workspace']);
      expect(result.status).toBe(200);
      expect(result.workspace).toEqual([{ id: '55369', name: 'Test' }]);
      expect(result.has_more).toBe(false);
    });

    it('skips businesses with no workspaceId rather than emitting a null id', async () => {
      await Business.create({ workspaceId: '1', name: 'Has One' });
      await Business.create({ name: 'No Workspace' });

      const { workspace } = await getWorkspacePageOffline(null, {});
      expect(workspace.map((w) => w.name)).toEqual(['Has One']);
    });

    it('paginates, and reports the cursor only when more remain', async () => {
      for (const n of ['1', '2', '3']) await Business.create({ workspaceId: n, name: `WS ${n}` });

      const first = await getWorkspacePageOffline(null, { limit: 2 });
      expect(first.workspace).toHaveLength(2);
      expect(first.has_more).toBe(true);
      expect(first.after).toBe(first.workspace[1].id);

      const second = await getWorkspacePageOffline(null, { limit: 2, after: first.after });
      expect(second.workspace).toHaveLength(1);
      expect(second.has_more).toBe(false);
      expect(second.after).toBeNull();
    });

    it('returns an empty page, not a throw, when nothing is stored', async () => {
      const result = await getWorkspacePageOffline(null, {});
      expect(result.workspace).toEqual([]);
      expect(result.status).toBe(200);
    });
  });

  describe('getBoardPageOffline', () => {
    it('returns boards shaped like the real getBoardPage', async () => {
      await Board.create({ boardId: 'b1', name: 'Board One', workspaceId: '55369', label: 'NDIS' });

      const result = await getBoardPageOffline(null, '55369', {});

      expect(Object.keys(result).sort()).toEqual(['after', 'board', 'has_more', 'status']);
      expect(result.board).toEqual([{ id: 'b1', name: 'Board One', label: 'NDIS' }]);
    });

    it('includes boards whose workspaceId is null', async () => {
      // Not tidiness: in the seed dump 33 of 34 boards have a null workspaceId,
      // including the NDIS pricing board, because Board.workspaceId defaults to
      // null and sync does not reliably set it. Filtering strictly returned one
      // board and an apparently empty local app.
      await Board.create({ boardId: 'assigned', name: 'Assigned', workspaceId: '55369' });
      await Board.create({ boardId: 'orphan', name: 'Orphan' });

      const { board } = await getBoardPageOffline(null, '55369', {});
      expect(board.map((b) => b.id).sort()).toEqual(['assigned', 'orphan']);
    });

    it('does not return boards belonging to a different workspace', async () => {
      await Board.create({ boardId: 'mine', name: 'Mine', workspaceId: '55369' });
      await Board.create({ boardId: 'theirs', name: 'Theirs', workspaceId: '99999' });

      const { board } = await getBoardPageOffline(null, '55369', {});
      expect(board.map((b) => b.id)).toEqual(['mine']);
    });

    it('falls back to the board id when a board has no name', async () => {
      // Inserted through the driver rather than Board.create, because the model
      // marks `name` required and would reject this. The document is still
      // reachable in production: the sync path writes with findOneAndUpdate,
      // which does not run validators unless asked, so a board can land with no
      // name and the list must not render "undefined".
      await Board.collection.insertOne({ boardId: 'nameless', workspaceId: '55369' });

      const { board } = await getBoardPageOffline(null, '55369', {});
      expect(board).toHaveLength(1);
      expect(board[0].name).toBe('nameless');
    });
  });

  describe('getBoardAttributesOffline', () => {
    it('serves the committed fixture for the board it was captured from', async () => {
      const result = await getBoardAttributesOffline('55369', 'eNiJpH14PN3');

      expect(result.status).toBe(200);
      expect(Array.isArray(result.attribute)).toBe(true);
      expect(result.attribute.length).toBeGreaterThan(0);

      const byName = Object.fromEntries(result.attribute.map((a) => [a.name, a.type]));
      // Board Configuration filters for text/longtext; these two are what its
      // Integration Message and PDF Link dropdowns bind to.
      expect(byName['Integration Message']).toBe('longtext');
      expect(byName['Generated PDF Link']).toBe('longtext');
    });

    it('carries the pricing sentinels that decide legacy vs new dispatch', async () => {
      const { attribute } = await getBoardAttributesOffline('55369', 'eNiJpH14PN3');
      const references = attribute.filter((a) => a.type === 'reference').map((a) => a.name);

      // The 2026 migration renamed the legacy sentinel. If the fixture ever
      // regains a plain "Direct Support Item Number" reference, the board would
      // resolve to the legacy path and this records why that matters.
      expect(references).toContain('Support Item Number');
      expect(references).toContain('OLD Direct Support Item Number');
      expect(references).not.toContain('Direct Support Item Number');
    });

    it('returns empty for a different board rather than another board\'s attributes', async () => {
      // Wrong-but-plausible data is worse than none: the caller cannot tell.
      const result = await getBoardAttributesOffline('55369', 'some-other-board');
      expect(result).toEqual({ attribute: [], status: 200 });
    });
  });

  describe('getMemberRoleOffline', () => {
    it('returns a null role so the session role stays the single source', async () => {
      // mapWorkspaceWithRole() already falls back to the session role; inventing
      // one here would create a second, competing answer.
      expect(await getMemberRoleOffline(null, '55369', 'a@b.com')).toEqual({ role: null, status: 200 });
    });
  });
});

// --- item values -------------------------------------------------------------

// The webhook path's tenancy guard (validateItemBelongsToTenant) calls
// getItemValues, which is an ISO+ API call. Offline that 401s and every webhook
// is refused as an intrusion attempt, so the offline stand-in has to answer it
// from Mongo in the same shape consumers read: values[].attribute.name.
describe('getItemValuesOffline', () => {
  const WS = '55369';
  const BOARD = 'eNiJpH14PN3';
  const ITEM = 'offline-item-values-test';

  beforeEach(async () => {
    await Item.deleteMany({ itemId: ITEM });
    await Item.create({
      workspaceId: WS,
      boardId: BOARD,
      itemId: ITEM,
      folderId: 'BFMUenisoQ4',
      data: { 'Issue Date': '2026-08-07', 'Type of Lead': 'Current Participant' },
    });
  });

  afterEach(async () => {
    await Item.deleteMany({ itemId: ITEM });
  });

  it('returns the stored values keyed by attribute name', async () => {
    const result = await getItemValuesOffline(WS, BOARD, ITEM);

    expect(result).not.toBeNull();
    const byName = Object.fromEntries(
      result.values.map((v) => [v.attribute.name, v.data]),
    );
    expect(byName['Issue Date']).toBe('2026-08-07');
    expect(byName['Type of Lead']).toBe('Current Participant');
  });

  it('carries the item id, so a caller can tell which item it got', async () => {
    const result = await getItemValuesOffline(WS, BOARD, ITEM);
    expect(result.id).toBe(ITEM);
  });

  // Null, not an empty item: the guard treats a falsy result as "does not
  // exist", which is exactly the right answer for an item that does not.
  it('returns null for an item that is not stored', async () => {
    expect(await getItemValuesOffline(WS, BOARD, 'no-such-item')).toBeNull();
  });

  // Returning another board's item would defeat the tenancy guard rather than
  // stand in for it.
  it('returns null when the item belongs to a different board', async () => {
    expect(await getItemValuesOffline(WS, 'some-other-board', ITEM)).toBeNull();
  });
});

// --- references and attributes ----------------------------------------------

// The quote/invoice PDF handlers walk item references before generating:
// getReferences() lists {attribute_id, to_item_id} pairs, getAttribute() names
// each one, and the handler map keys on that name ('Service Area' first, which
// is mandatory). Both are ISO+ calls with no local fallback, so offline the
// walk returned nothing and every PDF webhook died on "Service Area value is
// required." even with the fixture loaded. These serve the fixture's recorded
// references instead.
describe('getReferencesOffline', () => {
  it('lists the fixture references for a quote item, in the live shape', async () => {
    const result = await getReferencesOffline('55369', 'eNiJpH14PN3', 'fixture-quote-legacy-pricing');

    expect(result).not.toBeNull();
    expect(Array.isArray(result.data)).toBe(true);
    const serviceArea = result.data.find((r) => r.attribute_id === 'fixture-attr-service-area');
    expect(serviceArea).toBeDefined();
    expect(serviceArea.to_item_id).toBe('fixture-ref-service-area');
  });

  it('returns an empty list, not null, for an item with no recorded references', async () => {
    const result = await getReferencesOffline('55369', 'eNiJpH14PN3', 'no-such-item');
    expect(result).toEqual({ data: [], status: 200 });
  });
});

describe('getAttributeOffline', () => {
  it('resolves a fixture attribute by id, carrying the name the handler map keys on', async () => {
    const attr = await getAttributeOffline('55369', 'eNiJpH14PN3', 'fixture-attr-service-area');
    expect(attr).toMatchObject({ id: 'fixture-attr-service-area', name: 'Service Area' });
  });

  it('returns null for an unknown attribute id', async () => {
    expect(await getAttributeOffline('55369', 'eNiJpH14PN3', 'nope')).toBeNull();
  });
});
