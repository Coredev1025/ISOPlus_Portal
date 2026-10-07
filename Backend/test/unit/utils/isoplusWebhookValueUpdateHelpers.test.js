import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getItemValues, ITEM_DELETED } = vi.hoisted(() => ({
  getItemValues: vi.fn(),
  ITEM_DELETED: Symbol('ITEM_DELETED'),
}));

// The only genuinely external dependency: the ISO+ HTTP API.
vi.mock('../../../src/services/isoplus.js', () => ({ getItemValues, ITEM_DELETED }));

const { handleWebhookValueUpdated } = await import(
  '../../../src/utils/isoplusWebhookValueUpdateHelpers.js'
);
const { default: Board } = await import('../../../src/models/Board.js');
const { default: Item } = await import('../../../src/models/Item.js');

const CLIENT_ID = 'itm_client_7';

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

const SEEDED_DATA = {
  'Job Title': 'Weekly support',
  Status: 'Scheduled',
  Client: [{ id: CLIENT_ID, object: 'item', name: 'Bianca R', board_id: 'brd_clients' }],
  Hours: 3,
  _primaryValue: 'Weekly support',
};

function seedItem(overrides = {}) {
  return Item.create({
    workspaceId: 'wsp_1',
    boardId: 'brd_jobs',
    folderId: 'fld_active',
    itemId: 'itm_job_1',
    isoPlusItemId: 'itm_job_1',
    syncGUID: 'guid-old',
    data: { ...SEEDED_DATA },
    ...overrides,
  });
}

/** A value.updated webhook payload, shaped like the real ISO+ event body. */
function valuePayload(overrides = {}) {
  return {
    id: 'val_9f2',
    object: 'value',
    item_id: 'itm_job_1',
    attribute_id: 'attr_status',
    board_id: 'brd_jobs',
    workspace_id: 'wsp_1',
    deleted: false,
    created_at: '2026-08-01T02:11:00.000Z',
    updated_at: '2026-08-01T02:12:30.000Z',
    data: 'Delivered',
    attribute: {
      id: 'attr_status',
      object: 'attribute',
      name: 'Status',
      type: 'text',
      primary: false,
      board_id: 'brd_jobs',
    },
    ...overrides,
  };
}

/** A job item as ISO+ returns it, with a refreshed Status. */
function isoPlusJobItem(itemId = 'itm_job_1', status = 'Delivered') {
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
        id: `val_${itemId}_status`,
        object: 'value',
        item_id: itemId,
        attribute_id: 'attr_status',
        deleted: false,
        data: status,
        attribute: {
          id: 'attr_status',
          object: 'attribute',
          name: 'Status',
          type: 'text',
          primary: false,
          board_id: 'brd_jobs',
        },
      },
      {
        id: `val_${itemId}_client`,
        object: 'value',
        item_id: itemId,
        attribute_id: 'attr_client',
        deleted: false,
        data: [{ id: CLIENT_ID, object: 'item', name: 'Bianca Rossi', board_id: 'brd_clients' }],
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

const EXPECTED_REFRESHED_JOB = {
  'Job Title': 'Weekly support',
  Status: 'Delivered',
  Client: [{ id: CLIENT_ID, object: 'item', name: 'Bianca Rossi', board_id: 'brd_clients' }],
  _primaryValue: 'Weekly support',
};

/** The referenced client item as ISO+ returns it. */
function isoPlusClientItem() {
  return {
    id: CLIENT_ID,
    object: 'item',
    board_id: 'brd_clients',
    folder_id: 'fld_clients',
    name: 'Bianca Rossi',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-08-01T02:12:30.000Z',
    values: [
      {
        id: 'val_client_name',
        object: 'value',
        item_id: CLIENT_ID,
        attribute_id: 'attr_client_name',
        deleted: false,
        data: 'Bianca Rossi',
        attribute: {
          id: 'attr_client_name',
          object: 'attribute',
          name: 'Client Name',
          type: 'text',
          primary: true,
          board_id: 'brd_clients',
        },
      },
    ],
  };
}

beforeEach(() => {
  getItemValues.mockReset();
});

describe('handleWebhookValueUpdated — payload guards', () => {
  it('returns without touching the item when item_id is empty', async () => {
    await seedBoard();
    await seedItem();

    await expect(handleWebhookValueUpdated(valuePayload({ item_id: '' }))).resolves.toBeUndefined();

    expect(getItemValues).not.toHaveBeenCalled();
    const stored = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(stored.syncGUID).toBe('guid-old');
  });

  it('rejects instead of warning when item_id is absent altogether', async () => {
    await expect(handleWebhookValueUpdated(valuePayload({ item_id: undefined }))).rejects.toThrow(
      'Invalid query value',
    );
  });

  it('returns when the item is in neither the database nor ISO+', async () => {
    await seedBoard();
    getItemValues.mockResolvedValue(null);

    await handleWebhookValueUpdated(valuePayload());

    expect(await Item.countDocuments({})).toBe(0);
  });

  it('returns when ISO+ reports the item as deleted while fetching it', async () => {
    await seedBoard();
    getItemValues.mockResolvedValue(ITEM_DELETED);

    await handleWebhookValueUpdated(valuePayload());

    // The payload's board is only a hint: its 404 sends the lookup to the bounded
    // scan, which asks that one synced board again before concluding anything.
    expect(getItemValues).toHaveBeenCalledTimes(2);
    expect(await Item.countDocuments({})).toBe(0);
  });
});

describe('handleWebhookValueUpdated — board gate', () => {
  it('does not update when the board has sync disabled', async () => {
    await seedBoard({ syncData: false });
    await seedItem();

    await handleWebhookValueUpdated(valuePayload());

    expect(getItemValues).not.toHaveBeenCalled();
    const stored = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(stored.syncGUID).toBe('guid-old');
    expect(stored.data).toEqual(SEEDED_DATA);
  });

  it('does not update when the board row is missing', async () => {
    await seedItem();

    await handleWebhookValueUpdated(valuePayload());

    expect(getItemValues).not.toHaveBeenCalled();
    const stored = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(stored.syncGUID).toBe('guid-old');
  });
});

describe('handleWebhookValueUpdated — refresh from the API', () => {
  it('replaces the stored data with the freshly fetched item and clears the sync GUID', async () => {
    await seedBoard();
    await seedItem();
    getItemValues.mockResolvedValue(isoPlusJobItem());

    await handleWebhookValueUpdated(valuePayload());

    expect(getItemValues).toHaveBeenCalledTimes(1);
    expect(getItemValues).toHaveBeenCalledWith('wsp_1', 'brd_jobs', 'itm_job_1');
    const stored = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(stored.data).toEqual(EXPECTED_REFRESHED_JOB);
    expect(stored.syncGUID).toBeNull();
  });

  it('deletes the local copy when the refresh finds the item gone', async () => {
    await seedBoard();
    await seedItem();
    getItemValues.mockResolvedValue(ITEM_DELETED);

    await handleWebhookValueUpdated(valuePayload());

    expect(await Item.findOne({ itemId: 'itm_job_1' }).lean()).toBeNull();
    const board = await Board.findOne({ boardId: 'brd_jobs' }).lean();
    expect(board.syncStats.itemsSynced).toBe(4);
  });

  it('leaves the item untouched when the API call throws', async () => {
    await seedBoard();
    await seedItem();
    getItemValues.mockRejectedValue(new Error('socket hang up'));

    await expect(handleWebhookValueUpdated(valuePayload())).resolves.toBeUndefined();

    const stored = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(stored.data).toEqual(SEEDED_DATA);
    expect(stored.syncGUID).toBe('guid-old');
  });
});

describe('handleWebhookValueUpdated — fallback to the attribute name', () => {
  it('writes the single attribute from the payload when the refresh yields nothing', async () => {
    await seedBoard();
    await seedItem();
    getItemValues.mockResolvedValue(null);

    await handleWebhookValueUpdated(valuePayload());

    const stored = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(stored.data).toEqual({ ...SEEDED_DATA, Status: 'Delivered' });
    expect(stored.syncGUID).toBeNull();
  });

  it('writes null for the attribute when the value was deleted', async () => {
    await seedBoard();
    await seedItem();
    getItemValues.mockResolvedValue(null);

    await handleWebhookValueUpdated(valuePayload({ deleted: true, data: null }));

    const stored = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(stored.data.Status).toBeNull();
    expect(stored.data['Job Title']).toBe('Weekly support');
  });

  it('resolves a label value against the labels carried in the payload', async () => {
    await seedBoard();
    await seedItem();
    getItemValues.mockResolvedValue(null);

    await handleWebhookValueUpdated(
      valuePayload({
        data: ['lbl_appr'],
        attribute: {
          id: 'attr_state',
          object: 'attribute',
          name: 'State',
          type: 'label',
          primary: false,
          board_id: 'brd_jobs',
          settings: {
            labels: [
              { id: 'lbl_appr', name: 'Approved', color: '#22c55e' },
              { id: 'lbl_rej', name: 'Rejected', color: '#ef4444' },
            ],
          },
        },
      }),
    );

    const stored = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(stored.data.State).toEqual({ id: 'lbl_appr', name: 'Approved', color: '#22c55e' });
  });

  it('stores the raw label ids when the payload carries no label metadata', async () => {
    await seedBoard();
    await seedItem();
    getItemValues.mockResolvedValue(null);

    await handleWebhookValueUpdated(
      valuePayload({
        data: ['lbl_appr'],
        attribute: {
          id: 'attr_state',
          object: 'attribute',
          name: 'State',
          type: 'label',
          primary: false,
          board_id: 'brd_jobs',
        },
      }),
    );

    const stored = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(stored.data.State).toEqual(['lbl_appr']);
  });

  it('makes no change when the refresh fails and the payload has no attribute name', async () => {
    await seedBoard();
    await seedItem();
    getItemValues.mockResolvedValue(null);

    await handleWebhookValueUpdated(
      valuePayload({
        attribute: { id: 'attr_status', object: 'attribute', type: 'text', board_id: 'brd_jobs' },
      }),
    );

    const stored = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(stored.data).toEqual(SEEDED_DATA);
    expect(stored.syncGUID).toBe('guid-old');
  });
});

describe('handleWebhookValueUpdated — knock-on reference updates', () => {
  async function seedClientAndReferencingJob() {
    await seedBoard({ boardId: 'brd_clients', name: 'Clients' });
    await seedBoard();
    await Item.create({
      workspaceId: 'wsp_1',
      boardId: 'brd_clients',
      folderId: 'fld_clients',
      itemId: CLIENT_ID,
      isoPlusItemId: CLIENT_ID,
      syncGUID: 'guid-old',
      data: { 'Client Name': 'Bianca R', _primaryValue: 'Bianca R' },
    });
    await seedItem();
    getItemValues.mockImplementation(async (_workspaceId, _boardId, itemId) =>
      itemId === CLIENT_ID ? isoPlusClientItem() : isoPlusJobItem(itemId));
  }

  it('refreshes items referencing the changed item for a reference attribute', async () => {
    await seedClientAndReferencingJob();

    await handleWebhookValueUpdated(
      valuePayload({
        item_id: CLIENT_ID,
        attribute_id: 'attr_client_name',
        board_id: 'brd_clients',
        data: 'Bianca Rossi',
        attribute: {
          id: 'attr_client_name',
          object: 'attribute',
          name: 'Client Name',
          type: 'reference',
          primary: true,
          board_id: 'brd_clients',
        },
      }),
    );

    const client = await Item.findOne({ itemId: CLIENT_ID }).lean();
    expect(client.data).toEqual({ 'Client Name': 'Bianca Rossi', _primaryValue: 'Bianca Rossi' });
    const job = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(job.data).toEqual(EXPECTED_REFRESHED_JOB);
    expect(job.syncGUID).toBeNull();
  });

  it('refreshes referencing items for a members attribute too', async () => {
    await seedClientAndReferencingJob();

    await handleWebhookValueUpdated(
      valuePayload({
        item_id: CLIENT_ID,
        attribute_id: 'attr_client_name',
        board_id: 'brd_clients',
        data: 'Bianca Rossi',
        attribute: {
          id: 'attr_client_name',
          object: 'attribute',
          name: 'Client Name',
          type: 'members',
          primary: true,
          board_id: 'brd_clients',
        },
      }),
    );

    const job = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(job.syncGUID).toBeNull();
    expect(job.data.Client[0].name).toBe('Bianca Rossi');
  });

  it('leaves referencing items alone for an ordinary text attribute', async () => {
    await seedClientAndReferencingJob();

    await handleWebhookValueUpdated(
      valuePayload({
        item_id: CLIENT_ID,
        attribute_id: 'attr_client_name',
        board_id: 'brd_clients',
        data: 'Bianca Rossi',
        attribute: {
          id: 'attr_client_name',
          object: 'attribute',
          name: 'Client Name',
          type: 'text',
          primary: true,
          board_id: 'brd_clients',
        },
      }),
    );

    expect(getItemValues).toHaveBeenCalledTimes(1);
    const job = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(job.syncGUID).toBe('guid-old');
    expect(job.data).toEqual(SEEDED_DATA);
  });

  it('skips the reference sweep when the value update itself did not land', async () => {
    await seedBoard({ boardId: 'brd_clients', name: 'Clients' });
    await seedBoard();
    await Item.create({
      workspaceId: 'wsp_1',
      boardId: 'brd_clients',
      folderId: 'fld_clients',
      itemId: CLIENT_ID,
      isoPlusItemId: CLIENT_ID,
      syncGUID: 'guid-old',
      data: { 'Client Name': 'Bianca R', _primaryValue: 'Bianca R' },
    });
    await seedItem();
    getItemValues.mockResolvedValue(null);

    await handleWebhookValueUpdated(
      valuePayload({
        item_id: CLIENT_ID,
        attribute_id: 'attr_client_name',
        board_id: 'brd_clients',
        data: 'Bianca Rossi',
        attribute: {
          id: 'attr_client_name',
          object: 'attribute',
          type: 'reference',
          primary: true,
          board_id: 'brd_clients',
        },
      }),
    );

    expect(getItemValues).toHaveBeenCalledTimes(1);
    const job = await Item.findOne({ itemId: 'itm_job_1' }).lean();
    expect(job.syncGUID).toBe('guid-old');
    expect(job.data).toEqual(SEEDED_DATA);
  });
});
