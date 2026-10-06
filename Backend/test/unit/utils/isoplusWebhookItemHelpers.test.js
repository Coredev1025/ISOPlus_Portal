import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getItemValues, ITEM_DELETED } = vi.hoisted(() => ({
  getItemValues: vi.fn(),
  ITEM_DELETED: Symbol('ITEM_DELETED'),
}));

// The only genuinely external dependency: the ISO+ HTTP API.
vi.mock('../../../src/services/isoplus.js', () => ({ getItemValues, ITEM_DELETED }));

const {
  deleteWebhookItemFromDatabase,
  fetchOrCreateWebhookItem,
} = await import('../../../src/utils/isoplusWebhookItemHelpers.js');
const { default: Board } = await import('../../../src/models/Board.js');
const { default: Item } = await import('../../../src/models/Item.js');

function seedBoard(overrides = {}) {
  return Board.create({
    boardId: 'brd_jobs',
    name: 'Jobs',
    workspaceId: 'wsp_1',
    syncData: true,
    syncStatus: 'realtime_sync',
    currentSyncGUID: 'guid-current',
    syncStats: { foldersProcessed: 2, itemsSynced: 5, itemsCreated: 5, itemsUpdated: 1 },
    ...overrides,
  });
}

function seedItem(overrides = {}) {
  return Item.create({
    workspaceId: 'wsp_1',
    boardId: 'brd_jobs',
    folderId: 'fld_active',
    itemId: 'itm_1001',
    isoPlusItemId: 'itm_1001',
    syncGUID: 'guid-old',
    data: { Title: 'Support session', Hours: 3, _primaryValue: 'Support session' },
    ...overrides,
  });
}

/** An item as ISO+ returns it from GET .../items/:id?expand[]=values.attribute */
function isoPlusItem(overrides = {}) {
  return {
    id: 'itm_1001',
    object: 'item',
    board_id: 'brd_jobs',
    folder_id: 'fld_active',
    name: 'Support session',
    created_at: '2026-07-30T01:00:00.000Z',
    updated_at: '2026-08-01T02:12:30.000Z',
    values: [
      {
        id: 'val_1',
        object: 'value',
        item_id: 'itm_1001',
        attribute_id: 'attr_title',
        deleted: false,
        data: 'Support session',
        attribute: {
          id: 'attr_title',
          object: 'attribute',
          name: 'Title',
          type: 'text',
          primary: true,
          board_id: 'brd_jobs',
        },
      },
      {
        id: 'val_2',
        object: 'value',
        item_id: 'itm_1001',
        attribute_id: 'attr_hours',
        deleted: false,
        data: 3,
        attribute: {
          id: 'attr_hours',
          object: 'attribute',
          name: 'Hours',
          type: 'number',
          primary: false,
          board_id: 'brd_jobs',
        },
      },
      {
        id: 'val_3',
        object: 'value',
        item_id: 'itm_1001',
        attribute_id: 'attr_removed',
        deleted: true,
        data: 'stale',
        attribute: {
          id: 'attr_removed',
          object: 'attribute',
          name: 'Removed',
          type: 'text',
          primary: false,
          board_id: 'brd_jobs',
        },
      },
    ],
    ...overrides,
  };
}

const EXPECTED_TRANSFORMED = {
  Title: 'Support session',
  Hours: 3,
  _primaryValue: 'Support session',
};

beforeEach(() => {
  getItemValues.mockReset();
});

describe('deleteWebhookItemFromDatabase', () => {
  it('returns null and leaves the board alone when the item is not stored', async () => {
    await seedBoard();

    expect(await deleteWebhookItemFromDatabase('itm_missing')).toBeNull();

    const board = await Board.findOne({ boardId: 'brd_jobs' }).lean();
    expect(board.syncStats.itemsSynced).toBe(5);
  });

  it('deletes the item and decrements the board item counter', async () => {
    await seedBoard();
    await seedItem();

    const result = await deleteWebhookItemFromDatabase('itm_1001');

    expect(result).toEqual({
      deleted: true,
      itemId: 'itm_1001',
      boardId: 'brd_jobs',
      workspaceId: 'wsp_1',
    });
    expect(await Item.findOne({ itemId: 'itm_1001' }).lean()).toBeNull();
    const board = await Board.findOne({ boardId: 'brd_jobs' }).lean();
    expect(board.syncStats.itemsSynced).toBe(4);
  });

  it('deletes only the requested item', async () => {
    await seedBoard();
    await seedItem();
    await seedItem({ itemId: 'itm_1002', isoPlusItemId: 'itm_1002' });

    await deleteWebhookItemFromDatabase('itm_1001');

    expect(await Item.countDocuments({})).toBe(1);
    expect(await Item.findOne({ itemId: 'itm_1002' }).lean()).not.toBeNull();
  });

  it('still deletes the item when its board row is missing', async () => {
    await seedItem();

    const result = await deleteWebhookItemFromDatabase('itm_1001');

    expect(result.deleted).toBe(true);
    expect(await Item.countDocuments({})).toBe(0);
  });

  it('returns null for an empty item id without touching the database', async () => {
    await seedItem();

    expect(await deleteWebhookItemFromDatabase('')).toBeNull();
    expect(await Item.countDocuments({})).toBe(1);
  });

  it('throws rather than returning null for a nullish item id', async () => {
    await expect(deleteWebhookItemFromDatabase(null)).rejects.toThrow('Invalid query value');
  });
});

describe('fetchOrCreateWebhookItem — item already stored', () => {
  it('returns the stored item with the board current sync GUID and skips the API', async () => {
    await seedBoard();
    await seedItem();

    const result = await fetchOrCreateWebhookItem('itm_1001');

    expect(result.boardId).toBe('brd_jobs');
    expect(result.workspaceId).toBe('wsp_1');
    expect(result.currentSyncGUID).toBe('guid-current');
    expect(result.item.syncGUID).toBe('guid-old');
    expect(getItemValues).not.toHaveBeenCalled();
  });

  it('returns a null sync GUID when the board row is missing', async () => {
    await seedItem();

    const result = await fetchOrCreateWebhookItem('itm_1001');

    expect(result.boardId).toBe('brd_jobs');
    expect(result.currentSyncGUID).toBeNull();
  });

  it('returns null for an empty item id', async () => {
    expect(await fetchOrCreateWebhookItem('')).toBeNull();
    expect(getItemValues).not.toHaveBeenCalled();
  });
});

describe('fetchOrCreateWebhookItem — known board', () => {
  it('creates the item from the API using the board sync GUID', async () => {
    await seedBoard();
    getItemValues.mockResolvedValue(isoPlusItem());

    const result = await fetchOrCreateWebhookItem('itm_1001', 'brd_jobs', 'wsp_1');

    expect(getItemValues).toHaveBeenCalledTimes(1);
    expect(getItemValues).toHaveBeenCalledWith('wsp_1', 'brd_jobs', 'itm_1001');
    expect(result.boardId).toBe('brd_jobs');
    expect(result.workspaceId).toBe('wsp_1');
    expect(result.currentSyncGUID).toBe('guid-current');

    const stored = await Item.findOne({ itemId: 'itm_1001' }).lean();
    expect(stored.workspaceId).toBe('wsp_1');
    expect(stored.boardId).toBe('brd_jobs');
    expect(stored.folderId).toBe('fld_active');
    expect(stored.isoPlusItemId).toBe('itm_1001');
    expect(stored.syncGUID).toBe('guid-current');
    expect(stored.data).toEqual(EXPECTED_TRANSFORMED);
  });

  it('falls back to the nested folder id and stringifies it', async () => {
    await seedBoard();
    getItemValues.mockResolvedValue(
      isoPlusItem({ folder_id: undefined, folder: { id: 91, name: 'Active', board_id: 'brd_jobs' } }),
    );

    await fetchOrCreateWebhookItem('itm_1001', 'brd_jobs', 'wsp_1');

    const stored = await Item.findOne({ itemId: 'itm_1001' }).lean();
    expect(stored.folderId).toBe('91');
  });

  it('stores an empty folder id when the item has no folder', async () => {
    await seedBoard();
    getItemValues.mockResolvedValue(isoPlusItem({ folder_id: '' }));

    const result = await fetchOrCreateWebhookItem('itm_1001', 'brd_jobs', 'wsp_1');

    expect(result.item.folderId).toBe('');
    const stored = await Item.findOne({ itemId: 'itm_1001' }).lean();
    expect(stored.folderId).toBe('');
  });

  it('stores a null sync GUID when the board row is missing', async () => {
    getItemValues.mockResolvedValue(isoPlusItem());

    const result = await fetchOrCreateWebhookItem('itm_1001', 'brd_jobs', 'wsp_1');

    expect(result.currentSyncGUID).toBeNull();
    const stored = await Item.findOne({ itemId: 'itm_1001' }).lean();
    expect(stored.syncGUID).toBeNull();
  });

  it('reports a deletion without creating the item when ISO+ 404s', async () => {
    await seedBoard();
    getItemValues.mockResolvedValue(ITEM_DELETED);

    expect(await fetchOrCreateWebhookItem('itm_1001', 'brd_jobs', 'wsp_1')).toEqual({
      deleted: true,
      itemId: 'itm_1001',
    });
    expect(await Item.countDocuments({})).toBe(0);
  });

  it('returns null when the API call throws', async () => {
    await seedBoard();
    getItemValues.mockRejectedValue(new Error('socket hang up'));

    expect(await fetchOrCreateWebhookItem('itm_1001', 'brd_jobs', 'wsp_1')).toBeNull();
    expect(await Item.countDocuments({})).toBe(0);
  });

  it('returns null when the API yields no item data', async () => {
    await seedBoard();
    getItemValues.mockResolvedValue(null);

    expect(await fetchOrCreateWebhookItem('itm_1001', 'brd_jobs', 'wsp_1')).toBeNull();
    expect(await Item.countDocuments({})).toBe(0);
  });
});

describe('fetchOrCreateWebhookItem — board unknown', () => {
  it('searches only sync-enabled boards, skipping failures, and stores what it finds', async () => {
    await seedBoard({ boardId: 'brd_off', name: 'Archive', syncData: false, currentSyncGUID: 'guid-off' });
    await seedBoard({ boardId: 'brd_broken', name: 'Broken', currentSyncGUID: 'guid-broken' });
    await seedBoard({ boardId: 'brd_jobs', currentSyncGUID: 'guid-jobs' });

    getItemValues.mockImplementation(async (_workspaceId, boardId) => {
      if (boardId === 'brd_broken') throw new Error('502 from ISO+');
      if (boardId === 'brd_jobs') return isoPlusItem();
      return null;
    });

    const result = await fetchOrCreateWebhookItem('itm_1001');

    expect(getItemValues).toHaveBeenCalledTimes(2);
    expect(getItemValues.mock.calls.map((c) => c[1])).toEqual(['brd_broken', 'brd_jobs']);
    expect(result.boardId).toBe('brd_jobs');
    expect(result.currentSyncGUID).toBe('guid-jobs');

    const stored = await Item.findOne({ itemId: 'itm_1001' }).lean();
    expect(stored.syncGUID).toBe('guid-jobs');
    expect(stored.data).toEqual(EXPECTED_TRANSFORMED);
  });

  it('stops at the first board and does not query the rest', async () => {
    await seedBoard({ boardId: 'brd_jobs' });
    await seedBoard({ boardId: 'brd_second', name: 'Second' });
    getItemValues.mockResolvedValue(isoPlusItem());

    await fetchOrCreateWebhookItem('itm_1001');

    expect(getItemValues).toHaveBeenCalledTimes(1);
    expect(getItemValues).toHaveBeenCalledWith('wsp_1', 'brd_jobs', 'itm_1001');
  });

  it('reports a deletion when a searched board says the item is gone', async () => {
    await seedBoard();
    getItemValues.mockResolvedValue(ITEM_DELETED);

    expect(await fetchOrCreateWebhookItem('itm_1001')).toEqual({ deleted: true, itemId: 'itm_1001' });
    expect(await Item.countDocuments({})).toBe(0);
  });

  it('returns null when no sync-enabled board has the item', async () => {
    await seedBoard();
    getItemValues.mockResolvedValue(null);

    expect(await fetchOrCreateWebhookItem('itm_1001')).toBeNull();
    expect(await Item.countDocuments({})).toBe(0);
  });

  it('returns null when there are no sync-enabled boards at all', async () => {
    await seedBoard({ syncData: false });

    expect(await fetchOrCreateWebhookItem('itm_1001')).toBeNull();
    expect(getItemValues).not.toHaveBeenCalled();
  });

  it('takes the search path when only a board id is supplied', async () => {
    await seedBoard({ boardId: 'brd_other', name: 'Other' });
    getItemValues.mockResolvedValue(isoPlusItem());

    const result = await fetchOrCreateWebhookItem('itm_1001', 'brd_jobs', null);

    expect(getItemValues).toHaveBeenCalledWith('wsp_1', 'brd_other', 'itm_1001');
    expect(result.boardId).toBe('brd_other');
  });
});
