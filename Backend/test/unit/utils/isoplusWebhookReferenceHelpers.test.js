import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getItemValues, ITEM_DELETED } = vi.hoisted(() => ({
  getItemValues: vi.fn(),
  ITEM_DELETED: Symbol('ITEM_DELETED'),
}));

// The only genuinely external dependency: the ISO+ HTTP API.
vi.mock('../../../src/services/isoplus.js', () => ({ getItemValues, ITEM_DELETED }));

const { updateReferencingWebhookItems } = await import(
  '../../../src/utils/isoplusWebhookReferenceHelpers.js'
);
const { default: Board } = await import('../../../src/models/Board.js');
const { default: Item } = await import('../../../src/models/Item.js');

const REFERENCED_ID = 'itm_client_7';

function seedBoard(overrides = {}) {
  return Board.create({
    boardId: 'brd_jobs',
    name: 'Jobs',
    workspaceId: 'wsp_1',
    syncData: true,
    syncStatus: 'realtime_sync',
    currentSyncGUID: 'guid-current',
    ...overrides,
  });
}

function seedItem(overrides = {}) {
  return Item.create({
    workspaceId: 'wsp_1',
    boardId: 'brd_jobs',
    folderId: 'fld_active',
    itemId: 'itm_job_1',
    isoPlusItemId: 'itm_job_1',
    syncGUID: 'guid-old',
    data: {
      'Job Title': 'Weekly support',
      Client: [{ id: REFERENCED_ID, object: 'item', name: 'Bianca R', board_id: 'brd_clients' }],
      Hours: 3,
      _primaryValue: 'Weekly support',
    },
    ...overrides,
  });
}

/** An item as ISO+ returns it, carrying the refreshed reference display name. */
function isoPlusItem(itemId = 'itm_job_1', clientName = 'Bianca Rossi') {
  return {
    id: itemId,
    object: 'item',
    board_id: 'brd_jobs',
    folder_id: 'fld_active',
    name: 'Weekly support',
    created_at: '2026-07-30T01:00:00.000Z',
    updated_at: '2026-08-01T02:12:30.000Z',
    values: [
      {
        id: `val_${itemId}_title`,
        object: 'value',
        item_id: itemId,
        attribute_id: 'attr_title',
        deleted: false,
        data: 'Weekly support',
        attribute: {
          id: 'attr_title',
          object: 'attribute',
          name: 'Job Title',
          type: 'text',
          primary: true,
          board_id: 'brd_jobs',
        },
      },
      {
        id: `val_${itemId}_client`,
        object: 'value',
        item_id: itemId,
        attribute_id: 'attr_client',
        deleted: false,
        data: [{ id: REFERENCED_ID, object: 'item', name: clientName, board_id: 'brd_clients' }],
        attribute: {
          id: 'attr_client',
          object: 'attribute',
          name: 'Client',
          type: 'reference',
          primary: false,
          board_id: 'brd_jobs',
        },
      },
    ],
  };
}

const EXPECTED_REFRESHED = {
  'Job Title': 'Weekly support',
  Client: [{ id: REFERENCED_ID, object: 'item', name: 'Bianca Rossi', board_id: 'brd_clients' }],
  _primaryValue: 'Weekly support',
};

beforeEach(() => {
  getItemValues.mockReset();
});

describe('updateReferencingWebhookItems', () => {
  it('refreshes an item that references the changed item', async () => {
    await seedBoard();
    await seedItem();
    getItemValues.mockResolvedValue(isoPlusItem());

    await updateReferencingWebhookItems(REFERENCED_ID, 'wsp_1');

    expect(getItemValues).toHaveBeenCalledTimes(1);
    expect(getItemValues).toHaveBeenCalledWith('wsp_1', 'brd_jobs', 'itm_job_1');
    const stored = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(stored.data).toEqual(EXPECTED_REFRESHED);
    expect(stored.syncGUID).toBeNull();
  });

  it('leaves items that do not reference the changed item untouched', async () => {
    await seedBoard();
    await seedItem({
      itemId: 'itm_job_2',
      isoPlusItemId: 'itm_job_2',
      data: {
        'Job Title': 'Unrelated job',
        Client: [{ id: 'itm_client_9', object: 'item', name: 'Other', board_id: 'brd_clients' }],
        _primaryValue: 'Unrelated job',
      },
    });

    await updateReferencingWebhookItems(REFERENCED_ID, 'wsp_1');

    expect(getItemValues).not.toHaveBeenCalled();
    const stored = await Item.findOne({ itemId: 'itm_job_2' }).lean();
    expect(stored.syncGUID).toBe('guid-old');
    expect(stored.data['Job Title']).toBe('Unrelated job');
  });

  it('does nothing when the workspace has no sync-enabled boards', async () => {
    await seedBoard({ syncData: false });
    await seedItem();

    await updateReferencingWebhookItems(REFERENCED_ID, 'wsp_1');

    expect(getItemValues).not.toHaveBeenCalled();
    const stored = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(stored.syncGUID).toBe('guid-old');
  });

  it('ignores boards belonging to another workspace', async () => {
    await seedBoard({ boardId: 'brd_other', name: 'Other', workspaceId: 'wsp_2' });
    await seedItem({
      itemId: 'itm_job_other',
      isoPlusItemId: 'itm_job_other',
      workspaceId: 'wsp_2',
      boardId: 'brd_other',
    });

    await updateReferencingWebhookItems(REFERENCED_ID, 'wsp_1');

    expect(getItemValues).not.toHaveBeenCalled();
    const stored = await Item.findOne({ itemId: 'itm_job_other' }).lean();
    expect(stored.syncGUID).toBe('guid-old');
  });

  it('does not write when ISO+ reports the referencing item as deleted', async () => {
    await seedBoard();
    await seedItem();
    getItemValues.mockResolvedValue(ITEM_DELETED);

    await updateReferencingWebhookItems(REFERENCED_ID, 'wsp_1');

    const stored = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(stored.syncGUID).toBe('guid-old');
    expect(stored.data.Client[0].name).toBe('Bianca R');
  });

  it('does not write when the API returns no data', async () => {
    await seedBoard();
    await seedItem();
    getItemValues.mockResolvedValue(null);

    await updateReferencingWebhookItems(REFERENCED_ID, 'wsp_1');

    const stored = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(stored.syncGUID).toBe('guid-old');
  });

  it('keeps going after one item fails and still updates the others', async () => {
    await seedBoard();
    await seedItem({ itemId: 'itm_job_1', isoPlusItemId: 'itm_job_1' });
    await seedItem({ itemId: 'itm_job_2', isoPlusItemId: 'itm_job_2' });

    getItemValues.mockImplementation(async (_workspaceId, _boardId, itemId) => {
      if (itemId === 'itm_job_1') throw new Error('429 rate limited');
      return isoPlusItem('itm_job_2');
    });

    await updateReferencingWebhookItems(REFERENCED_ID, 'wsp_1');

    const failed = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    const updated = await Item.findOne({ itemId: 'itm_job_2' }).lean();
    expect(failed.syncGUID).toBe('guid-old');
    expect(updated.syncGUID).toBeNull();
    expect(updated.data).toEqual(EXPECTED_REFRESHED);
  });

  it('walks every sync-enabled board in the workspace', async () => {
    await seedBoard();
    await seedBoard({ boardId: 'brd_quotes', name: 'Quotes' });
    await seedItem();
    await seedItem({ itemId: 'itm_quote_1', isoPlusItemId: 'itm_quote_1', boardId: 'brd_quotes' });
    getItemValues.mockImplementation(async (_workspaceId, _boardId, itemId) => isoPlusItem(itemId));

    await updateReferencingWebhookItems(REFERENCED_ID, 'wsp_1');

    expect(getItemValues.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['brd_jobs', 'itm_job_1'],
      ['brd_quotes', 'itm_quote_1'],
    ]);
    const quote = await Item.findOne({ itemId: 'itm_quote_1' }).lean();
    expect(quote.syncGUID).toBeNull();
  });

  it('pages past the 100-item batch size', async () => {
    await seedBoard();
    const docs = Array.from({ length: 101 }, (_, i) => ({
      workspaceId: 'wsp_1',
      boardId: 'brd_jobs',
      folderId: 'fld_active',
      itemId: `itm_job_${i}`,
      isoPlusItemId: `itm_job_${i}`,
      syncGUID: 'guid-old',
      data: {
        'Job Title': 'Weekly support',
        Client: [{ id: REFERENCED_ID, object: 'item', name: 'Bianca R', board_id: 'brd_clients' }],
        _primaryValue: 'Weekly support',
      },
    }));
    await Item.insertMany(docs);
    getItemValues.mockImplementation(async (_workspaceId, _boardId, itemId) => isoPlusItem(itemId));

    await updateReferencingWebhookItems(REFERENCED_ID, 'wsp_1');

    expect(getItemValues).toHaveBeenCalledTimes(101);
    expect(await Item.countDocuments({ syncGUID: null })).toBe(101);
  });

  it('returns quietly for an empty referenced item id', async () => {
    await seedBoard();
    await seedItem();

    await updateReferencingWebhookItems('', 'wsp_1');

    expect(getItemValues).not.toHaveBeenCalled();
    const stored = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(stored.syncGUID).toBe('guid-old');
  });

  it('returns quietly for an empty workspace id', async () => {
    await seedBoard();
    await seedItem();

    await updateReferencingWebhookItems(REFERENCED_ID, '');

    expect(getItemValues).not.toHaveBeenCalled();
    const stored = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(stored.syncGUID).toBe('guid-old');
  });

  it('swallows a nullish argument instead of rejecting', async () => {
    await seedBoard();
    await seedItem();

    await expect(updateReferencingWebhookItems(null, 'wsp_1')).resolves.toBeUndefined();
    expect(getItemValues).not.toHaveBeenCalled();
  });
});
