// The stored object key behind a document URL — the inverse of
// utils/s3OutputKey.js's buildOutputKey, for the two places that have a URL and
// need the object it points at: the SES backend, which attaches the bytes, and
// the PDF download route, which re-signs a link that has expired.
//
// One implementation, because the two must agree: a key that reads back for the
// email but not for the download (or the reverse) is a bug nobody would look
// for.

/**
 * The query string is stripped FIRST, and that is the whole point: a private
 * bucket is read through a presigned URL, so every production document URL
 * carries `?X-Amz-Algorithm=...`. Keeping it made the key
 * `output/.../INV-1.pdf?X-Amz-Algorithm=...`, which GetObject cannot find —
 * and an unreadable attachment is skipped rather than thrown, so the client
 * received an invoice email with no invoice in it. Offline URLs have no query
 * string, which is why every test and every local run missed it.
 *
 * Stripped before the split, not after, so a query value can never contribute
 * a '/api/local-files/' or '.amazonaws.com/' of its own. Decoded last, for the
 * same reason: the key S3 stores is the decoded one ('Jane Smith+Co'), but
 * decoding before the split would let an encoded separator through.
 */
export function s3ObjectKeyFromUrl(url) {
  const withoutQuery = String(url).split(/[?#]/)[0];
  const key = withoutQuery.split('/api/local-files/')[1]
    ?? withoutQuery.split('.amazonaws.com/')[1]
    ?? withoutQuery;
  try {
    return decodeURIComponent(key);
  } catch {
    // A stray '%' is not a reason to lose the document: try the literal key,
    // which is what an unencoded URL would have given anyway.
    return key;
  }
}
