import { describe, it, expect } from 'vitest';
import Item from '../../../src/models/Item.js';

describe('Item model', () => {
  it('requires workspaceId, boardId, folderId, itemId', async () => {
    await expect(Item.create({})).rejects.toThrow();
  });

  it('sets isoPlusItemId from itemId on save', async () => {
    const item = await Item.create({
      workspaceId: 'ws',
      boardId: 'b',
      folderId: 'f',
      itemId: 'item-1',
      data: { a: 1 },
    });
    expect(item.isoPlusItemId).toBe('item-1');
    expect(item.data.a).toBe(1);
  });

  it('enforces unique itemId', async () => {
    await Item.create({
      workspaceId: 'ws', boardId: 'b', folderId: 'f', itemId: 'dup',
    });
    await expect(
      Item.create({ workspaceId: 'ws', boardId: 'b', folderId: 'f', itemId: 'dup' })
    ).rejects.toThrow();
  });
});
