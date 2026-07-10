export function buildBacklogBulkOp(item, workspaceId, boardId, syncGUID, transformItemData) {
  const itemIdStr = item.id.toString();
  const itemFolderId = item.folder_id ? item.folder_id.toString() : '';
  const transformedData = transformItemData(item);

  return {
    bulkOp: {
      updateOne: {
        filter: { itemId: itemIdStr },
        update: {
          $set: {
            workspaceId,
            boardId,
            folderId: itemFolderId,
            itemId: itemIdStr,
            isoPlusItemId: itemIdStr,
            syncGUID,
            data: transformedData,
            updatedAt: new Date(),
          },
          $setOnInsert: {
            createdAt: new Date(),
          },
        },
        upsert: true,
      },
    },
    itemFolderId,
  };
}

export function collectBulkOpsFromPage(itemsPage, workspaceId, boardId, syncGUID, transformItemData) {
  const bulkOps = [];
  const uniqueFolderIds = new Set();

  for (const item of itemsPage) {
    const { bulkOp, itemFolderId } = buildBacklogBulkOp(item, workspaceId, boardId, syncGUID, transformItemData);
    if (itemFolderId) uniqueFolderIds.add(itemFolderId);
    bulkOps.push(bulkOp);
  }

  return { bulkOps, uniqueFolderIds };
}

export async function executeBulkWriteBatch({
  bulkOps,
  job,
  syncGUID,
  pageNumber,
  totalItemsProcessed,
  totalItemsInserted,
  totalItemsUpdated,
  SyncExecution,
  Item,
  info,
  error,
  BULK_BATCH_SIZE,
}) {
  if (bulkOps.length < BULK_BATCH_SIZE) return { inserted: 0, updated: 0, cleared: false };

  try {
    const bulkResult = await Item.bulkWrite(bulkOps, { ordered: false, wtimeout: 10000 });
    const inserted = bulkResult.upsertedCount || 0;
    const updated = bulkResult.modifiedCount || 0;

    info('Sync-Worker', 'Bulk write completed', {
      jobId: job.id,
      syncGUID,
      batchSize: bulkOps.length,
      upserted: bulkResult.upsertedCount,
      modified: bulkResult.modifiedCount,
    });

    await job.updateProgress({
      stage: 'syncing_items',
      currentPage: pageNumber,
      itemsProcessed: totalItemsProcessed,
      syncGUID,
    });

    if (SyncExecution) {
      await SyncExecution.updateProgress(syncGUID, { currentPage: pageNumber }, {
        itemsProcessed: totalItemsProcessed,
        itemsInserted: totalItemsInserted + inserted,
        itemsUpdated: totalItemsUpdated + updated,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    return { inserted, updated, cleared: true };
  } catch (bulkErr) {
    error('Sync-Worker', 'Bulk write failed', {
      jobId: job.id,
      syncGUID,
      batchSize: bulkOps.length,
      error: bulkErr.message,
    });
    return { inserted: 0, updated: 0, cleared: true };
  }
}

export async function executeFinalBulkWrite({
  bulkOps,
  job,
  syncGUID,
  pageNumber,
  totalItemsProcessed,
  Item,
  info,
  error,
  label,
}) {
  if (!bulkOps.length) return { inserted: 0, updated: 0 };

  try {
    const bulkResult = await Item.bulkWrite(bulkOps, { ordered: false, wtimeout: 10000 });
    info('Sync-Worker', label, {
      jobId: job.id,
      syncGUID,
      batchSize: bulkOps.length,
      upserted: bulkResult.upsertedCount,
      modified: bulkResult.modifiedCount,
    });

    await job.updateProgress({
      stage: 'syncing_items',
      currentPage: pageNumber,
      itemsProcessed: totalItemsProcessed,
      syncGUID,
    });

    return {
      inserted: bulkResult.upsertedCount || 0,
      updated: bulkResult.modifiedCount || 0,
    };
  } catch (bulkErr) {
    error('Sync-Worker', `${label} failed`, {
      jobId: job.id,
      syncGUID,
      error: bulkErr.message,
    });
    return { inserted: 0, updated: 0 };
  }
}

export async function processBacklogItemPages({
  job,
  workspaceId,
  boardId,
  syncGUID,
  startTime,
  SyncExecution,
  itemIterator,
  deps,
}) {
  const {
    checkSyncTimeout,
    transformItemData,
    Item,
    info,
    error,
    warn,
    waitWithBackoff,
    BULK_BATCH_SIZE,
    MAX_RETRIES,
  } = deps;

  let totalItemsProcessed = 0;
  let totalItemsInserted = 0;
  let totalItemsUpdated = 0;
  let pageNumber = 0;
  let bulkOps = [];
  const uniqueFolderIds = new Set();
  let retryCount = 0;

  while (true) {
    try {
      if (checkSyncTimeout(startTime)) throw new Error('SYNC_TIMEOUT');

      const { value: itemsPage, done } = await itemIterator.next();
      if (done) break;

      pageNumber++;
      retryCount = 0;

      info('Sync-Worker', 'Processing board items page', {
        jobId: job.id,
        workspaceId,
        boardId,
        pageNumber,
        pageSize: itemsPage.length,
      });

      const pageResult = collectBulkOpsFromPage(itemsPage, workspaceId, boardId, syncGUID, transformItemData);
      pageResult.uniqueFolderIds.forEach((id) => uniqueFolderIds.add(id));
      bulkOps.push(...pageResult.bulkOps);
      totalItemsProcessed += itemsPage.length;

      const batchResult = await executeBulkWriteBatch({
        bulkOps,
        job,
        syncGUID,
        pageNumber,
        totalItemsProcessed,
        totalItemsInserted,
        totalItemsUpdated,
        SyncExecution,
        Item,
        info,
        error,
        BULK_BATCH_SIZE,
      });
      totalItemsInserted += batchResult.inserted;
      totalItemsUpdated += batchResult.updated;
      if (batchResult.cleared) bulkOps = [];
    } catch (pageErr) {
      if (pageErr.message === 'SYNC_TIMEOUT') throw pageErr;

      retryCount++;
      if (retryCount < MAX_RETRIES) {
        warn('Sync-Worker', 'Page fetch failed, retrying', {
          jobId: job.id,
          retryCount,
          error: pageErr.message,
        });
        await waitWithBackoff(retryCount);
        continue;
      }

      error('Sync-Worker', 'Page fetch failed after max retries', {
        jobId: job.id,
        error: pageErr.message,
      });
      throw pageErr;
    }
  }

  const finalBatch = await executeFinalBulkWrite({
    bulkOps,
    job,
    syncGUID,
    pageNumber,
    totalItemsProcessed,
    Item,
    info,
    error,
    label: 'Final bulk write completed',
  });
  totalItemsInserted += finalBatch.inserted;
  totalItemsUpdated += finalBatch.updated;

  return {
    pageNumber,
    totalItemsProcessed,
    totalItemsInserted,
    totalItemsUpdated,
    uniqueFolderIds,
  };
}

export async function deleteStaleBacklogItems({ boardId, syncGUID, Item, info, warn, job }) {
  try {
    const deleteResult = await Item.deleteMany({ boardId, syncGUID: { $ne: syncGUID } });
    const deletedCount = deleteResult.deletedCount || 0;
    info('Sync-Worker', 'Old records deleted', { jobId: job.id, syncGUID, deletedCount });
    return deletedCount;
  } catch (deleteErr) {
    warn('Sync-Worker', 'Failed to delete old records', {
      jobId: job.id,
      syncGUID,
      error: deleteErr.message,
    });
    return 0;
  }
}

export async function importBacklogTimeTracking({ workspaceId, boardId, job, Item, syncTimeTrackingFromItem, info, warn }) {
  try {
    const ttItems = await Item.find(
      { boardId, workspaceId, 'data._hasTimeTracking': true },
      { itemId: 1, data: 1 },
    ).lean();

    let totalTTImported = 0;
    for (const ttItem of ttItems) {
      totalTTImported += await syncTimeTrackingFromItem(workspaceId, boardId, ttItem.itemId, ttItem.data);
    }

    info('Sync-Worker', 'Time-tracking entries imported from ISO+', {
      jobId: job.id,
      boardId,
      itemsChecked: ttItems.length,
      entriesImported: totalTTImported,
    });
  } catch (ttErr) {
    warn('Sync-Worker', 'Time-tracking sync step failed (non-critical)', {
      jobId: job.id,
      boardId,
      error: ttErr.message,
    });
  }
}

export async function finalizeBacklogSyncSuccess({
  job,
  workspaceId,
  boardId,
  syncGUID,
  startTime,
  SyncExecution,
  stats,
  deps,
}) {
  const {
    Board,
    invalidateCacheForBoard,
    reEnableWebhooksForBoard,
    authorization,
    info,
  } = deps;

  const duration = Date.now() - startTime;
  const { uniqueFolderIds, totalItemsProcessed, totalItemsInserted, totalItemsUpdated, deletedCount } = stats;

  await Board.findOneAndUpdate(
    { boardId },
    {
      $set: {
        syncStatus: 'realtime_sync',
        lastSyncedAt: new Date(),
        lastSyncError: null,
        validationErrors: [],
        currentSyncGUID: syncGUID,
        'syncStats.foldersProcessed': uniqueFolderIds.size,
        'syncStats.itemsSynced': totalItemsProcessed,
        'syncStats.itemsCreated': totalItemsInserted,
        'syncStats.itemsUpdated': totalItemsUpdated,
        'syncStats.itemsDeleted': deletedCount,
        'syncStats.lastBacklogSyncAt': new Date(),
        'syncStats.syncDuration': duration,
        'syncStats.retryCount': 0,
      },
    },
  );

  if (SyncExecution) {
    await SyncExecution.markCompleted(syncGUID, {
      itemsProcessed: totalItemsProcessed,
      itemsInserted: totalItemsInserted,
      itemsUpdated: totalItemsUpdated,
      itemsDeleted: deletedCount,
    });
  }

  invalidateCacheForBoard(workspaceId, boardId);
  info('Sync-Worker', 'Invalidated transformation cache for board', { jobId: job.id, workspaceId, boardId });
  info('Sync-Worker', 'Data backlog sync completed successfully', {
    jobId: job.id,
    workspaceId,
    boardId,
    syncGUID,
    duration,
    stats: {
      folders: uniqueFolderIds.size,
      itemsProcessed: totalItemsProcessed,
      itemsInserted: totalItemsInserted,
      itemsUpdated: totalItemsUpdated,
      itemsDeleted: deletedCount,
    },
  });

  await reEnableWebhooksForBoard(authorization, workspaceId, boardId);

  return {
    success: true,
    nextStep: 'realtime_sync',
    syncGUID,
    stats: {
      foldersProcessed: uniqueFolderIds.size,
      itemsProcessed: totalItemsProcessed,
      itemsInserted: totalItemsInserted,
      itemsUpdated: totalItemsUpdated,
      itemsDeleted: deletedCount,
      duration,
    },
  };
}

export async function handleBacklogSyncFailure({
  err,
  job,
  workspaceId,
  boardId,
  syncGUID,
  SyncExecution,
  deps,
}) {
  const { Board, reEnableWebhooksForBoard, authorization, error } = deps;
  const isTimeout = err.message === 'SYNC_TIMEOUT';

  error('Sync-Worker', isTimeout ? 'Data backlog sync timed out' : 'Data backlog sync failed', {
    jobId: job.id,
    workspaceId,
    boardId,
    syncGUID,
    error: err.message,
    stack: err.stack,
  });

  if (SyncExecution) {
    if (isTimeout) {
      await SyncExecution.markTimeout(syncGUID);
    } else {
      await SyncExecution.markFailed(syncGUID, { message: err.message, stack: err.stack });
    }
  }

  await Board.findOneAndUpdate(
    { boardId },
    {
      $set: {
        syncStatus: 'failed',
        lastSyncError: isTimeout ? 'Sync timed out after 20 minutes' : err.message,
        lastSyncedAt: isTimeout ? null : new Date(),
      },
      $inc: { 'syncStats.retryCount': 1 },
    },
  );

  await reEnableWebhooksForBoard(authorization, workspaceId, boardId);
  throw err;
}

export async function prepareBacklogBoardMetadata({
  authorization,
  workspaceId,
  boardId,
  job,
  syncGUID,
  syncStatus,
  SyncExecution,
  deps,
}) {
  const { disableWebhooksForBoard, Board, getBoard, info } = deps;

  await disableWebhooksForBoard(authorization, workspaceId, boardId);
  await Board.findOneAndUpdate(
    { boardId },
    { $set: { syncStatus, syncJobId: job.id, currentSyncGUID: syncGUID } },
  );

  if (SyncExecution) {
    await SyncExecution.updateProgress(syncGUID, {}, {});
  }

  const boardResponse = await getBoard(authorization, workspaceId);
  if (boardResponse.status !== 200) {
    throw new Error('Failed to fetch board data from ISO+');
  }

  const board = boardResponse.board.find((b) => b.id.toString() === boardId);
  if (!board) throw new Error('Board not found in ISO+');

  await Board.findOneAndUpdate(
    { boardId },
    {
      $set: {
        name: board.name,
        color: board.color || '',
        description: board.description || '',
        og_image: board.og_image || '',
      },
    },
  );

  info('Sync-Worker', 'Fetching board items without folder filter', {
    jobId: job.id,
    workspaceId,
    boardId,
  });
}
