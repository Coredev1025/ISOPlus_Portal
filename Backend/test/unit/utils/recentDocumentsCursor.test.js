import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';

import {
  decodeRecentDocumentsCursor,
  encodeRecentDocumentsCursor,
  recentDocumentsCursorStage,
} from '../../../src/utils/recentDocumentsCursor.js';

/**
 * Paging back through a client's own documents.
 *
 * The panel shows the newest page and offers to fetch older ones, so every
 * document must appear on exactly one page. A cursor on `createdAt` alone
 * cannot promise that: a run generates several documents and two of them can
 * share a millisecond, and if such a pair straddles a page boundary the second
 * is skipped — silently, in the one list a client uses to check that a
 * document was raised at all. So the cursor carries the tiebreaker the sort
 * uses.
 */

const ID_A = new mongoose.Types.ObjectId('66a000000000000000000001');
const ID_B = new mongoose.Types.ObjectId('66a000000000000000000002');
const AT = new Date('2026-08-05T00:00:00.000Z');

describe('encode/decode', () => {
  it('round-trips the two fields the sort orders by', () => {
    const decoded = decodeRecentDocumentsCursor(
      encodeRecentDocumentsCursor({ createdAt: AT, pdfLinkId: ID_A }),
    );
    expect(decoded.createdAt.toISOString()).toBe(AT.toISOString());
    expect(String(decoded.pdfLinkId)).toBe(String(ID_A));
  });

  it('is opaque — it carries no presigned S3 URL', () => {
    // The pdfLink itself is deliberately not in the payload the API returns,
    // so it must not reappear inside a cursor. pdfLinkId is already public in
    // every document's pdfUrl.
    const cursor = encodeRecentDocumentsCursor({ createdAt: AT, pdfLinkId: ID_A });
    expect(Buffer.from(cursor, 'base64url').toString('utf8')).not.toMatch(/https?:/);
  });

  it.each([
    ['not base64 at all', '!!!!'],
    ['base64 that is not JSON', Buffer.from('nonsense').toString('base64url')],
    ['a JSON payload with no fields', Buffer.from('{}').toString('base64url')],
    ['an unparseable date', Buffer.from(JSON.stringify({ c: 'never', i: String(ID_A) })).toString('base64url')],
    ['an id that is not an ObjectId', Buffer.from(JSON.stringify({ c: AT.toISOString(), i: 'nope' })).toString('base64url')],
  ])('refuses %s', (_label, value) => {
    expect(decodeRecentDocumentsCursor(value)).toBeNull();
  });

  it('refuses an absent cursor rather than inventing one', () => {
    expect(decodeRecentDocumentsCursor(undefined)).toBeNull();
    expect(decodeRecentDocumentsCursor('')).toBeNull();
  });
});

describe('recentDocumentsCursorStage', () => {
  it('is nothing at all for the first page', () => {
    expect(recentDocumentsCursorStage(null)).toBeNull();
  });

  it('takes everything older, and breaks a tie by id', () => {
    const stage = recentDocumentsCursorStage({ createdAt: AT, pdfLinkId: ID_B });
    expect(stage).toEqual({
      $match: {
        $or: [
          { createdAt: { $lt: AT } },
          { createdAt: AT, pdfLinkId: { $lt: ID_B } },
        ],
      },
    });
  });
});
