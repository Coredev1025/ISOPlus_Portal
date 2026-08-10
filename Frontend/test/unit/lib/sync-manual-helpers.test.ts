import { describe, it, expect, beforeEach } from 'vitest';

import {
  getBoardNameFromSession,
  getSyncRefreshMode,
  isSyncActiveStatus,
  isSyncCompletedStatus,
  isSyncFailedStatus,
  isValidRouteIdParam,
} from '@/lib/sync-manual-helpers';

/**
 * Written by app/workspace/[id]/board/[boardId]/page.tsx before it navigates
 * to the invoice generator / monthly statement pages.
 */
const CURRENT_BOARD = {
  boardId: '8842011',
  boardName: 'Care Management - NDIS',
  boardLabel: 'Service Records',
  workspaceId: 'ws-4471',
  workspaceName: 'Hillsgrade Care Services',
  timestamp: '2026-03-15T08:55:12.318Z',
};

beforeEach(() => {
  sessionStorage.clear();
});

describe('isValidRouteIdParam', () => {
  it('accepts a real route id', () => {
    expect(isValidRouteIdParam('8842011')).toBe(true);
    expect(isValidRouteIdParam('ws-4471')).toBe(true);
  });

  it('accepts "0" as a string, because only falsy values are rejected', () => {
    expect(isValidRouteIdParam('0')).toBe(true);
  });

  it('rejects the literal strings Next.js produces from an undefined segment', () => {
    expect(isValidRouteIdParam('undefined')).toBe(false);
    expect(isValidRouteIdParam('null')).toBe(false);
  });

  it('rejects an empty or whitespace-only segment', () => {
    expect(isValidRouteIdParam('')).toBe(false);
    expect(isValidRouteIdParam('   ')).toBe(false);
    expect(isValidRouteIdParam('\n\t')).toBe(false);
  });

  it('accepts an id with surrounding whitespace, which is only trimmed for the emptiness check', () => {
    expect(isValidRouteIdParam(' 8842011 ')).toBe(true);
  });

  it('rejects non-string values', () => {
    expect(isValidRouteIdParam(undefined)).toBe(false);
    expect(isValidRouteIdParam(null)).toBe(false);
    expect(isValidRouteIdParam(0)).toBe(false);
    expect(isValidRouteIdParam(8842011)).toBe(false);
    expect(isValidRouteIdParam(['8842011'])).toBe(false);
    expect(isValidRouteIdParam({ boardId: '8842011' })).toBe(false);
  });
});

describe('getBoardNameFromSession', () => {
  it('returns the stored board name', () => {
    sessionStorage.setItem('currentBoard', JSON.stringify(CURRENT_BOARD));

    expect(getBoardNameFromSession('8842011')).toBe('Care Management - NDIS');
  });

  it('returns the stored name even when it belongs to a different board id', () => {
    // The helper never checks that the cached entry matches the board asked for.
    sessionStorage.setItem('currentBoard', JSON.stringify(CURRENT_BOARD));

    expect(getBoardNameFromSession('9999999')).toBe('Care Management - NDIS');
  });

  it('falls back to the board id when nothing is cached', () => {
    expect(getBoardNameFromSession('8842011')).toBe('8842011');
  });

  it('falls back to the board id when the cached value is not JSON', () => {
    sessionStorage.setItem('currentBoard', 'Care Management - NDIS');

    expect(getBoardNameFromSession('8842011')).toBe('8842011');
  });

  it('falls back to the board id when the cached entry has no boardName', () => {
    sessionStorage.setItem(
      'currentBoard',
      JSON.stringify({ boardId: '8842011', workspaceId: 'ws-4471' }),
    );

    expect(getBoardNameFromSession('8842011')).toBe('8842011');
  });

  it('falls back to the board id when the cached boardName is empty', () => {
    sessionStorage.setItem('currentBoard', JSON.stringify({ ...CURRENT_BOARD, boardName: '' }));

    expect(getBoardNameFromSession('8842011')).toBe('8842011');
  });

  it('falls back to the board id when the cached entry is a bare null', () => {
    sessionStorage.setItem('currentBoard', 'null');

    expect(getBoardNameFromSession('8842011')).toBe('8842011');
  });

  it('ignores a stale entry under a different key', () => {
    sessionStorage.setItem('board', JSON.stringify(CURRENT_BOARD));

    expect(getBoardNameFromSession('8842011')).toBe('8842011');
  });
});

describe('isSyncActiveStatus', () => {
  it('is true for the two in-flight statuses', () => {
    expect(isSyncActiveStatus({ status: 'started' })).toBe(true);
    expect(isSyncActiveStatus({ status: 'in-progress' })).toBe(true);
  });

  it('is false for terminal and unknown statuses', () => {
    expect(isSyncActiveStatus({ status: 'completed' })).toBe(false);
    expect(isSyncActiveStatus({ status: 'failed' })).toBe(false);
    expect(isSyncActiveStatus({ status: 'timeout' })).toBe(false);
    expect(isSyncActiveStatus({ status: 'queued' })).toBe(false);
    expect(isSyncActiveStatus({ status: 'in progress' })).toBe(false);
  });

  it('is false when there is no snapshot or no status on it', () => {
    expect(isSyncActiveStatus(undefined)).toBe(false);
    expect(isSyncActiveStatus({})).toBe(false);
  });
});

describe('isSyncCompletedStatus', () => {
  it('is true only for completed', () => {
    expect(isSyncCompletedStatus({ status: 'completed' })).toBe(true);
    expect(isSyncCompletedStatus({ status: 'complete' })).toBe(false);
    expect(isSyncCompletedStatus({ status: 'in-progress' })).toBe(false);
  });

  it('is false when there is no snapshot or no status on it', () => {
    expect(isSyncCompletedStatus(undefined)).toBe(false);
    expect(isSyncCompletedStatus({})).toBe(false);
  });
});

describe('isSyncFailedStatus', () => {
  it('is true for failed and for timeout', () => {
    expect(isSyncFailedStatus({ status: 'failed' })).toBe(true);
    expect(isSyncFailedStatus({ status: 'timeout' })).toBe(true);
  });

  it('is false for every other status', () => {
    expect(isSyncFailedStatus({ status: 'completed' })).toBe(false);
    expect(isSyncFailedStatus({ status: 'started' })).toBe(false);
    expect(isSyncFailedStatus({ status: 'error' })).toBe(false);
  });

  it('is false when there is no snapshot or no status on it', () => {
    expect(isSyncFailedStatus(undefined)).toBe(false);
    expect(isSyncFailedStatus({})).toBe(false);
  });
});

describe('getSyncRefreshMode', () => {
  it('reports completed, which the page uses to delay the refresh and show a success toast', () => {
    expect(getSyncRefreshMode({ status: 'completed' })).toBe('completed');
  });

  it('reports active for a sync still running', () => {
    expect(getSyncRefreshMode({ status: 'started' })).toBe('active');
    expect(getSyncRefreshMode({ status: 'in-progress' })).toBe('active');
  });

  it('reports failed for failed and timeout', () => {
    expect(getSyncRefreshMode({ status: 'failed' })).toBe('failed');
    expect(getSyncRefreshMode({ status: 'timeout' })).toBe('failed');
  });

  it('reports default when there is no sync snapshot for the board', () => {
    expect(getSyncRefreshMode(undefined)).toBe('default');
  });

  it('reports default for a status none of the predicates recognise', () => {
    expect(getSyncRefreshMode({ status: 'queued' })).toBe('default');
    expect(getSyncRefreshMode({})).toBe('default');
  });
});
