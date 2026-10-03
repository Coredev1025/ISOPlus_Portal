import { describe, it, expect } from 'vitest';
import Item from '../../../src/models/Item.js';
import { attachProfileIds } from '../../../src/utils/automationInvoiceProfiles.js';

const WS = 'ws-profiles';
const BOARD = 'board-profiles';

const item = (itemId, profile) => Item.create({
  workspaceId: WS, boardId: BOARD, folderId: 'f', itemId,
  data: profile === undefined ? {} : { 'Participant Profile': profile },
});

// KAN-293. Documents from an earlier attempt of the same slot come back from the
// ledger with no profile id. They are given theirs from the item, so a retry
// groups a client's old and new documents into one email, not two.
describe('attachProfileIds', () => {
  it('adds the Participant Profile of each row\'s item and leaves the row otherwise as it was', async () => {
    await item('i-1', [{ id: 'P-1' }]);
    await item('i-2', ['P-2']);
    const rows = [
      { itemId: 'i-1', participant: 'Ann', pdfUrl: 'a' },
      { itemId: 'i-2', participant: 'Bob', pdfUrl: 'b' },
    ];

    const out = await attachProfileIds(WS, BOARD, rows);

    expect(out).toEqual([
      { itemId: 'i-1', participant: 'Ann', pdfUrl: 'a', profileId: 'P-1' },
      { itemId: 'i-2', participant: 'Bob', pdfUrl: 'b', profileId: 'P-2' },
    ]);
    expect(rows[0]).not.toHaveProperty('profileId');
  });

  it('keeps a profile id the row already has', async () => {
    await item('i-3', ['P-other']);
    const out = await attachProfileIds(WS, BOARD, [{ itemId: 'i-3', profileId: 'P-mine' }]);
    expect(out[0].profileId).toBe('P-mine');
  });

  it('leaves a row alone when its item has no profile or is not found', async () => {
    await item('i-4', []);
    const out = await attachProfileIds(WS, BOARD, [{ itemId: 'i-4' }, { itemId: 'gone' }]);
    expect(out).toEqual([{ itemId: 'i-4' }, { itemId: 'gone' }]);
  });

  it('does not read another workspace', async () => {
    await Item.create({
      workspaceId: 'ws-elsewhere', boardId: BOARD, folderId: 'f', itemId: 'i-5',
      data: { 'Participant Profile': ['P-x'] },
    });
    const out = await attachProfileIds(WS, BOARD, [{ itemId: 'i-5' }]);
    expect(out[0]).not.toHaveProperty('profileId');
  });
});
