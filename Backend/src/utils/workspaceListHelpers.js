export function buildWorkspaceMetaById(user) {
  if (!Array.isArray(user?.workspace)) return null;
  return user.workspace.reduce((acc, workspace) => {
    const id = workspace?.id?.toString();
    if (!id) return acc;
    acc[id] = {
      user_role: workspace?.user_role || 'restricted_member',
      board: Array.isArray(workspace?.board) ? workspace.board : undefined,
    };
    return acc;
  }, {});
}

export function mapWorkspaceWithRole(w, workspaceMetaById, userRole) {
  const id = w?.id?.toString?.() ?? w?.id;
  const metaFromToken = workspaceMetaById && id ? workspaceMetaById[id] : null;
  const roleFromToken = metaFromToken?.user_role || null;
  const user_role =
    roleFromToken ||
    (userRole === 'owner' ? 'owner' : null) ||
    (userRole === 'support_admin' ? 'admin' : null) ||
    'restricted_member';

  return {
    ...w,
    user_role,
    ...(metaFromToken?.board ? { board: metaFromToken.board } : {}),
  };
}

export function shouldStopWorkspaceCollection({ q, limit, collectedLength, scanHasMore, pagesScanned, maxScanPages, scanAfter, isoMaxLimit }) {
  if (!q && limit <= isoMaxLimit) return true;
  if (collectedLength >= limit) return true;
  if (!scanHasMore) return true;
  if (pagesScanned >= maxScanPages) return true;
  if (!scanAfter) return true;
  return false;
}

export async function collectWorkspacePages({
  authorization,
  limit,
  after,
  q,
  maxScanPages,
  timeoutMs,
  isoMaxLimit,
  getWorkspacePage,
  withTimeout,
  workspaceMatchesQuery,
}) {
  let collected = [];
  let scanAfter = after;
  let scanHasMore = true;
  let nextAfter = null;
  let pagesScanned = 0;
  const isoLimit = Math.min(isoMaxLimit, q ? isoMaxLimit : limit);

  while (true) {
    const page = await withTimeout(
      getWorkspacePage(authorization, { limit: isoLimit, after: scanAfter }),
      timeoutMs,
      'Workspace fetch timed out',
    );

    if (page.status !== 200 || !Array.isArray(page.workspace)) {
      return { error: page, mappedStatus: mapWorkspaceFetchErrorStatus(page.message) };
    }

    const batch = q ? page.workspace.filter((w) => workspaceMatchesQuery(w, q)) : page.workspace;
    collected.push(...batch);
    collected = Array.from(new Map(collected.map((w) => [String(w?.id?.toString?.() ?? w?.id), w])).values()).slice(0, limit);

    nextAfter = page.after ?? null;
    scanHasMore = Boolean(page.has_more);
    scanAfter = nextAfter;
    pagesScanned += 1;

    if (shouldStopWorkspaceCollection({
      q, limit, collectedLength: collected.length, scanHasMore, pagesScanned, maxScanPages, scanAfter, isoMaxLimit,
    })) break;
  }

  return { collected, nextAfter, scanHasMore };
}

export function mapWorkspaceFetchErrorStatus(rawMessage) {
  const normalized = String(rawMessage || '').toLowerCase();
  if (normalized.includes('status code 401') || normalized.includes('unauthorized')) return 401;
  if (normalized.includes('status code 403') || normalized.includes('forbidden')) return 403;
  return 500;
}

export async function enrichWorkspaceDetails(workspaces, {
  authorization,
  req,
  includeDetails,
  wantBoardsPreview,
  detailConcurrency,
  detailTimeoutMs,
  getMemberRole,
  getBoardPage,
  withTimeout,
  mapWithConcurrency,
}) {
  if (!includeDetails || !workspaces.length) return workspaces;

  return mapWithConcurrency(workspaces, detailConcurrency, async (w) => {
    const workspaceId = w?.id?.toString?.() ?? w?.id;
    if (!workspaceId) return w;

    const detail = { ...w };
    if (req.user?.email && (!detail.user_role || detail.user_role === 'restricted_member')) {
      const roleRes = await withTimeout(
        getMemberRole(authorization, workspaceId, req.user.email, { limit: 100 }),
        detailTimeoutMs,
        'Member role fetch timed out',
      );
      if (roleRes?.status === 200 && roleRes?.role) {
        detail.user_role = roleRes.role;
      }
    }

    if (wantBoardsPreview) {
      const boardsPage = await withTimeout(
        getBoardPage(authorization, workspaceId, { limit: 10, after: null }),
        detailTimeoutMs,
        'Boards preview fetch timed out',
      );
      if (boardsPage?.status === 200 && Array.isArray(boardsPage.board)) {
        detail.boardsPreview = boardsPage.board.map((b) => ({ id: b?.id, name: b?.name }));
        detail.boardsPreviewHasMore = Boolean(boardsPage.has_more);
      }
    }

    return detail;
  });
}

export async function handleWorkspacesListRequest(req, res, deps) {
  const {
    warn,
    error,
    clampInt,
    normalizeQuery,
    ISOPLUS_MAX_LIMIT,
    withTimeout,
    getWorkspacePage,
    getBoardPage,
    getMemberRole,
    mapWithConcurrency,
    workspaceMatchesQuery,
    buildWorkspaceMetaById,
    mapWorkspaceWithRole,
    collectWorkspacePages,
    enrichWorkspaceDetails,
  } = deps;

  const authorization = req.session?.Authorization;
  if (!authorization) {
    warn(
      'Workspace-Service',
      'Missing OAuth authorization in session',
      { hasSession: Boolean(req.session), hasToken: Boolean(req.session?.token) },
      req ?? null,
    );
    return res.status(401).json({
      message: 'Authentication session is missing OAuth credentials. Please login again.',
      error_type: 'oauth',
    });
  }

  const limit = clampInt(req.query?.limit || '50', 1, 200, 50);
  const after = req.query?.after ? String(req.query.after) : null;
  const q = normalizeQuery(req.query?.q);
  const maxScanPages = clampInt(process.env.ISOPLUS_SEARCH_SCAN_MAX_PAGES || '20', 1, 200, 20);
  const includeDetails =
    String(req.query?.includeDetails || '').toLowerCase() === 'true' ||
    String(req.query?.includeDetails || '') === '1' ||
    (Boolean(q) && String(req.query?.includeDetails || '').toLowerCase() !== 'false');
  const boardsPreviewExplicit =
    String(req.query?.boardsPreview || '').toLowerCase() === 'true' ||
    String(req.query?.boardsPreview || '') === '1';
  const wantBoardsPreview = includeDetails && (!q || boardsPreviewExplicit);
  const timeoutMs = process.env.WORKSPACE_FETCH_TIMEOUT_MS || process.env.ISOPLUS_HTTP_TIMEOUT_MS || '30000';

  const collection = await collectWorkspacePages({
    authorization,
    limit,
    after,
    q,
    maxScanPages,
    timeoutMs,
    isoMaxLimit: ISOPLUS_MAX_LIMIT,
    getWorkspacePage,
    withTimeout,
    workspaceMatchesQuery,
  });

  if (collection.error) {
    const rawMessage = collection.error.message || 'Failed to fetch workspaces';
    const mappedStatus = collection.mappedStatus;
    warn('Workspace-Service', 'Failed to fetch workspaces', { status: collection.error.status, message: rawMessage }, req ?? null);
    return res.status(mappedStatus).json({
      message: rawMessage,
      ...(mappedStatus === 401 ? { error_type: 'oauth' } : {}),
    });
  }

  const workspaceMetaById = buildWorkspaceMetaById(req.user);
  const mapped = collection.collected.map((w) => mapWorkspaceWithRole(w, workspaceMetaById, req.user?.role));
  const sortedWorkspace = [...mapped].sort((a, b) => (a?.name || '').localeCompare(b?.name || ''));

  const detailConcurrency = clampInt(process.env.WORKSPACE_DETAILS_CONCURRENCY || '4', 1, 10, 4);
  const detailTimeoutMs = process.env.WORKSPACE_DETAILS_TIMEOUT_MS || timeoutMs;
  const enriched = await enrichWorkspaceDetails(sortedWorkspace, {
    authorization,
    req,
    includeDetails,
    wantBoardsPreview,
    detailConcurrency,
    detailTimeoutMs,
    getMemberRole,
    getBoardPage,
    withTimeout,
    mapWithConcurrency,
  });

  return res.status(200).json({
    workspace: enriched,
    nextAfter: collection.nextAfter,
    hasMore: Boolean(collection.scanHasMore),
  });
}
