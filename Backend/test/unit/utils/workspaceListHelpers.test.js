import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildWorkspaceMetaById,
  mapWorkspaceWithRole,
  shouldStopWorkspaceCollection,
  collectWorkspacePages,
  mapWorkspaceFetchErrorStatus,
  enrichWorkspaceDetails,
  handleWorkspacesListRequest,
} from '../../../src/utils/workspaceListHelpers.js';

/** Shape ISO+ returns for a workspace from GET /workspace. */
function isoWorkspace(id, name, extra = {}) {
  return {
    id,
    name,
    description: `${name} workspace`,
    logo: null,
    created_at: '2025-11-02T09:30:00.000Z',
    ...extra,
  };
}

/* --- collaborators copied verbatim from src/routes/workspace.js ------------ */

function workspaceMatchesQuery(w, q) {
  if (!q) return true;
  const id = (w?.id?.toString?.() ?? w?.id ?? '').toString().toLowerCase();
  const name = (w?.name ?? '').toString().toLowerCase();
  return id.includes(q) || name.includes(q);
}

function normalizeQuery(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      results[i] = await mapper(items[i], i);
    }
  };

  const poolSize = Math.min(Math.max(concurrency, 1), items.length || 1);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}

const passthroughTimeout = (promise) => promise;

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

/* -------------------------------------------------------------------------- */

describe('buildWorkspaceMetaById', () => {
  it('returns null when the token carries no workspace array', () => {
    expect(buildWorkspaceMetaById(null)).toBeNull();
    expect(buildWorkspaceMetaById(undefined)).toBeNull();
    expect(buildWorkspaceMetaById({})).toBeNull();
    expect(buildWorkspaceMetaById({ workspace: 'ws_1' })).toBeNull();
  });

  it('indexes each scoped workspace by its stringified id', () => {
    const meta = buildWorkspaceMetaById({
      email: 'ops@hillsgrade.example',
      workspace: [
        { id: 'ws_1', user_role: 'admin', board: [{ id: 'brd_1' }] },
        { id: 4821, user_role: 'member', board: [] },
      ],
    });

    expect(meta).toEqual({
      ws_1: { user_role: 'admin', board: [{ id: 'brd_1' }] },
      4821: { user_role: 'member', board: [] },
    });
  });

  it('defaults a missing user_role to restricted_member', () => {
    const meta = buildWorkspaceMetaById({ workspace: [{ id: 'ws_1' }] });
    expect(meta.ws_1.user_role).toBe('restricted_member');
  });

  it('leaves board undefined when it is not an array', () => {
    const meta = buildWorkspaceMetaById({
      workspace: [{ id: 'ws_1', user_role: 'admin', board: 'brd_1' }],
    });
    expect(meta.ws_1.board).toBeUndefined();
  });

  it('skips entries with no id and returns an empty map for an empty array', () => {
    expect(buildWorkspaceMetaById({ workspace: [{ user_role: 'admin' }, { id: null }] })).toEqual({});
    expect(buildWorkspaceMetaById({ workspace: [] })).toEqual({});
  });
});

describe('mapWorkspaceWithRole', () => {
  it('prefers the per-workspace role carried in the token', () => {
    const mapped = mapWorkspaceWithRole(
      isoWorkspace('ws_1', 'Alpha Health'),
      { ws_1: { user_role: 'admin' } },
      'owner',
    );

    expect(mapped.user_role).toBe('admin');
  });

  it('maps the account role to a workspace role when the token has no entry', () => {
    const w = isoWorkspace('ws_1', 'Alpha Health');

    expect(mapWorkspaceWithRole(w, null, 'owner').user_role).toBe('owner');
    expect(mapWorkspaceWithRole(w, null, 'support_admin').user_role).toBe('admin');
    expect(mapWorkspaceWithRole(w, null, 'isoplus_user').user_role).toBe('restricted_member');
    expect(mapWorkspaceWithRole(w, {}, undefined).user_role).toBe('restricted_member');
  });

  it('attaches the token board scope only when the token carries one', () => {
    const scoped = mapWorkspaceWithRole(
      isoWorkspace('ws_1', 'Alpha Health'),
      { ws_1: { user_role: 'member', board: [{ id: 'brd_1' }] } },
      'isoplus_user',
    );
    expect(scoped.board).toEqual([{ id: 'brd_1' }]);

    const unscoped = mapWorkspaceWithRole(
      isoWorkspace('ws_1', 'Alpha Health'),
      { ws_1: { user_role: 'member' } },
      'isoplus_user',
    );
    expect(unscoped).not.toHaveProperty('board');
  });

  it('preserves the rest of the ISO+ payload and does not mutate it', () => {
    const w = isoWorkspace('ws_1', 'Alpha Health');
    const mapped = mapWorkspaceWithRole(w, null, 'owner');

    expect(mapped).toEqual({
      id: 'ws_1',
      name: 'Alpha Health',
      description: 'Alpha Health workspace',
      logo: null,
      created_at: '2025-11-02T09:30:00.000Z',
      user_role: 'owner',
    });
    expect(w).not.toHaveProperty('user_role');
  });

  it('looks the token entry up by the stringified id', () => {
    const mapped = mapWorkspaceWithRole(isoWorkspace(4821, 'Beta Care'), { 4821: { user_role: 'admin' } }, 'isoplus_user');
    expect(mapped.user_role).toBe('admin');
  });

  it('falls back to restricted_member for a workspace with no id', () => {
    const mapped = mapWorkspaceWithRole({ name: 'Nameless' }, { ws_1: { user_role: 'admin' } }, 'isoplus_user');
    expect(mapped.user_role).toBe('restricted_member');
  });
});

describe('shouldStopWorkspaceCollection', () => {
  const scanning = {
    q: 'care',
    limit: 200,
    collectedLength: 3,
    scanHasMore: true,
    pagesScanned: 1,
    maxScanPages: 20,
    scanAfter: 'cursor_2',
    isoMaxLimit: 100,
  };

  it('keeps scanning while every continue condition holds', () => {
    expect(shouldStopWorkspaceCollection(scanning)).toBe(false);
  });

  it('stops after one page when there is no query and the limit fits one ISO+ page', () => {
    expect(shouldStopWorkspaceCollection({ ...scanning, q: '', limit: 100 })).toBe(true);
    expect(shouldStopWorkspaceCollection({ ...scanning, q: '', limit: 101 })).toBe(false);
  });

  it('respects the injected ISO+ page ceiling rather than a hard-coded 100', () => {
    expect(shouldStopWorkspaceCollection({ ...scanning, q: '', limit: 50, isoMaxLimit: 25 })).toBe(false);
    expect(shouldStopWorkspaceCollection({ ...scanning, q: '', limit: 50, isoMaxLimit: 50 })).toBe(true);
  });

  it('stops once the limit is filled', () => {
    expect(shouldStopWorkspaceCollection({ ...scanning, collectedLength: 200 })).toBe(true);
    expect(shouldStopWorkspaceCollection({ ...scanning, collectedLength: 199 })).toBe(false);
  });

  it('stops when ISO+ reports no more pages', () => {
    expect(shouldStopWorkspaceCollection({ ...scanning, scanHasMore: false })).toBe(true);
  });

  it('stops at the page-scan ceiling', () => {
    expect(shouldStopWorkspaceCollection({ ...scanning, pagesScanned: 20 })).toBe(true);
    expect(shouldStopWorkspaceCollection({ ...scanning, pagesScanned: 19 })).toBe(false);
  });

  it('stops when there is no cursor left', () => {
    expect(shouldStopWorkspaceCollection({ ...scanning, scanAfter: null })).toBe(true);
  });
});

describe('mapWorkspaceFetchErrorStatus', () => {
  it('maps 401 signals to 401', () => {
    expect(mapWorkspaceFetchErrorStatus('Request failed with status code 401')).toBe(401);
    expect(mapWorkspaceFetchErrorStatus('Unauthorized')).toBe(401);
    expect(mapWorkspaceFetchErrorStatus('UNAUTHORIZED access')).toBe(401);
  });

  it('maps 403 signals to 403', () => {
    expect(mapWorkspaceFetchErrorStatus('Request failed with status code 403')).toBe(403);
    expect(mapWorkspaceFetchErrorStatus('Forbidden')).toBe(403);
  });

  it('prefers 401 when a message carries both signals', () => {
    expect(mapWorkspaceFetchErrorStatus('Unauthorized or forbidden')).toBe(401);
  });

  it('falls back to 500 for anything else, including nothing at all', () => {
    expect(mapWorkspaceFetchErrorStatus('Request failed with status code 500')).toBe(500);
    expect(mapWorkspaceFetchErrorStatus('socket hang up')).toBe(500);
    expect(mapWorkspaceFetchErrorStatus('')).toBe(500);
    expect(mapWorkspaceFetchErrorStatus(null)).toBe(500);
    expect(mapWorkspaceFetchErrorStatus(undefined)).toBe(500);
  });
});

describe('collectWorkspacePages', () => {
  function deps(overrides = {}) {
    return {
      authorization: 'Bearer isoplus-token',
      limit: 50,
      after: null,
      q: '',
      maxScanPages: 20,
      timeoutMs: '30000',
      isoMaxLimit: 100,
      withTimeout: passthroughTimeout,
      workspaceMatchesQuery,
      ...overrides,
    };
  }

  it('returns a single page unfiltered when no query is given', async () => {
    const getWorkspacePage = vi.fn(async () => ({
      status: 200,
      workspace: [isoWorkspace('ws_1', 'Alpha Health'), isoWorkspace('ws_2', 'Beta Care')],
      has_more: false,
      after: null,
    }));

    const result = await collectWorkspacePages(deps({ getWorkspacePage }));

    expect(result.collected.map((w) => w.id)).toEqual(['ws_1', 'ws_2']);
    expect(result.nextAfter).toBeNull();
    expect(result.scanHasMore).toBe(false);
  });

  it('asks ISO+ for min(isoMaxLimit, limit) workspaces from the given cursor', async () => {
    const getWorkspacePage = vi.fn(async () => ({ status: 200, workspace: [], has_more: false, after: null }));

    await collectWorkspacePages(deps({ getWorkspacePage, limit: 7, after: 'cursor_3' }));

    expect(getWorkspacePage).toHaveBeenCalledWith('Bearer isoplus-token', { limit: 7, after: 'cursor_3' });
  });

  it('always requests a full ISO+ page when searching', async () => {
    const getWorkspacePage = vi.fn(async () => ({ status: 200, workspace: [], has_more: false, after: null }));

    await collectWorkspacePages(deps({ getWorkspacePage, limit: 7, q: 'care' }));

    expect(getWorkspacePage.mock.calls[0][1]).toEqual({ limit: 100, after: null });
  });

  it('filters each page through the matcher and follows the cursor while searching', async () => {
    const pages = [
      {
        status: 200,
        workspace: [isoWorkspace('ws_1', 'Alpha Health'), isoWorkspace('ws_2', 'Beta Care')],
        has_more: true,
        after: 'cursor_2',
      },
      {
        status: 200,
        workspace: [isoWorkspace('ws_3', 'Carewell Group'), isoWorkspace('ws_4', 'Delta Clinic')],
        has_more: false,
        after: null,
      },
    ];
    const getWorkspacePage = vi.fn(async () => pages.shift());

    const result = await collectWorkspacePages(deps({ getWorkspacePage, limit: 200, q: 'care' }));

    expect(getWorkspacePage).toHaveBeenCalledTimes(2);
    expect(getWorkspacePage.mock.calls[1][1]).toEqual({ limit: 100, after: 'cursor_2' });
    expect(result.collected.map((w) => w.id)).toEqual(['ws_2', 'ws_3']);
  });

  it('dedupes repeated ids across pages, keeping the later copy, and truncates to the limit', async () => {
    const pages = [
      {
        status: 200,
        workspace: [isoWorkspace('ws_1', 'Alpha Care'), isoWorkspace('ws_2', 'Beta Care')],
        has_more: true,
        after: 'cursor_2',
      },
      {
        status: 200,
        workspace: [isoWorkspace('ws_1', 'Alpha Care Renamed'), isoWorkspace('ws_3', 'Gamma Care')],
        has_more: true,
        after: 'cursor_3',
      },
    ];
    const getWorkspacePage = vi.fn(async () => pages.shift());

    const result = await collectWorkspacePages(
      deps({ getWorkspacePage, limit: 3, q: 'care', maxScanPages: 5 }),
    );

    expect(result.collected.map((w) => w.name)).toEqual([
      'Alpha Care Renamed',
      'Beta Care',
      'Gamma Care',
    ]);
    expect(getWorkspacePage).toHaveBeenCalledTimes(2);
  });

  it('gives up at maxScanPages while ISO+ still has more', async () => {
    let n = 0;
    const getWorkspacePage = vi.fn(async () => {
      n += 1;
      return {
        status: 200,
        workspace: [isoWorkspace(`ws_${n}`, `Care ${n}`)],
        has_more: true,
        after: `cursor_${n + 1}`,
      };
    });

    const result = await collectWorkspacePages(
      deps({ getWorkspacePage, limit: 200, q: 'care', maxScanPages: 2 }),
    );

    expect(getWorkspacePage).toHaveBeenCalledTimes(2);
    expect(result.nextAfter).toBe('cursor_3');
    expect(result.scanHasMore).toBe(true);
  });

  it('returns the whole failing page plus a mapped http status', async () => {
    const page = {
      status: 401,
      message: 'Request failed with status code 401',
      workspace: null,
      error_type: 'oauth',
    };
    const getWorkspacePage = vi.fn(async () => page);

    const result = await collectWorkspacePages(deps({ getWorkspacePage }));

    expect(result.error).toBe(page);
    expect(result.mappedStatus).toBe(401);
    expect(result.collected).toBeUndefined();
  });

  it('maps an unrecognised failure to 500', async () => {
    const getWorkspacePage = vi.fn(async () => ({ status: 500, message: 'socket hang up', workspace: null }));

    expect((await collectWorkspacePages(deps({ getWorkspacePage }))).mappedStatus).toBe(500);
  });

  it('treats a 200 with a non-array workspace field as a failure', async () => {
    const getWorkspacePage = vi.fn(async () => ({ status: 200, workspace: { id: 'ws_1' } }));

    const result = await collectWorkspacePages(deps({ getWorkspacePage }));
    expect(result.mappedStatus).toBe(500);
    expect(result.collected).toBeUndefined();
  });

  it('passes the timeout budget and message to withTimeout', async () => {
    const getWorkspacePage = vi.fn(async () => ({ status: 200, workspace: [], has_more: false, after: null }));
    const withTimeout = vi.fn((promise) => promise);

    await collectWorkspacePages(deps({ getWorkspacePage, withTimeout, timeoutMs: '9000' }));

    expect(withTimeout.mock.calls[0][1]).toBe('9000');
    expect(withTimeout.mock.calls[0][2]).toBe('Workspace fetch timed out');
  });
});

describe('enrichWorkspaceDetails', () => {
  function options(overrides = {}) {
    return {
      authorization: 'Bearer isoplus-token',
      req: { user: { email: 'ops@hillsgrade.example' } },
      includeDetails: true,
      wantBoardsPreview: false,
      detailConcurrency: 4,
      detailTimeoutMs: '30000',
      getMemberRole: vi.fn(async () => ({ status: 200, role: null })),
      getBoardPage: vi.fn(async () => ({ status: 200, board: [], has_more: false })),
      withTimeout: passthroughTimeout,
      mapWithConcurrency,
      ...overrides,
    };
  }

  it('returns the input untouched when details were not requested', async () => {
    const workspaces = [isoWorkspace('ws_1', 'Alpha Health')];
    const getMemberRole = vi.fn();

    const result = await enrichWorkspaceDetails(
      workspaces,
      options({ includeDetails: false, getMemberRole }),
    );

    expect(result).toBe(workspaces);
    expect(getMemberRole).not.toHaveBeenCalled();
  });

  it('returns an empty list untouched', async () => {
    const workspaces = [];
    expect(await enrichWorkspaceDetails(workspaces, options())).toBe(workspaces);
  });

  it('upgrades a restricted_member role from the ISO+ member lookup', async () => {
    const getMemberRole = vi.fn(async () => ({ status: 200, role: 'admin' }));

    const result = await enrichWorkspaceDetails(
      [{ ...isoWorkspace('ws_1', 'Alpha Health'), user_role: 'restricted_member' }],
      options({ getMemberRole }),
    );

    expect(result[0].user_role).toBe('admin');
    expect(getMemberRole).toHaveBeenCalledWith('Bearer isoplus-token', 'ws_1', 'ops@hillsgrade.example', {
      limit: 100,
    });
  });

  it('does not look the role up when one better than restricted_member is already known', async () => {
    const getMemberRole = vi.fn(async () => ({ status: 200, role: 'member' }));

    const result = await enrichWorkspaceDetails(
      [{ ...isoWorkspace('ws_1', 'Alpha Health'), user_role: 'owner' }],
      options({ getMemberRole }),
    );

    expect(getMemberRole).not.toHaveBeenCalled();
    expect(result[0].user_role).toBe('owner');
  });

  it('does not look the role up when the session has no email', async () => {
    const getMemberRole = vi.fn(async () => ({ status: 200, role: 'admin' }));

    await enrichWorkspaceDetails(
      [{ ...isoWorkspace('ws_1', 'Alpha Health'), user_role: 'restricted_member' }],
      options({ getMemberRole, req: { user: {} } }),
    );

    expect(getMemberRole).not.toHaveBeenCalled();
  });

  it('keeps the existing role when the lookup fails or returns no role', async () => {
    const failing = await enrichWorkspaceDetails(
      [{ ...isoWorkspace('ws_1', 'Alpha Health'), user_role: 'restricted_member' }],
      options({ getMemberRole: vi.fn(async () => ({ status: 403, role: 'admin' })) }),
    );
    expect(failing[0].user_role).toBe('restricted_member');

    const roleless = await enrichWorkspaceDetails(
      [{ ...isoWorkspace('ws_1', 'Alpha Health'), user_role: 'restricted_member' }],
      options({ getMemberRole: vi.fn(async () => ({ status: 200, role: null })) }),
    );
    expect(roleless[0].user_role).toBe('restricted_member');
  });

  it('adds a ten-board preview reduced to id and name', async () => {
    const getBoardPage = vi.fn(async () => ({
      status: 200,
      board: [
        { id: 'brd_1', name: 'Invoices', description: 'noise', color: '#fff' },
        { id: 'brd_2', name: 'Quotes', description: 'noise', color: '#000' },
      ],
      has_more: true,
      after: 'cursor_2',
    }));

    const result = await enrichWorkspaceDetails(
      [{ ...isoWorkspace('ws_1', 'Alpha Health'), user_role: 'admin' }],
      options({ wantBoardsPreview: true, getBoardPage }),
    );

    expect(getBoardPage).toHaveBeenCalledWith('Bearer isoplus-token', 'ws_1', { limit: 10, after: null });
    expect(result[0].boardsPreview).toEqual([
      { id: 'brd_1', name: 'Invoices' },
      { id: 'brd_2', name: 'Quotes' },
    ]);
    expect(result[0].boardsPreviewHasMore).toBe(true);
  });

  it('omits the preview entirely when the boards request fails', async () => {
    const result = await enrichWorkspaceDetails(
      [{ ...isoWorkspace('ws_1', 'Alpha Health'), user_role: 'admin' }],
      options({
        wantBoardsPreview: true,
        getBoardPage: vi.fn(async () => ({ status: 500, message: 'boom' })),
      }),
    );

    expect(result[0]).not.toHaveProperty('boardsPreview');
    expect(result[0]).not.toHaveProperty('boardsPreviewHasMore');
  });

  it('skips a workspace with no id, returning it by reference', async () => {
    const nameless = { name: 'Nameless', user_role: 'restricted_member' };
    const getMemberRole = vi.fn(async () => ({ status: 200, role: 'admin' }));

    const result = await enrichWorkspaceDetails([nameless], options({ getMemberRole, wantBoardsPreview: true }));

    expect(result[0]).toBe(nameless);
    expect(getMemberRole).not.toHaveBeenCalled();
  });

  it('enriches every workspace and preserves order', async () => {
    const getMemberRole = vi.fn(async (_auth, workspaceId) => ({
      status: 200,
      role: workspaceId === 'ws_1' ? 'admin' : 'member',
    }));

    const result = await enrichWorkspaceDetails(
      [
        { ...isoWorkspace('ws_1', 'Alpha Health'), user_role: 'restricted_member' },
        { ...isoWorkspace('ws_2', 'Beta Care'), user_role: 'restricted_member' },
      ],
      options({ getMemberRole, detailConcurrency: 2 }),
    );

    expect(result.map((w) => [w.id, w.user_role])).toEqual([
      ['ws_1', 'admin'],
      ['ws_2', 'member'],
    ]);
  });

  it('does not mutate the workspaces it was given', async () => {
    const input = { ...isoWorkspace('ws_1', 'Alpha Health'), user_role: 'restricted_member' };

    await enrichWorkspaceDetails(
      [input],
      options({ getMemberRole: vi.fn(async () => ({ status: 200, role: 'admin' })) }),
    );

    expect(input.user_role).toBe('restricted_member');
  });
});

describe('handleWorkspacesListRequest', () => {
  const envKeys = [
    'ISOPLUS_SEARCH_SCAN_MAX_PAGES',
    'WORKSPACE_FETCH_TIMEOUT_MS',
    'ISOPLUS_HTTP_TIMEOUT_MS',
    'WORKSPACE_DETAILS_CONCURRENCY',
    'WORKSPACE_DETAILS_TIMEOUT_MS',
  ];
  const saved = {};

  beforeEach(() => {
    for (const k of envKeys) saved[k] = process.env[k];
    for (const k of envKeys) delete process.env[k];
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function deps(overrides = {}) {
    return {
      warn: vi.fn(),
      error: vi.fn(),
      clampInt,
      normalizeQuery,
      ISOPLUS_MAX_LIMIT: 100,
      withTimeout: passthroughTimeout,
      getWorkspacePage: vi.fn(async () => ({
        status: 200,
        workspace: [isoWorkspace('ws_2', 'Zebra Care'), isoWorkspace('ws_1', 'Alpha Health')],
        has_more: false,
        after: null,
      })),
      getBoardPage: vi.fn(async () => ({ status: 200, board: [], has_more: false })),
      getMemberRole: vi.fn(async () => ({ status: 200, role: null })),
      mapWithConcurrency,
      workspaceMatchesQuery,
      buildWorkspaceMetaById,
      mapWorkspaceWithRole,
      collectWorkspacePages,
      enrichWorkspaceDetails,
      ...overrides,
    };
  }

  function req(overrides = {}) {
    return {
      session: { Authorization: 'Bearer isoplus-token', token: 'jwt' },
      user: { email: 'ops@hillsgrade.example', role: 'support_admin' },
      query: {},
      ...overrides,
    };
  }

  it('rejects a session without ISO+ OAuth credentials', async () => {
    const res = fakeRes();
    const d = deps();

    await handleWorkspacesListRequest(req({ session: {} }), res, d);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      message: 'Authentication session is missing OAuth credentials. Please login again.',
      error_type: 'oauth',
    });
    expect(d.getWorkspacePage).not.toHaveBeenCalled();
  });

  it('returns workspaces sorted by name with the paging cursor', async () => {
    const res = fakeRes();

    await handleWorkspacesListRequest(req(), res, deps());

    expect(res.statusCode).toBe(200);
    expect(res.body.workspace.map((w) => w.name)).toEqual(['Alpha Health', 'Zebra Care']);
    expect(res.body.nextAfter).toBeNull();
    expect(res.body.hasMore).toBe(false);
  });

  it('maps a support_admin account with no token scope to the admin workspace role', async () => {
    const res = fakeRes();

    await handleWorkspacesListRequest(req(), res, deps());

    expect(res.body.workspace.map((w) => w.user_role)).toEqual(['admin', 'admin']);
  });

  it('prefers the per-workspace role carried on the JWT', async () => {
    const res = fakeRes();
    const request = req({
      user: {
        email: 'ops@hillsgrade.example',
        role: 'isoplus_user',
        workspace: [{ id: 'ws_1', user_role: 'owner', board: [{ id: 'brd_1' }] }],
      },
    });

    await handleWorkspacesListRequest(request, res, deps());

    expect(res.body.workspace[0]).toMatchObject({ id: 'ws_1', user_role: 'owner', board: [{ id: 'brd_1' }] });
    expect(res.body.workspace[1].user_role).toBe('restricted_member');
  });

  it('reports the mapped status and oauth hint when the ISO+ fetch is unauthorized', async () => {
    const res = fakeRes();
    const d = deps({
      getWorkspacePage: vi.fn(async () => ({
        status: 401,
        message: 'Request failed with status code 401',
        workspace: null,
      })),
    });

    await handleWorkspacesListRequest(req(), res, d);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      message: 'Request failed with status code 401',
      error_type: 'oauth',
    });
  });

  it('omits the oauth hint for non-401 failures', async () => {
    const res = fakeRes();
    const d = deps({
      getWorkspacePage: vi.fn(async () => ({ status: 403, message: 'Forbidden', workspace: null })),
    });

    await handleWorkspacesListRequest(req(), res, d);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ message: 'Forbidden' });
  });

  it('substitutes a generic message when ISO+ supplies none', async () => {
    const res = fakeRes();
    const d = deps({ getWorkspacePage: vi.fn(async () => ({ status: 500, workspace: null })) });

    await handleWorkspacesListRequest(req(), res, d);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: 'Failed to fetch workspaces' });
  });

  it('clamps the requested limit into 1..200 and falls back to 50 when unparseable', async () => {
    const res = fakeRes();
    const d = deps();

    await handleWorkspacesListRequest(req({ query: { limit: '7' } }), res, d);
    expect(d.getWorkspacePage.mock.calls[0][1]).toEqual({ limit: 7, after: null });

    d.getWorkspacePage.mockClear();
    await handleWorkspacesListRequest(req({ query: { limit: '0' } }), res, d);
    expect(d.getWorkspacePage.mock.calls[0][1]).toEqual({ limit: 1, after: null });

    d.getWorkspacePage.mockClear();
    await handleWorkspacesListRequest(req({ query: { limit: 'many' } }), res, d);
    expect(d.getWorkspacePage.mock.calls[0][1]).toEqual({ limit: 50, after: null });
  });

  it('forwards the after cursor as a string', async () => {
    const res = fakeRes();
    const d = deps();

    await handleWorkspacesListRequest(req({ query: { after: 'cursor_2', limit: '10' } }), res, d);

    expect(d.getWorkspacePage.mock.calls[0][1]).toEqual({ limit: 10, after: 'cursor_2' });
  });

  it('lower-cases and trims the search term before matching', async () => {
    const res = fakeRes();

    await handleWorkspacesListRequest(req({ query: { q: '  ALPHA  ' } }), res, deps());

    expect(res.body.workspace.map((w) => w.name)).toEqual(['Alpha Health']);
  });

  it('does not enrich details unless asked', async () => {
    const res = fakeRes();
    const d = deps();

    await handleWorkspacesListRequest(req(), res, d);

    expect(d.getMemberRole).not.toHaveBeenCalled();
    expect(d.getBoardPage).not.toHaveBeenCalled();
  });

  it('enriches with a boards preview when includeDetails is requested without a search', async () => {
    const res = fakeRes();
    const d = deps({
      getBoardPage: vi.fn(async () => ({
        status: 200,
        board: [{ id: 'brd_1', name: 'Invoices', color: '#fff' }],
        has_more: false,
      })),
    });

    await handleWorkspacesListRequest(req({ query: { includeDetails: 'true' } }), res, d);

    expect(d.getBoardPage).toHaveBeenCalledTimes(2);
    expect(res.body.workspace[0].boardsPreview).toEqual([{ id: 'brd_1', name: 'Invoices' }]);
    expect(res.body.workspace[0].boardsPreviewHasMore).toBe(false);
  });

  it('accepts includeDetails=1 as well as true', async () => {
    const res = fakeRes();
    const d = deps();

    await handleWorkspacesListRequest(req({ query: { includeDetails: '1' } }), res, d);

    expect(d.getBoardPage).toHaveBeenCalledTimes(2);
  });

  it('turns details on implicitly for a search, but leaves the boards preview off', async () => {
    const res = fakeRes();
    const d = deps({ getMemberRole: vi.fn(async () => ({ status: 200, role: 'member' })) });

    await handleWorkspacesListRequest(
      req({ user: { email: 'ops@hillsgrade.example', role: 'isoplus_user' }, query: { q: 'alpha' } }),
      res,
      d,
    );

    expect(d.getMemberRole).toHaveBeenCalledTimes(1);
    expect(d.getBoardPage).not.toHaveBeenCalled();
    expect(res.body.workspace[0].user_role).toBe('member');
  });

  it('adds the boards preview to a search only when boardsPreview is explicitly requested', async () => {
    const res = fakeRes();
    const d = deps();

    await handleWorkspacesListRequest(
      req({ query: { q: 'alpha', boardsPreview: 'true' } }),
      res,
      d,
    );

    expect(d.getBoardPage).toHaveBeenCalledTimes(1);
  });

  it('lets includeDetails=false override the implicit search behaviour', async () => {
    const res = fakeRes();
    const d = deps({ getMemberRole: vi.fn(async () => ({ status: 200, role: 'member' })) });

    await handleWorkspacesListRequest(
      req({
        user: { email: 'ops@hillsgrade.example', role: 'isoplus_user' },
        query: { q: 'alpha', includeDetails: 'false' },
      }),
      res,
      d,
    );

    expect(d.getMemberRole).not.toHaveBeenCalled();
    expect(res.body.workspace[0].user_role).toBe('restricted_member');
  });

  it('reports hasMore and the next cursor from the last ISO+ page', async () => {
    const res = fakeRes();
    const d = deps({
      getWorkspacePage: vi.fn(async () => ({
        status: 200,
        workspace: [isoWorkspace('ws_1', 'Alpha Health')],
        has_more: true,
        after: 'cursor_2',
      })),
    });

    await handleWorkspacesListRequest(req(), res, d);

    expect(res.body.hasMore).toBe(true);
    expect(res.body.nextAfter).toBe('cursor_2');
  });
});
