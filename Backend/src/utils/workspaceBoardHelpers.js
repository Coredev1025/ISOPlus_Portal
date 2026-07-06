export function mergeBoardPageResults(collected, enrichedPage, q, boardMatchesQuery, limit) {
  const batch = q ? enrichedPage.filter((b) => boardMatchesQuery(b, q)) : enrichedPage;
  collected.push(...batch);

  const deduped = Array.from(
    new Map(collected.map((b) => [String(b?.id?.toString?.() ?? b?.id), b])).values(),
  );
  return deduped.slice(0, limit);
}

export function enrichBoardsWithLabels(pageBoard, dbBoards) {
  const labelById = new Map(dbBoards.map((b) => [String(b.boardId), b.label]));
  return pageBoard.map((b) => {
    const id = b?.id?.toString?.() ?? b?.id;
    const label = id ? labelById.get(String(id)) : undefined;
    return { ...b, label: label || b?.label || 'No Label' };
  });
}

export function shouldStopBoardCollection({ q, limit, collectedLength, scanHasMore, pagesScanned, maxScanPages, scanAfter }) {
  if (!q && limit <= 100) return true;
  if (collectedLength >= limit) return true;
  if (!scanHasMore) return true;
  if (pagesScanned >= maxScanPages) return true;
  if (!scanAfter) return true;
  return false;
}

export async function collectBoardPages({
  authorization,
  workspaceId,
  limit,
  after,
  q,
  maxScanPages,
  timeoutMs,
  getBoardPage,
  withTimeout,
  boardMatchesQuery,
  persistBoardsInBackground,
  req,
  Board,
}) {
  let collected = [];
  let scanAfter = after;
  let scanHasMore = true;
  let nextAfter = null;
  let pagesScanned = 0;
  const isoLimit = Math.min(100, q ? 100 : limit);

  while (true) {
    const page = await withTimeout(
      getBoardPage(authorization, workspaceId, { limit: isoLimit, after: scanAfter }),
      timeoutMs,
      'Board fetch timed out',
    );

    if (page.status !== 200 || !Array.isArray(page.board)) {
      return { error: page.message || 'Failed to fetch boards' };
    }

    const boardIds = page.board
      .map((b) => b?.id?.toString?.() ?? b?.id)
      .filter(Boolean)
      .map((id) => String(id));

    const dbBoards = boardIds.length
      ? await Board.find({ boardId: { $in: boardIds }, workspaceId: workspaceId.toString() })
          .select('boardId label')
          .lean()
      : [];

    const enrichedPage = enrichBoardsWithLabels(page.board, dbBoards);
    collected = mergeBoardPageResults(collected, enrichedPage, q, boardMatchesQuery, limit);

    nextAfter = page.after ?? null;
    scanHasMore = Boolean(page.has_more);
    scanAfter = nextAfter;
    pagesScanned += 1;

    setImmediate(() => {
      persistBoardsInBackground(page.board, req);
    });

    if (shouldStopBoardCollection({
      q,
      limit,
      collectedLength: collected.length,
      scanHasMore,
      pagesScanned,
      maxScanPages,
      scanAfter,
    })) {
      break;
    }
  }

  return { collected, nextAfter, scanHasMore };
}
