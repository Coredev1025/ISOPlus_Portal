import { describe, it, expect, beforeEach, vi } from 'vitest';

import Item from '../../../src/models/Item.js';
import Board from '../../../src/models/Board.js';
import SyncExecution from '../../../src/models/SyncExecution.js';
import {
  buildBacklogBulkOp,
  collectBulkOpsFromPage,
  executeBulkWriteBatch,
  executeFinalBulkWrite,
  processBacklogItemPages,
  deleteStaleBacklogItems,
  importBacklogTimeTracking,
  finalizeBacklogSyncSuccess,
  handleBacklogSyncFailure,
  prepareBacklogBoardMetadata,
} from '../../../src/utils/syncWorkerBacklogHelpers.js';

/**
 * These helpers are the body of the data-backlog sync: they turn ISO+ item
 * pages into Mongo bulk operations, write them, and then record the outcome on
 * the Board and SyncExecution documents. Every assertion below reads the
 * documents that were actually written rather than the injected doubles, so a
 * helper that logs the right thing while persisting the wrong thing still
 * fails.
 */

const WORKSPACE_ID = '9001';
const BOARD_ID = '4400';
const SYNC_GUID = '11111111-2222-4333-8444-555555555555';

// The real transformItemData collapses an ISO+ item's values[] into a flat map.
// This stand-in keeps the same shape so the stored `data` is realistic.
const transformItemData = (item) => ({
  Name: item.values?.find((v) => v.attribute?.name === 'Name')?.data ?? null,
  _itemId: item.id.toString(),
});

function isoPlusItem(id, folderId, name) {
  return {
    id,
    folder_id: folderId,
    created_at: '2026-01-04T02:00:00.000000Z',
    values: [
      { attribute: { id: 'attr-name', name: 'Name', type: 'text' }, data: name },
    ],
  };
}

function fakeJob(overrides = {}) {
  return {
    id: 'job-backlog-1',
    data: { jobType: 'data_backlog_sync', workspaceId: WORKSPACE_ID, boardId: BOARD_ID },
    progress: [],
    async updateProgress(value) {
      this.progress.push(value);
    },
    ...overrides,
  };
}

const noop = () => {};

async function seedSyncExecution(syncGUID = SYNC_GUID) {
  return SyncExecution.createSyncExecution({
    syncGUID,
    boardId: BOARD_ID,
    workspaceId: WORKSPACE_ID,
    syncType: 'data_backlog_sync',
    triggeredBy: 'system',
    jobId: 'job-backlog-1',
  });
}

describe('buildBacklogBulkOp', () => {
  it('keys the upsert on the stringified ISO+ item id', () => {
    const { bulkOp } = buildBacklogBulkOp(isoPlusItem(88, 12, 'Ada'), WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData);

    expect(bulkOp.updateOne.filter).toEqual({ itemId: '88' });
    expect(bulkOp.updateOne.upsert).toBe(true);
  });

  it('stores the item id in both itemId and isoPlusItemId as strings', () => {
    const { bulkOp } = buildBacklogBulkOp(isoPlusItem(88, 12, 'Ada'), WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData);

    expect(bulkOp.updateOne.update.$set.itemId).toBe('88');
    expect(bulkOp.updateOne.update.$set.isoPlusItemId).toBe('88');
  });

  it('stamps the workspace, board, folder and syncGUID onto the document', () => {
    const { bulkOp, itemFolderId } = buildBacklogBulkOp(
      isoPlusItem(88, 12, 'Ada'), WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData,
    );

    expect(bulkOp.updateOne.update.$set.workspaceId).toBe(WORKSPACE_ID);
    expect(bulkOp.updateOne.update.$set.boardId).toBe(BOARD_ID);
    expect(bulkOp.updateOne.update.$set.folderId).toBe('12');
    expect(bulkOp.updateOne.update.$set.syncGUID).toBe(SYNC_GUID);
    expect(itemFolderId).toBe('12');
  });

  it('substitutes an empty folder id when the item has no folder', () => {
    const { bulkOp, itemFolderId } = buildBacklogBulkOp(
      isoPlusItem(88, null, 'Ada'), WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData,
    );

    expect(itemFolderId).toBe('');
    expect(bulkOp.updateOne.update.$set.folderId).toBe('');
  });

  it('treats folder id 0 as absent, because it is falsy', () => {
    const { itemFolderId } = buildBacklogBulkOp(
      isoPlusItem(88, 0, 'Ada'), WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData,
    );

    expect(itemFolderId).toBe('');
  });

  it('stores the transformed payload, not the raw ISO+ item', () => {
    const { bulkOp } = buildBacklogBulkOp(isoPlusItem(88, 12, 'Ada'), WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData);

    expect(bulkOp.updateOne.update.$set.data).toEqual({ Name: 'Ada', _itemId: '88' });
  });

  it('sets createdAt only on insert so a re-sync does not rewrite it', () => {
    const { bulkOp } = buildBacklogBulkOp(isoPlusItem(88, 12, 'Ada'), WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData);

    expect(Object.keys(bulkOp.updateOne.update.$setOnInsert)).toEqual(['createdAt']);
    expect(bulkOp.updateOne.update.$set.createdAt).toBeUndefined();
    expect(bulkOp.updateOne.update.$set.updatedAt).toBeInstanceOf(Date);
  });
});

describe('collectBulkOpsFromPage', () => {
  it('produces one bulk op per item, in page order', () => {
    const page = [isoPlusItem(1, 7, 'A'), isoPlusItem(2, 7, 'B'), isoPlusItem(3, 8, 'C')];

    const { bulkOps } = collectBulkOpsFromPage(page, WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData);

    expect(bulkOps.map((op) => op.updateOne.filter.itemId)).toEqual(['1', '2', '3']);
  });

  it('deduplicates the folder ids it saw', () => {
    const page = [isoPlusItem(1, 7, 'A'), isoPlusItem(2, 7, 'B'), isoPlusItem(3, 8, 'C')];

    const { uniqueFolderIds } = collectBulkOpsFromPage(page, WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData);

    expect([...uniqueFolderIds].sort()).toEqual(['7', '8']);
  });

  it('does not count folderless items as a folder', () => {
    const page = [isoPlusItem(1, null, 'A'), isoPlusItem(2, 7, 'B')];

    const { uniqueFolderIds } = collectBulkOpsFromPage(page, WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData);

    expect([...uniqueFolderIds]).toEqual(['7']);
  });

  it('returns empty results for an empty page', () => {
    const { bulkOps, uniqueFolderIds } = collectBulkOpsFromPage([], WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData);

    expect(bulkOps).toEqual([]);
    expect(uniqueFolderIds.size).toBe(0);
  });
});

describe('executeBulkWriteBatch', () => {
  function batchArgs(bulkOps, extra = {}) {
    return {
      bulkOps,
      job: fakeJob(),
      syncGUID: SYNC_GUID,
      pageNumber: 2,
      totalItemsProcessed: bulkOps.length,
      totalItemsInserted: 0,
      totalItemsUpdated: 0,
      SyncExecution: null,
      Item,
      info: noop,
      error: noop,
      BULK_BATCH_SIZE: 2,
      ...extra,
    };
  }

  it('writes nothing while the buffer is below the batch size', async () => {
    const { bulkOps } = collectBulkOpsFromPage([isoPlusItem(1, 7, 'A')], WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData);

    const result = await executeBulkWriteBatch(batchArgs(bulkOps));

    expect(result).toEqual({ inserted: 0, updated: 0, cleared: false });
    expect(await Item.countDocuments({})).toBe(0);
  });

  it('flushes the buffer to Mongo once the batch size is reached', async () => {
    const { bulkOps } = collectBulkOpsFromPage(
      [isoPlusItem(1, 7, 'A'), isoPlusItem(2, 7, 'B')], WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData,
    );

    const result = await executeBulkWriteBatch(batchArgs(bulkOps));

    expect(result).toEqual({ inserted: 2, updated: 0, cleared: true });
    const stored = await Item.find({}).sort({ itemId: 1 }).lean();
    expect(stored.map((i) => i.itemId)).toEqual(['1', '2']);
    expect(stored[0].data).toEqual({ Name: 'A', _itemId: '1' });
    expect(stored[0].syncGUID).toBe(SYNC_GUID);
  });

  it('counts a second pass over the same items as updates, not inserts', async () => {
    const first = collectBulkOpsFromPage(
      [isoPlusItem(1, 7, 'A'), isoPlusItem(2, 7, 'B')], WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData,
    );
    await executeBulkWriteBatch(batchArgs(first.bulkOps));

    const second = collectBulkOpsFromPage(
      [isoPlusItem(1, 7, 'A-renamed'), isoPlusItem(2, 7, 'B-renamed')],
      WORKSPACE_ID, BOARD_ID, 'second-guid', transformItemData,
    );
    const result = await executeBulkWriteBatch(batchArgs(second.bulkOps));

    expect(result).toEqual({ inserted: 0, updated: 2, cleared: true });
    const stored = await Item.findOne({ itemId: '1' }).lean();
    expect(stored.data.Name).toBe('A-renamed');
    expect(stored.syncGUID).toBe('second-guid');
  });

  it('records the page and the cumulative counters on the SyncExecution', async () => {
    await seedSyncExecution();
    const { bulkOps } = collectBulkOpsFromPage(
      [isoPlusItem(1, 7, 'A'), isoPlusItem(2, 7, 'B')], WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData,
    );

    await executeBulkWriteBatch(batchArgs(bulkOps, {
      SyncExecution,
      totalItemsProcessed: 202,
      totalItemsInserted: 100,
      totalItemsUpdated: 50,
    }));

    const record = await SyncExecution.findOne({ syncGUID: SYNC_GUID }).lean();
    expect(record.status).toBe('in-progress');
    expect(record.progress.currentPage).toBe(2);
    expect(record.counters.itemsProcessed).toBe(202);
    // 100 already inserted + the 2 this batch inserted.
    expect(record.counters.itemsInserted).toBe(102);
    expect(record.counters.itemsUpdated).toBe(50);
  });

  it('reports progress to the job with the sync stage and page', async () => {
    const job = fakeJob();
    const { bulkOps } = collectBulkOpsFromPage(
      [isoPlusItem(1, 7, 'A'), isoPlusItem(2, 7, 'B')], WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData,
    );

    await executeBulkWriteBatch(batchArgs(bulkOps, { job, totalItemsProcessed: 2 }));

    expect(job.progress).toEqual([
      { stage: 'syncing_items', currentPage: 2, itemsProcessed: 2, syncGUID: SYNC_GUID },
    ]);
  });

  it('clears the buffer but reports no counts when the bulk write throws', async () => {
    const exploding = {
      bulkWrite: async () => { throw new Error('E11000 duplicate key'); },
    };
    const { bulkOps } = collectBulkOpsFromPage(
      [isoPlusItem(1, 7, 'A'), isoPlusItem(2, 7, 'B')], WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData,
    );

    const result = await executeBulkWriteBatch(batchArgs(bulkOps, { Item: exploding }));

    expect(result).toEqual({ inserted: 0, updated: 0, cleared: true });
  });
});

describe('executeFinalBulkWrite', () => {
  function finalArgs(bulkOps, extra = {}) {
    return {
      bulkOps,
      job: fakeJob(),
      syncGUID: SYNC_GUID,
      pageNumber: 3,
      totalItemsProcessed: bulkOps.length,
      Item,
      info: noop,
      error: noop,
      label: 'Final bulk write completed',
      ...extra,
    };
  }

  it('does nothing at all when the buffer is empty', async () => {
    const job = fakeJob();

    const result = await executeFinalBulkWrite(finalArgs([], { job }));

    expect(result).toEqual({ inserted: 0, updated: 0 });
    expect(job.progress).toEqual([]);
  });

  it('writes a leftover buffer smaller than the batch size', async () => {
    const { bulkOps } = collectBulkOpsFromPage([isoPlusItem(9, 7, 'Z')], WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData);

    const result = await executeFinalBulkWrite(finalArgs(bulkOps));

    expect(result).toEqual({ inserted: 1, updated: 0 });
    expect(await Item.findOne({ itemId: '9' }).lean()).toMatchObject({
      boardId: BOARD_ID,
      folderId: '7',
      syncGUID: SYNC_GUID,
    });
  });

  it('swallows a write failure and reports zero counts', async () => {
    const exploding = { bulkWrite: async () => { throw new Error('write concern timeout'); } };
    const { bulkOps } = collectBulkOpsFromPage([isoPlusItem(9, 7, 'Z')], WORKSPACE_ID, BOARD_ID, SYNC_GUID, transformItemData);

    const result = await executeFinalBulkWrite(finalArgs(bulkOps, { Item: exploding }));

    expect(result).toEqual({ inserted: 0, updated: 0 });
  });
});

describe('processBacklogItemPages', () => {
  function iteratorOver(pages, hooks = {}) {
    let index = 0;
    return {
      calls: 0,
      async next() {
        this.calls += 1;
        if (hooks.throwOnCall && hooks.throwOnCall.has(this.calls)) {
          throw hooks.throwOnCall.get(this.calls);
        }
        if (index >= pages.length) return { value: undefined, done: true };
        return { value: pages[index++], done: false };
      },
    };
  }

  function pageDeps(extra = {}) {
    return {
      checkSyncTimeout: () => false,
      transformItemData,
      Item,
      info: noop,
      error: noop,
      warn: noop,
      waitWithBackoff: async () => {},
      BULK_BATCH_SIZE: 2,
      MAX_RETRIES: 3,
      ...extra,
    };
  }

  function pageArgs(itemIterator, extra = {}) {
    return {
      job: fakeJob(),
      workspaceId: WORKSPACE_ID,
      boardId: BOARD_ID,
      syncGUID: SYNC_GUID,
      startTime: Date.now(),
      SyncExecution: null,
      itemIterator,
      deps: pageDeps(),
      ...extra,
    };
  }

  it('returns zeroed stats for a board with no items', async () => {
    const stats = await processBacklogItemPages(pageArgs(iteratorOver([])));

    expect(stats.pageNumber).toBe(0);
    expect(stats.totalItemsProcessed).toBe(0);
    expect(stats.totalItemsInserted).toBe(0);
    expect(stats.totalItemsUpdated).toBe(0);
    expect([...stats.uniqueFolderIds]).toEqual([]);
    expect(await Item.countDocuments({})).toBe(0);
  });

  it('writes every item across pages and totals the counts', async () => {
    const pages = [
      [isoPlusItem(1, 7, 'A'), isoPlusItem(2, 7, 'B')],
      [isoPlusItem(3, 8, 'C')],
    ];

    const stats = await processBacklogItemPages(pageArgs(iteratorOver(pages)));

    expect(stats.pageNumber).toBe(2);
    expect(stats.totalItemsProcessed).toBe(3);
    expect(stats.totalItemsInserted).toBe(3);
    expect(stats.totalItemsUpdated).toBe(0);
    expect([...stats.uniqueFolderIds].sort()).toEqual(['7', '8']);
    const stored = await Item.find({}).sort({ itemId: 1 }).lean();
    expect(stored.map((i) => i.itemId)).toEqual(['1', '2', '3']);
  });

  it('flushes at the batch boundary and again at the end', async () => {
    // BULK_BATCH_SIZE is 2 here: page 1 flushes exactly at the boundary, the
    // single item on page 2 is left for the final write.
    const pages = [
      [isoPlusItem(1, 7, 'A'), isoPlusItem(2, 7, 'B')],
      [isoPlusItem(3, 8, 'C')],
    ];
    const job = fakeJob();

    await processBacklogItemPages(pageArgs(iteratorOver(pages), { job }));

    expect(job.progress).toEqual([
      { stage: 'syncing_items', currentPage: 1, itemsProcessed: 2, syncGUID: SYNC_GUID },
      { stage: 'syncing_items', currentPage: 2, itemsProcessed: 3, syncGUID: SYNC_GUID },
    ]);
  });

  it('aborts with SYNC_TIMEOUT before fetching any page when already over time', async () => {
    const iterator = iteratorOver([[isoPlusItem(1, 7, 'A')]]);

    await expect(processBacklogItemPages(pageArgs(iterator, {
      deps: pageDeps({ checkSyncTimeout: () => true }),
    }))).rejects.toThrow('SYNC_TIMEOUT');

    expect(iterator.calls).toBe(0);
  });

  it('does not retry a SYNC_TIMEOUT', async () => {
    const iterator = iteratorOver([], { throwOnCall: new Map([[1, new Error('SYNC_TIMEOUT')]]) });

    await expect(processBacklogItemPages(pageArgs(iterator))).rejects.toThrow('SYNC_TIMEOUT');

    expect(iterator.calls).toBe(1);
  });

  it('retries a failed page fetch and carries on when the retry succeeds', async () => {
    const iterator = iteratorOver(
      [[isoPlusItem(1, 7, 'A')]],
      { throwOnCall: new Map([[1, new Error('ECONNRESET')]]) },
    );
    const waits = [];

    const stats = await processBacklogItemPages(pageArgs(iterator, {
      deps: pageDeps({ waitWithBackoff: async (n) => { waits.push(n); } }),
    }));

    expect(waits).toEqual([1]);
    expect(stats.totalItemsProcessed).toBe(1);
    expect(await Item.countDocuments({})).toBe(1);
  });

  it('gives up after MAX_RETRIES consecutive failures and rethrows', async () => {
    const iterator = iteratorOver([], {
      throwOnCall: new Map([
        [1, new Error('upstream 503')],
        [2, new Error('upstream 503')],
        [3, new Error('upstream 503')],
      ]),
    });
    const waits = [];

    await expect(processBacklogItemPages(pageArgs(iterator, {
      deps: pageDeps({ waitWithBackoff: async (n) => { waits.push(n); } }),
    }))).rejects.toThrow('upstream 503');

    // Retries 1 and 2 back off; the third failure exhausts MAX_RETRIES = 3.
    expect(waits).toEqual([1, 2]);
    expect(iterator.calls).toBe(3);
  });

  it('resets the retry counter after a page succeeds', async () => {
    // Fail, succeed, fail, succeed: neither run of failures reaches MAX_RETRIES.
    const iterator = iteratorOver(
      [[isoPlusItem(1, 7, 'A')], [isoPlusItem(2, 7, 'B')]],
      { throwOnCall: new Map([[1, new Error('boom')], [3, new Error('boom')]]) },
    );
    const waits = [];

    const stats = await processBacklogItemPages(pageArgs(iterator, {
      deps: pageDeps({ waitWithBackoff: async (n) => { waits.push(n); } }),
    }));

    expect(waits).toEqual([1, 1]);
    expect(stats.totalItemsProcessed).toBe(2);
  });

  it('silently drops a page whose items fail to transform', async () => {
    // The retry path cannot distinguish "the fetch failed" from "the page we
    // already fetched could not be transformed". A transform throw is retried,
    // but the paginator has already advanced past that page, so the retry
    // fetches the *next* page: the bad page's items are lost and the sync still
    // reports success. pageNumber counts the page; totalItemsProcessed does not,
    // because the increment happens after the transform.
    const iterator = iteratorOver([[isoPlusItem(1, 7, 'A')]]);
    const exploding = () => { throw new Error('cannot transform item'); };

    const stats = await processBacklogItemPages(pageArgs(iterator, {
      deps: pageDeps({ transformItemData: exploding }),
    }));

    expect(stats.pageNumber).toBe(1);
    expect(stats.totalItemsProcessed).toBe(0);
    expect(stats.totalItemsInserted).toBe(0);
    expect(await Item.countDocuments({})).toBe(0);
  });

  it('never reaches MAX_RETRIES on transform failures, because each fresh page resets the counter', async () => {
    // retryCount is reset immediately after a successful next(), so consecutive
    // transform failures across different pages each look like the first
    // failure. Every page is dropped and the sync still succeeds.
    const iterator = iteratorOver([
      [isoPlusItem(1, 7, 'A')],
      [isoPlusItem(2, 7, 'B')],
      [isoPlusItem(3, 7, 'C')],
      [isoPlusItem(4, 7, 'D')],
    ]);
    const exploding = () => { throw new Error('cannot transform item'); };

    const stats = await processBacklogItemPages(pageArgs(iterator, {
      deps: pageDeps({ transformItemData: exploding }),
    }));

    expect(stats.pageNumber).toBe(4);
    expect(stats.totalItemsProcessed).toBe(0);
    expect(await Item.countDocuments({})).toBe(0);
  });
});

describe('deleteStaleBacklogItems', () => {
  it('deletes only the items from a previous sync of the same board', async () => {
    await Item.create([
      { workspaceId: WORKSPACE_ID, boardId: BOARD_ID, folderId: '7', itemId: 'keep', syncGUID: SYNC_GUID },
      { workspaceId: WORKSPACE_ID, boardId: BOARD_ID, folderId: '7', itemId: 'stale', syncGUID: 'old-guid' },
      { workspaceId: WORKSPACE_ID, boardId: '9999', folderId: '7', itemId: 'other-board', syncGUID: 'old-guid' },
    ]);

    const deleted = await deleteStaleBacklogItems({
      boardId: BOARD_ID, syncGUID: SYNC_GUID, Item, info: noop, warn: noop, job: fakeJob(),
    });

    expect(deleted).toBe(1);
    const remaining = await Item.find({}).sort({ itemId: 1 }).lean();
    expect(remaining.map((i) => i.itemId)).toEqual(['keep', 'other-board']);
  });

  it('deletes items whose syncGUID is null, since null !== the current GUID', async () => {
    await Item.create({ workspaceId: WORKSPACE_ID, boardId: BOARD_ID, folderId: '7', itemId: 'never-synced' });

    const deleted = await deleteStaleBacklogItems({
      boardId: BOARD_ID, syncGUID: SYNC_GUID, Item, info: noop, warn: noop, job: fakeJob(),
    });

    expect(deleted).toBe(1);
    expect(await Item.countDocuments({})).toBe(0);
  });

  it('returns 0 rather than throwing when the delete fails', async () => {
    const exploding = { deleteMany: async () => { throw new Error('not primary'); } };

    const deleted = await deleteStaleBacklogItems({
      boardId: BOARD_ID, syncGUID: SYNC_GUID, Item: exploding, info: noop, warn: noop, job: fakeJob(),
    });

    expect(deleted).toBe(0);
  });
});

describe('importBacklogTimeTracking', () => {
  it('imports from every item flagged with time tracking and no others', async () => {
    await Item.create([
      {
        workspaceId: WORKSPACE_ID, boardId: BOARD_ID, folderId: '7', itemId: 'tt-1',
        data: { _hasTimeTracking: true, Name: 'Shift 1' },
      },
      {
        workspaceId: WORKSPACE_ID, boardId: BOARD_ID, folderId: '7', itemId: 'tt-2',
        data: { _hasTimeTracking: true, Name: 'Shift 2' },
      },
      {
        workspaceId: WORKSPACE_ID, boardId: BOARD_ID, folderId: '7', itemId: 'plain',
        data: { Name: 'No tracking' },
      },
    ]);
    const seen = [];

    await importBacklogTimeTracking({
      workspaceId: WORKSPACE_ID,
      boardId: BOARD_ID,
      job: fakeJob(),
      Item,
      syncTimeTrackingFromItem: async (wsId, bId, itemId, data) => {
        seen.push({ wsId, bId, itemId, name: data.Name });
        return 2;
      },
      info: noop,
      warn: noop,
    });

    expect(seen.map((s) => s.itemId).sort()).toEqual(['tt-1', 'tt-2']);
    expect(seen[0]).toMatchObject({ wsId: WORKSPACE_ID, bId: BOARD_ID });
    expect(seen.map((s) => s.name).sort()).toEqual(['Shift 1', 'Shift 2']);
  });

  it('ignores time-tracking items belonging to another workspace', async () => {
    await Item.create({
      workspaceId: 'other-workspace', boardId: BOARD_ID, folderId: '7', itemId: 'tt-elsewhere',
      data: { _hasTimeTracking: true },
    });
    const seen = [];

    await importBacklogTimeTracking({
      workspaceId: WORKSPACE_ID,
      boardId: BOARD_ID,
      job: fakeJob(),
      Item,
      syncTimeTrackingFromItem: async (_w, _b, itemId) => { seen.push(itemId); return 0; },
      info: noop,
      warn: noop,
    });

    expect(seen).toEqual([]);
  });

  it('does not throw when an individual import fails — the step is non-critical', async () => {
    await Item.create({
      workspaceId: WORKSPACE_ID, boardId: BOARD_ID, folderId: '7', itemId: 'tt-1',
      data: { _hasTimeTracking: true },
    });

    await expect(importBacklogTimeTracking({
      workspaceId: WORKSPACE_ID,
      boardId: BOARD_ID,
      job: fakeJob(),
      Item,
      syncTimeTrackingFromItem: async () => { throw new Error('ISO+ rejected the entry'); },
      info: noop,
      warn: noop,
    })).resolves.toBeUndefined();
  });
});

describe('finalizeBacklogSyncSuccess', () => {
  const stats = {
    uniqueFolderIds: new Set(['7', '8']),
    totalItemsProcessed: 30,
    totalItemsInserted: 20,
    totalItemsUpdated: 10,
    deletedCount: 4,
  };

  function successArgs(extra = {}) {
    return {
      job: fakeJob(),
      workspaceId: WORKSPACE_ID,
      boardId: BOARD_ID,
      syncGUID: SYNC_GUID,
      startTime: Date.now() - 1000,
      SyncExecution: null,
      stats,
      deps: {
        Board,
        invalidateCacheForBoard: noop,
        reEnableWebhooksForBoard: async () => {},
        authorization: 'Bearer token',
        info: noop,
      },
      ...extra,
    };
  }

  beforeEach(async () => {
    await Board.create({ boardId: BOARD_ID, name: 'Master Plan', syncStatus: 'data_backlog_sync' });
  });

  it('moves the board into realtime_sync and clears the previous error', async () => {
    await Board.updateOne({ boardId: BOARD_ID }, { $set: { lastSyncError: 'earlier failure', validationErrors: ['x'] } });

    await finalizeBacklogSyncSuccess(successArgs());

    const board = await Board.findOne({ boardId: BOARD_ID }).lean();
    expect(board.syncStatus).toBe('realtime_sync');
    expect(board.lastSyncError).toBeNull();
    expect(board.validationErrors).toEqual([]);
    expect(board.currentSyncGUID).toBe(SYNC_GUID);
    expect(board.lastSyncedAt).toBeInstanceOf(Date);
  });

  it('writes the folder and item counts into syncStats', async () => {
    await finalizeBacklogSyncSuccess(successArgs());

    const board = await Board.findOne({ boardId: BOARD_ID }).lean();
    expect(board.syncStats.foldersProcessed).toBe(2);
    expect(board.syncStats.itemsSynced).toBe(30);
    expect(board.syncStats.itemsCreated).toBe(20);
    expect(board.syncStats.itemsUpdated).toBe(10);
    expect(board.syncStats.retryCount).toBe(0);
    expect(board.syncStats.lastBacklogSyncAt).toBeInstanceOf(Date);
  });

  it('silently drops itemsDeleted and syncDuration, which the Board schema never declared', async () => {
    // Characterizing real drift: the helper sets 'syncStats.itemsDeleted' and
    // 'syncStats.syncDuration', but Board.syncStats declares neither, so
    // Mongoose strips both. The returned stats object still carries them.
    const result = await finalizeBacklogSyncSuccess(successArgs());

    const board = await Board.findOne({ boardId: BOARD_ID }).lean();
    expect(board.syncStats.itemsDeleted).toBeUndefined();
    expect(board.syncStats.syncDuration).toBeUndefined();
    expect(result.stats.itemsDeleted).toBe(4);
  });

  it('marks the SyncExecution completed with the final counters', async () => {
    await seedSyncExecution();

    await finalizeBacklogSyncSuccess(successArgs({ SyncExecution }));

    const record = await SyncExecution.findOne({ syncGUID: SYNC_GUID }).lean();
    expect(record.status).toBe('completed');
    expect(record.counters).toMatchObject({
      itemsProcessed: 30,
      itemsInserted: 20,
      itemsUpdated: 10,
      itemsDeleted: 4,
    });
    expect(record.endTime).toBeInstanceOf(Date);
    expect(record.lastSyncedAt).toBeInstanceOf(Date);
  });

  it('leaves the SyncExecution alone when no record was created', async () => {
    await seedSyncExecution();

    await finalizeBacklogSyncSuccess(successArgs({ SyncExecution: null }));

    const record = await SyncExecution.findOne({ syncGUID: SYNC_GUID }).lean();
    expect(record.status).toBe('started');
  });

  it('re-enables the board webhooks with the job authorization', async () => {
    const reEnabled = [];

    await finalizeBacklogSyncSuccess(successArgs({
      deps: {
        Board,
        invalidateCacheForBoard: noop,
        reEnableWebhooksForBoard: async (auth, wsId, bId) => { reEnabled.push([auth, wsId, bId]); },
        authorization: 'Bearer job-token',
        info: noop,
      },
    }));

    expect(reEnabled).toEqual([['Bearer job-token', WORKSPACE_ID, BOARD_ID]]);
  });

  it('invalidates the transform cache for the workspace and board', async () => {
    const invalidated = [];

    await finalizeBacklogSyncSuccess(successArgs({
      deps: {
        Board,
        invalidateCacheForBoard: (wsId, bId) => { invalidated.push([wsId, bId]); },
        reEnableWebhooksForBoard: async () => {},
        authorization: 'Bearer token',
        info: noop,
      },
    }));

    expect(invalidated).toEqual([[WORKSPACE_ID, BOARD_ID]]);
  });

  it('returns the realtime_sync next step and a duration derived from startTime', async () => {
    const startTime = Date.now() - 5000;

    const result = await finalizeBacklogSyncSuccess(successArgs({ startTime }));

    expect(result.success).toBe(true);
    expect(result.nextStep).toBe('realtime_sync');
    expect(result.syncGUID).toBe(SYNC_GUID);
    expect(result.stats.foldersProcessed).toBe(2);
    expect(result.stats.itemsProcessed).toBe(30);
    expect(result.stats.itemsInserted).toBe(20);
    expect(result.stats.itemsUpdated).toBe(10);
    expect(result.stats.duration).toBeGreaterThanOrEqual(5000);
  });
});

describe('handleBacklogSyncFailure', () => {
  function failureArgs(err, extra = {}) {
    return {
      err,
      job: fakeJob(),
      workspaceId: WORKSPACE_ID,
      boardId: BOARD_ID,
      syncGUID: SYNC_GUID,
      SyncExecution: null,
      deps: {
        Board,
        reEnableWebhooksForBoard: async () => {},
        authorization: 'Bearer token',
        error: noop,
      },
      ...extra,
    };
  }

  beforeEach(async () => {
    await Board.create({
      boardId: BOARD_ID,
      name: 'Master Plan',
      syncStatus: 'data_backlog_sync',
      syncStats: { retryCount: 1 },
    });
  });

  it('rethrows the original error so BullMQ sees the job as failed', async () => {
    const err = new Error('ISO+ returned 500');

    await expect(handleBacklogSyncFailure(failureArgs(err))).rejects.toBe(err);
  });

  it('records the failure message on the board and bumps the retry count', async () => {
    await expect(handleBacklogSyncFailure(failureArgs(new Error('ISO+ returned 500')))).rejects.toThrow();

    const board = await Board.findOne({ boardId: BOARD_ID }).lean();
    expect(board.syncStatus).toBe('failed');
    expect(board.lastSyncError).toBe('ISO+ returned 500');
    expect(board.lastSyncedAt).toBeInstanceOf(Date);
    expect(board.syncStats.retryCount).toBe(2);
  });

  it('uses the timeout wording and nulls lastSyncedAt for SYNC_TIMEOUT', async () => {
    await expect(handleBacklogSyncFailure(failureArgs(new Error('SYNC_TIMEOUT')))).rejects.toThrow();

    const board = await Board.findOne({ boardId: BOARD_ID }).lean();
    expect(board.syncStatus).toBe('failed');
    expect(board.lastSyncError).toBe('Sync timed out after 20 minutes');
    expect(board.lastSyncedAt).toBeNull();
  });

  it('marks the SyncExecution failed with the error message and stack', async () => {
    await seedSyncExecution();
    const err = new Error('ISO+ returned 500');

    await expect(handleBacklogSyncFailure(failureArgs(err, { SyncExecution }))).rejects.toThrow();

    const record = await SyncExecution.findOne({ syncGUID: SYNC_GUID }).lean();
    expect(record.status).toBe('failed');
    expect(record.error.message).toBe('ISO+ returned 500');
    expect(record.error.stack).toBe(err.stack);
  });

  it('marks the SyncExecution timeout — not failed — for SYNC_TIMEOUT', async () => {
    await seedSyncExecution();

    await expect(handleBacklogSyncFailure(failureArgs(new Error('SYNC_TIMEOUT'), { SyncExecution })))
      .rejects.toThrow();

    const record = await SyncExecution.findOne({ syncGUID: SYNC_GUID }).lean();
    expect(record.status).toBe('timeout');
    expect(record.error.message).toBe('Sync operation timed out (exceeded 20 minutes)');
    expect(record.lastSyncedAt).toBeNull();
  });

  it('re-enables the webhooks before rethrowing, so a failed board keeps receiving events', async () => {
    const reEnabled = [];

    await expect(handleBacklogSyncFailure(failureArgs(new Error('boom'), {
      deps: {
        Board,
        reEnableWebhooksForBoard: async (auth, wsId, bId) => { reEnabled.push([auth, wsId, bId]); },
        authorization: 'Bearer job-token',
        error: noop,
      },
    }))).rejects.toThrow('boom');

    expect(reEnabled).toEqual([['Bearer job-token', WORKSPACE_ID, BOARD_ID]]);
  });
});

describe('prepareBacklogBoardMetadata', () => {
  const boardFromIsoPlus = {
    id: 4400,
    name: 'Master Plan (NDIS)',
    color: '#112233',
    description: 'All master plan records',
    og_image: 'https://cdn.example.com/board.png',
  };

  function metadataArgs(extra = {}) {
    return {
      authorization: 'Bearer token',
      workspaceId: WORKSPACE_ID,
      boardId: BOARD_ID,
      job: fakeJob(),
      syncGUID: SYNC_GUID,
      syncStatus: 'data_backlog_sync',
      SyncExecution: null,
      deps: {
        disableWebhooksForBoard: async () => {},
        Board,
        getBoard: async () => ({ board: [boardFromIsoPlus], status: 200 }),
        info: noop,
      },
      ...extra,
    };
  }

  beforeEach(async () => {
    await Board.create({ boardId: BOARD_ID, name: 'stale name', syncStatus: 'board_valid' });
  });

  it('claims the board for this job before doing any network work', async () => {
    await prepareBacklogBoardMetadata(metadataArgs());

    const board = await Board.findOne({ boardId: BOARD_ID }).lean();
    expect(board.syncStatus).toBe('data_backlog_sync');
    expect(board.syncJobId).toBe('job-backlog-1');
    expect(board.currentSyncGUID).toBe(SYNC_GUID);
  });

  it('uses the caller-supplied syncStatus, which a manual sync overrides', async () => {
    await prepareBacklogBoardMetadata(metadataArgs({ syncStatus: 'manual_triggered_sync' }));

    const board = await Board.findOne({ boardId: BOARD_ID }).lean();
    expect(board.syncStatus).toBe('manual_triggered_sync');
  });

  it('copies the ISO+ board name, colour, description and image onto the record', async () => {
    await prepareBacklogBoardMetadata(metadataArgs());

    const board = await Board.findOne({ boardId: BOARD_ID }).lean();
    expect(board.name).toBe('Master Plan (NDIS)');
    expect(board.color).toBe('#112233');
    expect(board.description).toBe('All master plan records');
    expect(board.og_image).toBe('https://cdn.example.com/board.png');
  });

  it('substitutes empty strings for optional ISO+ fields that are absent', async () => {
    await prepareBacklogBoardMetadata(metadataArgs({
      deps: {
        disableWebhooksForBoard: async () => {},
        Board,
        getBoard: async () => ({ board: [{ id: 4400, name: 'Bare Board' }], status: 200 }),
        info: noop,
      },
    }));

    const board = await Board.findOne({ boardId: BOARD_ID }).lean();
    expect(board.color).toBe('');
    expect(board.description).toBe('');
    expect(board.og_image).toBe('');
  });

  it('disables the webhooks first, so the sync does not race incoming events', async () => {
    const calls = [];

    await prepareBacklogBoardMetadata(metadataArgs({
      deps: {
        disableWebhooksForBoard: async (auth, wsId, bId) => { calls.push(['disable', auth, wsId, bId]); },
        Board,
        getBoard: async () => { calls.push(['getBoard']); return { board: [boardFromIsoPlus], status: 200 }; },
        info: noop,
      },
    }));

    expect(calls).toEqual([
      ['disable', 'Bearer token', WORKSPACE_ID, BOARD_ID],
      ['getBoard'],
    ]);
  });

  it('throws when ISO+ does not return 200 for the board list', async () => {
    await expect(prepareBacklogBoardMetadata(metadataArgs({
      deps: {
        disableWebhooksForBoard: async () => {},
        Board,
        getBoard: async () => ({ message: 'upstream exploded', status: 500 }),
        info: noop,
      },
    }))).rejects.toThrow('Failed to fetch board data from ISO+');
  });

  it('throws when the board is missing from the ISO+ response', async () => {
    await expect(prepareBacklogBoardMetadata(metadataArgs({
      deps: {
        disableWebhooksForBoard: async () => {},
        Board,
        getBoard: async () => ({ board: [{ id: 12345, name: 'Some other board' }], status: 200 }),
        info: noop,
      },
    }))).rejects.toThrow('Board not found in ISO+');
  });

  it('matches the board by its stringified ISO+ numeric id', async () => {
    // ISO+ returns numeric ids; boardId in Mongo is a string. The helper
    // compares b.id.toString() === boardId, so a numeric 4400 must match "4400".
    await expect(prepareBacklogBoardMetadata(metadataArgs())).resolves.toBeUndefined();
    expect((await Board.findOne({ boardId: BOARD_ID }).lean()).name).toBe('Master Plan (NDIS)');
  });

  it('moves the SyncExecution to in-progress before the first page', async () => {
    await seedSyncExecution();

    await prepareBacklogBoardMetadata(metadataArgs({ SyncExecution }));

    const record = await SyncExecution.findOne({ syncGUID: SYNC_GUID }).lean();
    expect(record.status).toBe('in-progress');
    expect(record.lastUpdatedAt).toBeInstanceOf(Date);
  });
});
