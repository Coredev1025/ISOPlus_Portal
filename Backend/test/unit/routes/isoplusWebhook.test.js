import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { http, HttpResponse } from 'msw';
import { createApp } from '../../../src/app.js';
import { server } from '../../msw/server.js';
import Board from '../../../src/models/Board.js';
import Item from '../../../src/models/Item.js';

/**
 * Complements test/integration/isoplusWebhook.route.test.js, which only covers
 * the 400 and a comment event. These tests drive the event switch and the
 * database writes each handler performs.
 *
 * The route is deliberately unauthenticated — ISO+ posts to it directly — and
 * it answers 200 even for failures so ISO+ does not retry forever. That
 * asymmetry (400 only for a structurally invalid body) is pinned below.
 */

const app = createApp();
const API_BASE = 'https://app.isoplus.online/api/v2';

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

const post = (body) => request(app).post('/api/webhooks/isoplus').send(body);

async function seedBoard(overrides = {}) {
  const boardId = overrides.boardId || nextId('board');
  await Board.create({
    boardId,
    name: 'Master Plan',
    workspaceId: 'ws-1',
    syncData: true,
    ...overrides,
  });
  return boardId;
}

async function seedItem(overrides = {}) {
  const itemId = overrides.itemId || nextId('item');
  await Item.create({
    itemId,
    isoPlusItemId: itemId,
    workspaceId: 'ws-1',
    boardId: overrides.boardId || nextId('board'),
    folderId: 'f1',
    data: { Title: 'before' },
    ...overrides,
  });
  return itemId;
}

describe('POST /api/webhooks/isoplus payload validation', () => {
  it('rejects a body with an event but no payload', async () => {
    const res = await post({ event: 'item.created' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, message: 'Invalid hook payload' });
  });

  it('rejects a body with a payload but no event', async () => {
    const res = await post({ payload: { id: 'i1' } });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, message: 'Invalid hook payload' });
  });

  it('acknowledges an event type it does not handle without touching the database', async () => {
    const res = await post({ event: 'board.archived', payload: { id: 'b1' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Event acknowledged' });
  });

  it('reports a handled event with the processed message, not the acknowledged one', async () => {
    const res = await post({ event: 'comment.updated', payload: { id: 'c1', item_id: 'i1' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Hook processed successfully' });
  });
});

describe('POST /api/webhooks/isoplus failure reporting', () => {
  it('answers 200 with success:false when a handler throws', async () => {
    // value.created reads mongoEq(payload.item_id) before the `if (!itemId)`
    // guard, and mongoEq throws on undefined rather than returning null — so
    // the guard is unreachable and the error surfaces here instead.
    const res = await post({ event: 'value.created', payload: { id: 'v1' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: false,
      message: 'Failed to process hook',
      error: 'Invalid query value: expected a plain string, number, boolean, or bigint.',
    });
  });

  it('answers 200 with success:false when item.deleted carries no id', async () => {
    const res = await post({ event: 'item.deleted', payload: {} });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe(
      'Invalid query value: expected a plain string, number, boolean, or bigint.'
    );
  });
});

describe('item.deleted', () => {
  it('deletes the local item and decrements the board item count', async () => {
    const boardId = await seedBoard();
    const itemId = await seedItem({ boardId });
    await Board.findOneAndUpdate({ boardId }, { $set: { 'syncStats.itemsSynced': 5 } });

    const res = await post({ event: 'item.deleted', payload: { id: itemId, board_id: boardId } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(await Item.findOne({ itemId }).lean()).toBeNull();

    const board = await Board.findOne({ boardId }).lean();
    expect(board.syncStats.itemsSynced).toBe(4);
  });

  it('leaves the item alone when the board is not sync-enabled', async () => {
    const boardId = await seedBoard({ syncData: false });
    const itemId = await seedItem({ boardId });

    const res = await post({ event: 'item.deleted', payload: { id: itemId, board_id: boardId } });

    expect(res.status).toBe(200);
    expect(await Item.findOne({ itemId }).lean()).not.toBeNull();
  });

  it('falls back to the stored boardId when the payload has no board_id (KAN-281)', async () => {
    // Previously mongoEq threw on the missing board_id before the stored-boardId
    // lookup could run, so the item survived a delete event that omitted it.
    const boardId = await seedBoard();
    await Board.findOneAndUpdate({ boardId }, { $set: { 'syncStats.itemsSynced': 2 } });
    const itemId = await seedItem({ boardId });

    const res = await post({ event: 'item.deleted', payload: { id: itemId } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(await Item.findOne({ itemId }).lean()).toBeNull();
    const board = await Board.findOne({ boardId }).lean();
    expect(board.syncStats.itemsSynced).toBe(1);
  });

  it('acknowledges without error when board_id is absent and the item is not stored (KAN-281)', async () => {
    const res = await post({ event: 'item.deleted', payload: { id: nextId('item') } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Hook processed successfully' });
  });

  it('does not decrement the counter when the item was already gone', async () => {
    const boardId = await seedBoard();
    await Board.findOneAndUpdate({ boardId }, { $set: { 'syncStats.itemsSynced': 3 } });

    const res = await post({
      event: 'item.deleted',
      payload: { id: nextId('item'), board_id: boardId },
    });

    expect(res.status).toBe(200);
    const board = await Board.findOne({ boardId }).lean();
    expect(board.syncStats.itemsSynced).toBe(3);
  });
});

describe('item.created', () => {
  it('is a no-op when the item is already stored', async () => {
    const boardId = await seedBoard();
    const itemId = await seedItem({ boardId });

    const res = await post({
      event: 'item.created',
      payload: { id: itemId, board_id: boardId, workspace_id: 'ws-1' },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const stored = await Item.findOne({ itemId }).lean();
    expect(stored.data).toEqual({ Title: 'before' });
  });

  it('fetches the item from ISO+ and stores it when it is new', async () => {
    const boardId = await seedBoard();
    const itemId = nextId('item');
    server.use(
      http.get(`${API_BASE}/workspaces/ws-1/boards/${boardId}/items/${itemId}`, () =>
        HttpResponse.json({
          id: itemId,
          folder_id: 'folder-9',
          values: [
            { data: 'Fresh title', attribute: { id: 'a1', name: 'Title', type: 'text' } },
            { data: 12, attribute: { id: 'a2', name: 'Quantity', type: 'number' } },
          ],
        })
      )
    );

    const res = await post({
      event: 'item.created',
      payload: { id: itemId, board_id: boardId, workspace_id: 'ws-1' },
    });

    expect(res.status).toBe(200);
    const stored = await Item.findOne({ itemId }).lean();
    expect(stored.workspaceId).toBe('ws-1');
    expect(stored.boardId).toBe(boardId);
    expect(stored.folderId).toBe('folder-9');
    expect(stored.data.Title).toBe('Fresh title');
    expect(stored.data.Quantity).toBe(12);
  });

  it('deletes the local copy when ISO+ answers 404 for the new item', async () => {
    const boardId = await seedBoard();
    const itemId = await seedItem({ boardId: nextId('otherboard') });
    // Force the API path: the item is in the database under a different board,
    // so it is found locally first. Use a genuinely unknown id instead.
    const unknownId = nextId('item');
    server.use(
      http.get(`${API_BASE}/workspaces/ws-1/boards/${boardId}/items/${unknownId}`, () =>
        HttpResponse.json({ message: 'Not found' }, { status: 404 })
      )
    );

    const res = await post({
      event: 'item.created',
      payload: { id: unknownId, board_id: boardId, workspace_id: 'ws-1' },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // The pre-existing unrelated item is untouched.
    expect(await Item.findOne({ itemId }).lean()).not.toBeNull();
  });
});

describe('item.updated', () => {
  it('replaces the stored data with a fresh fetch from ISO+ and clears the syncGUID', async () => {
    const boardId = await seedBoard();
    const itemId = await seedItem({ boardId, syncGUID: 'guid-from-last-backlog' });
    server.use(
      http.get(`${API_BASE}/workspaces/ws-1/boards/${boardId}/items/${itemId}`, () =>
        HttpResponse.json({
          id: itemId,
          values: [{ data: 'after', attribute: { id: 'a1', name: 'Title', type: 'text' } }],
        })
      )
    );

    const res = await post({
      event: 'item.updated',
      payload: { id: itemId, board_id: boardId, workspace_id: 'ws-1' },
    });

    expect(res.status).toBe(200);
    const stored = await Item.findOne({ itemId }).lean();
    expect(stored.data.Title).toBe('after');
    expect(stored.syncGUID).toBeNull();
  });

  it('deletes the local copy when ISO+ reports the item as gone', async () => {
    const boardId = await seedBoard();
    const itemId = await seedItem({ boardId });
    server.use(
      http.get(`${API_BASE}/workspaces/ws-1/boards/${boardId}/items/${itemId}`, () =>
        HttpResponse.json({ message: 'Not found' }, { status: 404 })
      )
    );

    const res = await post({
      event: 'item.updated',
      payload: { id: itemId, board_id: boardId, workspace_id: 'ws-1' },
    });

    expect(res.status).toBe(200);
    expect(await Item.findOne({ itemId }).lean()).toBeNull();
  });

  it('leaves the item untouched when its board is not sync-enabled', async () => {
    const boardId = await seedBoard({ syncData: false });
    const itemId = await seedItem({ boardId });

    const res = await post({
      event: 'item.updated',
      payload: { id: itemId, board_id: boardId, workspace_id: 'ws-1' },
    });

    expect(res.status).toBe(200);
    const stored = await Item.findOne({ itemId }).lean();
    expect(stored.data).toEqual({ Title: 'before' });
  });
});

describe('item.finalized', () => {
  it('writes the transformed payload straight to the item without re-fetching', async () => {
    const boardId = await seedBoard();
    const itemId = await seedItem({ boardId, syncGUID: 'old-guid' });

    const res = await post({
      event: 'item.finalized',
      payload: {
        id: itemId,
        board_id: boardId,
        workspace_id: 'ws-1',
        values: [
          { data: 'finalized title', attribute: { id: 'a1', name: 'Title', type: 'text' } },
          { data: 'skipped', deleted: true, attribute: { id: 'a2', name: 'Removed', type: 'text' } },
        ],
      },
    });

    expect(res.status).toBe(200);
    const stored = await Item.findOne({ itemId }).lean();
    expect(stored.data.Title).toBe('finalized title');
    expect(stored.data.Removed).toBeUndefined();
    expect(stored.syncGUID).toBeNull();
  });

  it('does not write when the board is not sync-enabled', async () => {
    const boardId = await seedBoard({ syncData: false });
    const itemId = await seedItem({ boardId });

    const res = await post({
      event: 'item.finalized',
      payload: {
        id: itemId,
        board_id: boardId,
        workspace_id: 'ws-1',
        values: [{ data: 'ignored', attribute: { id: 'a1', name: 'Title', type: 'text' } }],
      },
    });

    expect(res.status).toBe(200);
    const stored = await Item.findOne({ itemId }).lean();
    expect(stored.data).toEqual({ Title: 'before' });
  });
});

describe('payloads without board_id / workspace_id (KAN-281)', () => {
  // ISO+ can send item events with only the item id (a cloned shift did). The
  // handlers must fall back to searching the synced boards instead of throwing.
  const itemUrl = (workspaceId, boardId, itemId) =>
    `${API_BASE}/workspaces/${workspaceId}/boards/${boardId}/items/${itemId}`;
  const freshItem = (itemId) => HttpResponse.json({
    id: itemId,
    folder_id: 'folder-9',
    values: [{ data: 'Cloned title', attribute: { id: 'a1', name: 'Title', type: 'text' } }],
  });

  it('stores a new item from item.created when the payload has no board_id or workspace_id', async () => {
    const boardId = await seedBoard();
    const itemId = nextId('item');
    server.use(http.get(itemUrl('ws-1', boardId, itemId), () => freshItem(itemId)));

    const res = await post({ event: 'item.created', payload: { id: itemId } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const stored = await Item.findOne({ itemId }).lean();
    expect(stored.boardId).toBe(boardId);
    expect(stored.workspaceId).toBe('ws-1');
    expect(stored.data.Title).toBe('Cloned title');
  });

  it('finds the item on a later synced board when an earlier board answers 404 for it', async () => {
    // A 404 from one board means "not on this board", not "deleted in ISO+".
    const firstBoard = await seedBoard({ workspaceId: 'ws-other' });
    const secondBoard = await seedBoard({ workspaceId: 'ws-1' });
    const itemId = nextId('item');
    server.use(
      http.get(itemUrl('ws-other', firstBoard, itemId), () =>
        HttpResponse.json({ message: 'Not found' }, { status: 404 })),
      http.get(itemUrl('ws-1', secondBoard, itemId), () => freshItem(itemId)),
    );

    const res = await post({ event: 'item.created', payload: { id: itemId } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const stored = await Item.findOne({ itemId }).lean();
    expect(stored.boardId).toBe(secondBoard);
    expect(stored.workspaceId).toBe('ws-1');
  });

  it('treats the item as deleted only when every synced board answers 404', async () => {
    const boardA = await seedBoard({ workspaceId: 'ws-1' });
    const boardB = await seedBoard({ workspaceId: 'ws-2' });
    const itemId = nextId('item');
    server.use(
      http.get(itemUrl('ws-1', boardA, itemId), () =>
        HttpResponse.json({ message: 'Not found' }, { status: 404 })),
      http.get(itemUrl('ws-2', boardB, itemId), () =>
        HttpResponse.json({ message: 'Not found' }, { status: 404 })),
    );

    const res = await post({ event: 'item.created', payload: { id: itemId } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(await Item.findOne({ itemId }).lean()).toBeNull();
  });

  it('applies an item.finalized payload with no board_id or workspace_id to the stored item', async () => {
    const boardId = await seedBoard();
    const itemId = await seedItem({ boardId, syncGUID: 'old-guid' });

    const res = await post({
      event: 'item.finalized',
      payload: {
        id: itemId,
        values: [{ data: 'finalized title', attribute: { id: 'a1', name: 'Title', type: 'text' } }],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const stored = await Item.findOne({ itemId }).lean();
    expect(stored.data.Title).toBe('finalized title');
    expect(stored.syncGUID).toBeNull();
  });

  it('stores a new item from item.finalized when the payload has no board_id or workspace_id', async () => {
    const boardId = await seedBoard();
    const itemId = nextId('item');
    server.use(http.get(itemUrl('ws-1', boardId, itemId), () => freshItem(itemId)));

    const res = await post({
      event: 'item.finalized',
      payload: {
        id: itemId,
        values: [{ data: 'finalized title', attribute: { id: 'a1', name: 'Title', type: 'text' } }],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const stored = await Item.findOne({ itemId }).lean();
    expect(stored.boardId).toBe(boardId);
    expect(stored.data.Title).toBe('finalized title');
  });

  it('refreshes a stored item from item.updated when the payload has no board_id or workspace_id', async () => {
    const boardId = await seedBoard();
    const itemId = await seedItem({ boardId });
    server.use(http.get(itemUrl('ws-1', boardId, itemId), () => freshItem(itemId)));

    const res = await post({ event: 'item.updated', payload: { id: itemId } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('value.created', () => {
  it('refreshes the whole item from ISO+ when a value appears', async () => {
    const boardId = await seedBoard();
    const itemId = await seedItem({ boardId, syncGUID: 'old-guid' });
    server.use(
      http.get(`${API_BASE}/workspaces/ws-1/boards/${boardId}/items/${itemId}`, () =>
        HttpResponse.json({
          id: itemId,
          values: [
            { data: 'before', attribute: { id: 'a1', name: 'Title', type: 'text' } },
            { data: 'new value', attribute: { id: 'a2', name: 'Notes', type: 'text' } },
          ],
        })
      )
    );

    const res = await post({
      event: 'value.created',
      payload: { id: 'v1', item_id: itemId, attribute_id: 'a2' },
    });

    expect(res.status).toBe(200);
    const stored = await Item.findOne({ itemId }).lean();
    expect(stored.data.Notes).toBe('new value');
    expect(stored.syncGUID).toBeNull();
  });

  it('reads the one board named in the payload instead of scanning every board', async () => {
    await seedBoard();
    const boardId = await seedBoard();
    const itemId = nextId('item');
    let reads = 0;
    server.use(
      http.get(`${API_BASE}/workspaces/ws-1/boards/:board/items/${itemId}`, ({ params }) => {
        reads += 1;
        return params.board === boardId
          ? HttpResponse.json({ id: itemId, values: [{ data: 'hi', attribute: { id: 'a1', name: 'Title', type: 'text' } }] })
          : HttpResponse.json({ message: 'Not found' }, { status: 404 });
      })
    );

    const res = await post({
      event: 'value.created',
      payload: { id: 'v1', item_id: itemId, attribute_id: 'a1', board_id: boardId, workspace_id: 'ws-1' },
    });

    expect(res.status).toBe(200);
    expect(reads).toBe(2); // one to create the item, one for the value refresh, both on the named board
    expect((await Item.findOne({ itemId }).lean()).boardId).toBe(boardId);
  });

  it('does nothing when the item is not in the database and no board is syncing', async () => {
    const res = await post({
      event: 'value.created',
      payload: { id: 'v1', item_id: nextId('item'), attribute_id: 'a2' },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Hook processed successfully' });
  });
});

describe('value.updated', () => {
  it('patches only the named attribute on the stored item', async () => {
    const boardId = await seedBoard();
    const itemId = await seedItem({ boardId, data: { Title: 'before', Notes: 'keep me' } });

    const res = await post({
      event: 'value.updated',
      payload: {
        id: 'v1',
        item_id: itemId,
        attribute_id: 'a1',
        data: 'patched',
        attribute: { id: 'a1', name: 'Title', type: 'text' },
      },
    });

    expect(res.status).toBe(200);
    const stored = await Item.findOne({ itemId }).lean();
    expect(stored.data.Title).toBe('patched');
    expect(stored.data.Notes).toBe('keep me');
  });
});
