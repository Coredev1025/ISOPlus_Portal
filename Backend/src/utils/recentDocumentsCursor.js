/**
 * The cursor that pages back through a workspace's automation documents.
 *
 * The status panel shows the newest page and offers to fetch older ones, so
 * every document must appear on exactly one page. Offsets cannot promise that
 * on a list that grows at the head — a run finishing mid-read shifts every
 * later page by one and duplicates a document while hiding another — so this
 * is keyset paging: the client hands back where the last page stopped and the
 * next one resumes strictly after it.
 *
 * The key is `createdAt` AND `pdfLinkId`, because `createdAt` alone is not
 * unique. A run raises several documents and two can share a millisecond; a
 * pair like that straddling a page boundary loses the second one, silently, in
 * the one list a client uses to confirm a document was raised at all. The sort
 * orders by both, so the cursor carries both.
 *
 * The cursor is opaque to the client but deliberately carries nothing secret:
 * `pdfLinkId` is already public in every document's `pdfUrl`, while the stored
 * `pdfLink` — a presigned S3 URL — is not returned by the API and must not
 * reappear here.
 */

import mongoose from 'mongoose';

/**
 * Where a page stopped, as a string the client can hand straight back.
 *
 * Base64url of a two-field JSON object rather than the fields as separate
 * query parameters: it is one value to pass around, and it says by its shape
 * that the client should not be composing one itself.
 */
export function encodeRecentDocumentsCursor({ createdAt, pdfLinkId }) {
  const payload = JSON.stringify({
    c: new Date(createdAt).toISOString(),
    i: String(pdfLinkId),
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * The cursor a client sent, or null when it is anything else.
 *
 * Null rather than a throw for every malformed input, so the caller decides
 * whether a bad cursor is a 400 or a fall back to the first page. Both halves
 * are validated: a cursor is round-tripped through a URL and a client's
 * history, and an unparseable date reaching the aggregation would match every
 * document rather than none.
 */
export function decodeRecentDocumentsCursor(value) {
  if (typeof value !== 'string' || value === '') return null;

  const parsed = parseCursorPayload(value);
  if (!parsed) return null;

  const createdAt = new Date(parsed.c);
  if (Number.isNaN(createdAt.getTime())) return null;
  if (!mongoose.Types.ObjectId.isValid(parsed.i)) return null;

  return { createdAt, pdfLinkId: new mongoose.Types.ObjectId(parsed.i) };
}

/** The decoded object, or null — kept apart so the checks above read as a list. */
function parseCursorPayload(value) {
  try {
    const json = Buffer.from(value, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed.c === 'string' && typeof parsed.i === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * The aggregation stage that resumes after the cursor, or null for the first
 * page.
 *
 * Strictly after, in the same order the sort uses: everything older, plus
 * anything sharing the boundary instant whose id sorts below it. It belongs
 * AFTER the `$group`, on the grouped document's own `createdAt` — filtering
 * rows before grouping would re-admit a document whose newest row is on the
 * previous page but whose older rows are not, and page it twice.
 */
export function recentDocumentsCursorStage(cursor) {
  if (!cursor) return null;
  const { createdAt, pdfLinkId } = cursor;
  return {
    $match: {
      $or: [
        { createdAt: { $lt: createdAt } },
        { createdAt, pdfLinkId: { $lt: pdfLinkId } },
      ],
    },
  };
}
