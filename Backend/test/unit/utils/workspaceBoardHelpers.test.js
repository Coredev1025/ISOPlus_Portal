import { describe, it, expect, vi } from 'vitest';
import Board from '../../../src/models/Board.js';
import {
  mergeBoardPageResults,
  enrichBoardsWithLabels,
  shouldStopBoardCollection,
  collectBoardPages,
} from '../../../src/utils/workspaceBoardHelpers.js';

/**
 * Shape ISO+ returns for a board inside GET /board (see src/services/isoplus.js
 * getBoardPage); the portal adds `label` from its own Board collection.
 */
function isoBoard(id, name, extra = {}) {
  return {
    id,
    name,
    description: `${name} board`,
    color: '#2563eb',
    og_image: null,
    created_at: '2026-01-14T02:11:00.000Z',
    ...extra,
  };
}

/** The matcher src/routes/workspace.js passes in. */
function boardMatchesQuery(b, q) {
  if (!q) return true;
  const id = (b?.id?.toString?.() ?? b?.id ?? '').toString().toLowerCase();
  const name = (b?.name ?? '').toString().toLowerCase();
  const label = (b?.label ?? '').toString().toLowerCase();
  return id.includes(q) || name.includes(q) || label.includes(q);
}

const passthroughTimeout = (promise) => promise;

describe('enrichBoardsWithLabels', () => {
  it('takes the label from the portal Board record when one exists', () => {
    const result = enrichBoardsWithLabels(
      [isoBoard('brd_1', 'Invoices'), isoBoard('brd_2', 'Quotes')],
      [
        { boardId: 'brd_1', label: 'NDIS Invoices' },
        { boardId: 'brd_9', label: 'Unrelated' },
      ],
    );

    expect(result.map((b) => b.label)).toEqual(['NDIS Invoices', 'No Label']);
  });

  it('falls back to the label already on the ISO+ board, then to "No Label"', () => {
    const result = enrichBoardsWithLabels(
      [isoBoard('brd_1', 'Invoices', { label: 'From ISO+' }), isoBoard('brd_2', 'Quotes')],
      [],
    );

    expect(result.map((b) => b.label)).toEqual(['From ISO+', 'No Label']);
  });

  it('treats an empty stored label as absent', () => {
    const result = enrichBoardsWithLabels(
      [isoBoard('brd_1', 'Invoices', { label: 'From ISO+' })],
      [{ boardId: 'brd_1', label: '' }],
    );

    expect(result[0].label).toBe('From ISO+');
  });

  it('matches numeric ISO+ ids against string boardIds', () => {
    const result = enrichBoardsWithLabels([isoBoard(4471, 'Timesheets')], [
      { boardId: '4471', label: 'Weekly Timesheets' },
    ]);

    expect(result[0].label).toBe('Weekly Timesheets');
  });

  it('labels a board with no id as "No Label" and does not mutate the input', () => {
    const input = [{ name: 'Orphan' }];
    const result = enrichBoardsWithLabels(input, [{ boardId: 'undefined', label: 'Trap' }]);

    expect(result[0].label).toBe('No Label');
    expect(input[0]).not.toHaveProperty('label');
  });

  it('keeps the rest of the ISO+ board payload', () => {
    const result = enrichBoardsWithLabels([isoBoard('brd_1', 'Invoices')], []);

    expect(result[0]).toEqual({
      id: 'brd_1',
      name: 'Invoices',
      description: 'Invoices board',
      color: '#2563eb',
      og_image: null,
      created_at: '2026-01-14T02:11:00.000Z',
      label: 'No Label',
    });
  });

  it('returns an empty array for an empty page', () => {
    expect(enrichBoardsWithLabels([], [{ boardId: 'brd_1', label: 'x' }])).toEqual([]);
  });
});

describe('mergeBoardPageResults', () => {
  it('appends the whole page when there is no query', () => {
    const merged = mergeBoardPageResults(
      [isoBoard('brd_1', 'Invoices')],
      [isoBoard('brd_2', 'Quotes')],
      '',
      boardMatchesQuery,
      50,
    );

    expect(merged.map((b) => b.id)).toEqual(['brd_1', 'brd_2']);
  });

  it('filters the incoming page through the matcher when a query is given', () => {
    const merged = mergeBoardPageResults(
      [],
      [isoBoard('brd_1', 'Invoices'), isoBoard('brd_2', 'Quotes'), isoBoard('brd_3', 'Invoice Drafts')],
      'invoice',
      boardMatchesQuery,
      50,
    );

    expect(merged.map((b) => b.id)).toEqual(['brd_1', 'brd_3']);
  });

  it('does not filter what was already collected, only the new page', () => {
    const merged = mergeBoardPageResults(
      [isoBoard('brd_0', 'Timesheets')],
      [isoBoard('brd_1', 'Invoices')],
      'invoice',
      boardMatchesQuery,
      50,
    );

    expect(merged.map((b) => b.id)).toEqual(['brd_0', 'brd_1']);
  });

  it('dedupes by id, keeping the later occurrence', () => {
    const merged = mergeBoardPageResults(
      [isoBoard('brd_1', 'Stale Name')],
      [isoBoard('brd_1', 'Fresh Name'), isoBoard('brd_2', 'Quotes')],
      '',
      boardMatchesQuery,
      50,
    );

    expect(merged).toHaveLength(2);
    expect(merged[0].name).toBe('Fresh Name');
    expect(merged.map((b) => b.id)).toEqual(['brd_1', 'brd_2']);
  });

  it('dedupes a numeric id against the same id as a string', () => {
    const merged = mergeBoardPageResults(
      [isoBoard(4471, 'Timesheets')],
      [isoBoard('4471', 'Timesheets Renamed')],
      '',
      boardMatchesQuery,
      50,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('Timesheets Renamed');
  });

  it('truncates to the limit', () => {
    const merged = mergeBoardPageResults(
      [],
      [isoBoard('brd_1', 'A'), isoBoard('brd_2', 'B'), isoBoard('brd_3', 'C')],
      '',
      boardMatchesQuery,
      2,
    );

    expect(merged.map((b) => b.id)).toEqual(['brd_1', 'brd_2']);
  });

  it('pushes into the array it was given (the accumulator is mutated in place)', () => {
    const collected = [isoBoard('brd_1', 'Invoices')];
    mergeBoardPageResults(collected, [isoBoard('brd_2', 'Quotes')], '', boardMatchesQuery, 50);

    expect(collected.map((b) => b.id)).toEqual(['brd_1', 'brd_2']);
  });
});

describe('shouldStopBoardCollection', () => {
  const scanning = {
    q: 'invoice',
    limit: 200,
    collectedLength: 3,
    scanHasMore: true,
    pagesScanned: 1,
    maxScanPages: 20,
    scanAfter: 'cursor_2',
  };

  it('keeps scanning while every continue condition holds', () => {
    expect(shouldStopBoardCollection(scanning)).toBe(false);
  });

  it('stops after a single page when there is no query and the limit fits one ISO+ page', () => {
    expect(shouldStopBoardCollection({ ...scanning, q: '', limit: 100 })).toBe(true);
    expect(shouldStopBoardCollection({ ...scanning, q: '', limit: 101 })).toBe(false);
  });

  it('stops once the limit is filled', () => {
    expect(shouldStopBoardCollection({ ...scanning, collectedLength: 200 })).toBe(true);
    expect(shouldStopBoardCollection({ ...scanning, collectedLength: 201 })).toBe(true);
    expect(shouldStopBoardCollection({ ...scanning, collectedLength: 199 })).toBe(false);
  });

  it('stops when ISO+ says there is nothing more', () => {
    expect(shouldStopBoardCollection({ ...scanning, scanHasMore: false })).toBe(true);
  });

  it('stops at the page-scan ceiling', () => {
    expect(shouldStopBoardCollection({ ...scanning, pagesScanned: 20 })).toBe(true);
    expect(shouldStopBoardCollection({ ...scanning, pagesScanned: 19 })).toBe(false);
  });

  it('stops when there is no cursor to continue from', () => {
    expect(shouldStopBoardCollection({ ...scanning, scanAfter: null })).toBe(true);
    expect(shouldStopBoardCollection({ ...scanning, scanAfter: '' })).toBe(true);
  });
});

describe('collectBoardPages', () => {
  function deps(overrides = {}) {
    return {
      authorization: 'Bearer isoplus-token',
      workspaceId: 'ws_1',
      limit: 50,
      after: null,
      q: '',
      maxScanPages: 20,
      timeoutMs: '30000',
      withTimeout: passthroughTimeout,
      boardMatchesQuery,
      persistBoardsInBackground: vi.fn(),
      req: { session: { Authorization: 'Bearer isoplus-token' } },
      Board,
      ...overrides,
    };
  }

  it('returns one page of boards enriched from the portal Board collection', async () => {
    await Board.create([
      { boardId: 'brd_1', name: 'Invoices', workspaceId: 'ws_1', label: 'NDIS Invoices' },
      { boardId: 'brd_2', name: 'Quotes', workspaceId: 'ws_other', label: 'Wrong Workspace' },
    ]);

    const getBoardPage = vi.fn(async () => ({
      status: 200,
      board: [isoBoard('brd_1', 'Invoices'), isoBoard('brd_2', 'Quotes')],
      has_more: false,
      after: null,
    }));

    const result = await collectBoardPages(deps({ getBoardPage }));

    expect(result.error).toBeUndefined();
    expect(result.collected.map((b) => [b.id, b.label])).toEqual([
      ['brd_1', 'NDIS Invoices'],
      ['brd_2', 'No Label'],
    ]);
    expect(result.nextAfter).toBeNull();
    expect(result.scanHasMore).toBe(false);
  });

  it('asks ISO+ for min(100, limit) boards starting from the given cursor', async () => {
    const getBoardPage = vi.fn(async () => ({ status: 200, board: [], has_more: false, after: null }));

    await collectBoardPages(deps({ getBoardPage, limit: 5, after: 'cursor_7' }));

    expect(getBoardPage).toHaveBeenCalledTimes(1);
    expect(getBoardPage).toHaveBeenCalledWith('Bearer isoplus-token', 'ws_1', {
      limit: 5,
      after: 'cursor_7',
    });
  });

  it('caps the ISO+ page size at 100 and always requests 100 when searching', async () => {
    const getBoardPage = vi.fn(async () => ({ status: 200, board: [], has_more: false, after: null }));

    await collectBoardPages(deps({ getBoardPage, limit: 200, q: 'inv' }));
    expect(getBoardPage.mock.calls[0][2]).toEqual({ limit: 100, after: null });

    getBoardPage.mockClear();
    await collectBoardPages(deps({ getBoardPage, limit: 200, q: '' }));
    expect(getBoardPage.mock.calls[0][2]).toEqual({ limit: 100, after: null });
  });

  it('stops after the first page when no query is set and the limit fits one page', async () => {
    const getBoardPage = vi.fn(async () => ({
      status: 200,
      board: [isoBoard('brd_1', 'Invoices')],
      has_more: true,
      after: 'cursor_2',
    }));

    const result = await collectBoardPages(deps({ getBoardPage }));

    expect(getBoardPage).toHaveBeenCalledTimes(1);
    expect(result.nextAfter).toBe('cursor_2');
    expect(result.scanHasMore).toBe(true);
  });

  it('keeps paging while searching, following the cursor until ISO+ runs out', async () => {
    const pages = [
      {
        status: 200,
        board: [isoBoard('brd_1', 'Invoices'), isoBoard('brd_2', 'Timesheets')],
        has_more: true,
        after: 'cursor_2',
      },
      {
        status: 200,
        board: [isoBoard('brd_3', 'Invoice Drafts'), isoBoard('brd_4', 'Quotes')],
        has_more: false,
        after: null,
      },
    ];
    const getBoardPage = vi.fn(async () => pages.shift());

    const result = await collectBoardPages(deps({ getBoardPage, limit: 200, q: 'invoice' }));

    expect(getBoardPage).toHaveBeenCalledTimes(2);
    expect(getBoardPage.mock.calls[1][2]).toEqual({ limit: 100, after: 'cursor_2' });
    expect(result.collected.map((b) => b.id)).toEqual(['brd_1', 'brd_3']);
    expect(result.nextAfter).toBeNull();
    expect(result.scanHasMore).toBe(false);
  });

  it('gives up at maxScanPages even when ISO+ still has more', async () => {
    let n = 0;
    const getBoardPage = vi.fn(async () => {
      n += 1;
      return {
        status: 200,
        board: [isoBoard(`brd_${n}`, `Board ${n}`)],
        has_more: true,
        after: `cursor_${n + 1}`,
      };
    });

    const result = await collectBoardPages(
      deps({ getBoardPage, limit: 200, q: 'board', maxScanPages: 3 }),
    );

    expect(getBoardPage).toHaveBeenCalledTimes(3);
    expect(result.collected.map((b) => b.id)).toEqual(['brd_1', 'brd_2', 'brd_3']);
    expect(result.nextAfter).toBe('cursor_4');
    expect(result.scanHasMore).toBe(true);
  });

  it('stops once enough matches have been collected to fill the limit', async () => {
    const getBoardPage = vi.fn(async () => ({
      status: 200,
      board: [isoBoard('brd_1', 'Invoices A'), isoBoard('brd_2', 'Invoices B')],
      has_more: true,
      after: 'cursor_2',
    }));

    const result = await collectBoardPages(deps({ getBoardPage, limit: 2, q: 'invoices' }));

    expect(getBoardPage).toHaveBeenCalledTimes(1);
    expect(result.collected).toHaveLength(2);
  });

  it('returns the ISO+ error message when the page request fails', async () => {
    const getBoardPage = vi.fn(async () => ({
      status: 401,
      message: 'Request failed with status code 401',
      board: null,
    }));

    const result = await collectBoardPages(deps({ getBoardPage }));

    expect(result).toEqual({ error: 'Request failed with status code 401' });
  });

  it('falls back to a generic message when ISO+ gives none', async () => {
    const getBoardPage = vi.fn(async () => ({ status: 500, board: null }));

    expect(await collectBoardPages(deps({ getBoardPage }))).toEqual({
      error: 'Failed to fetch boards',
    });
  });

  it('treats a 200 with a non-array board field as a failure', async () => {
    const getBoardPage = vi.fn(async () => ({ status: 200, board: { id: 'brd_1' }, message: 'Malformed' }));

    expect(await collectBoardPages(deps({ getBoardPage }))).toEqual({ error: 'Malformed' });
  });

  it('hands the raw ISO+ page to the background persister after the request settles', async () => {
    const rawBoards = [isoBoard('brd_1', 'Invoices')];
    const getBoardPage = vi.fn(async () => ({ status: 200, board: rawBoards, has_more: false, after: null }));
    const persistBoardsInBackground = vi.fn();
    const req = { session: { Authorization: 'Bearer isoplus-token' } };

    await collectBoardPages(deps({ getBoardPage, persistBoardsInBackground, req }));
    expect(persistBoardsInBackground).not.toHaveBeenCalled();

    await new Promise((resolve) => setImmediate(resolve));
    expect(persistBoardsInBackground).toHaveBeenCalledWith(rawBoards, req);
  });

  it('does not persist anything when the page request failed', async () => {
    const getBoardPage = vi.fn(async () => ({ status: 502, board: null }));
    const persistBoardsInBackground = vi.fn();

    await collectBoardPages(deps({ getBoardPage, persistBoardsInBackground }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(persistBoardsInBackground).not.toHaveBeenCalled();
  });

  it('propagates a timeout thrown by withTimeout', async () => {
    const getBoardPage = vi.fn(async () => ({ status: 200, board: [], has_more: false, after: null }));
    const withTimeout = vi.fn(async () => {
      throw new Error('Board fetch timed out');
    });

    await expect(collectBoardPages(deps({ getBoardPage, withTimeout }))).rejects.toThrow(
      'Board fetch timed out',
    );
  });

  it('passes the timeout budget and message through to withTimeout', async () => {
    const getBoardPage = vi.fn(async () => ({ status: 200, board: [], has_more: false, after: null }));
    const withTimeout = vi.fn((promise) => promise);

    await collectBoardPages(deps({ getBoardPage, withTimeout, timeoutMs: '12000' }));

    expect(withTimeout.mock.calls[0][1]).toBe('12000');
    expect(withTimeout.mock.calls[0][2]).toBe('Board fetch timed out');
  });

  it('skips the database lookup entirely when the page has no usable ids', async () => {
    await Board.create({ boardId: 'brd_1', name: 'Invoices', workspaceId: 'ws_1', label: 'NDIS Invoices' });
    const getBoardPage = vi.fn(async () => ({
      status: 200,
      board: [{ name: 'Orphan', description: 'no id' }],
      has_more: false,
      after: null,
    }));

    const result = await collectBoardPages(deps({ getBoardPage }));

    expect(result.collected).toEqual([{ name: 'Orphan', description: 'no id', label: 'No Label' }]);
  });
});
