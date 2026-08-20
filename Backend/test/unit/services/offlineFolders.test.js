import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import Item from '../../../src/models/Item.js';
import { getFolder } from '../../../src/services/isoplus.js';

// Offline mode serves board folders derived from the folder ids already on the
// board's items (name === id). Fixtures therefore use real folder NAMES as
// folderIds ('Shift Planning and Reporting', '📋 Participants Intake', the
// budget stream names), which is what lets the statement budget classifier and
// the invoice-generator folder filters work without live ISO+.
describe('getFolder offline stand-in', () => {
  const WS = 'offline-folder-ws';
  const BOARD = 'offline-folder-board';

  beforeEach(async () => {
    process.env.ISOPLUS_OFFLINE = '1';
    await Item.create([
      { workspaceId: WS, boardId: BOARD, folderId: 'Shift Planning and Reporting', itemId: 'off-fold-1', data: {} },
      { workspaceId: WS, boardId: BOARD, folderId: 'Shift Planning and Reporting', itemId: 'off-fold-2', data: {} },
      { workspaceId: WS, boardId: BOARD, folderId: '📋 Participants Intake', itemId: 'off-fold-3', data: {} },
      { workspaceId: WS, boardId: 'other-board', folderId: 'Claims', itemId: 'off-fold-4', data: {} },
    ]);
  });

  afterEach(async () => {
    process.env.ISOPLUS_OFFLINE = '0';
    await Item.deleteMany({ workspaceId: WS });
  });

  it('returns one folder per distinct folderId on the board, name === id', async () => {
    const { folder, status } = await getFolder(WS, BOARD);
    expect(status).toBe(200);
    expect(folder.map((f) => f.id).sort()).toEqual(['Shift Planning and Reporting', '📋 Participants Intake'].sort());
    for (const f of folder) {
      expect(f.name).toBe(f.id);
    }
  });

  it('scopes to the requested board', async () => {
    const { folder } = await getFolder(WS, 'other-board');
    expect(folder.map((f) => f.id)).toEqual(['Claims']);
  });

  it('returns an empty list, not an error, for an unknown board', async () => {
    const { folder, status } = await getFolder(WS, 'no-such-board');
    expect(status).toBe(200);
    expect(folder).toEqual([]);
  });
});
