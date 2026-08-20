import { describe, it, expect } from 'vitest';

import { s3ObjectKeyFromUrl } from '../../../src/utils/s3ObjectKey.js';

/**
 * The inverse of buildOutputKey, shared by the SES attachment loader and the
 * PDF download route. Both have a stored URL and need the object behind it, and
 * they must agree.
 */
describe('s3ObjectKeyFromUrl', () => {
  const KEY = 'output/55390/board-a/NDIS-invoices/INV-1.pdf';

  // The production shape. A private bucket is read through a presigned URL, so
  // every real document URL carries this query string; keeping it made the key
  // unfindable, and the attachment was skipped rather than thrown.
  it('drops a presigned query string', () => {
    expect(s3ObjectKeyFromUrl(
      `https://iso-bucket.s3.ap-southeast-2.amazonaws.com/${KEY}`
      + '?X-Amz-Algorithm=AWS4-HMAC-SHA256'
      + '&X-Amz-Credential=AKIA%2F20260819%2Fap-southeast-2%2Fs3%2Faws4_request'
      + '&X-Amz-Expires=604800&X-Amz-Signature=deadbeef',
    )).toBe(KEY);
  });

  it('reads an offline local-files URL', () => {
    expect(s3ObjectKeyFromUrl(`http://localhost:4001/api/local-files/${KEY}`)).toBe(KEY);
  });

  it('reads a public-bucket URL', () => {
    expect(s3ObjectKeyFromUrl(`https://iso-public.s3.ap-southeast-2.amazonaws.com/${KEY}`)).toBe(KEY);
  });

  it('decodes a percent-encoded key, which is how getS3FileUrl writes a "+"', () => {
    expect(s3ObjectKeyFromUrl(
      'https://b.s3.ap-southeast-2.amazonaws.com/output/55390/Jane%20Smith%2BCo/INV-2.pdf',
    )).toBe('output/55390/Jane Smith+Co/INV-2.pdf');
  });

  it('drops a fragment', () => {
    expect(s3ObjectKeyFromUrl(`https://b.s3.amazonaws.com/${KEY}#page=2`)).toBe(KEY);
  });

  // Stripped before the split, so a query value carrying a separator of its own
  // cannot redirect the key.
  it('cannot be steered by a separator inside the query string', () => {
    expect(s3ObjectKeyFromUrl(
      `https://b.s3.amazonaws.com/${KEY}?next=https://evil.amazonaws.com/secret.pdf`,
    )).toBe(KEY);
    expect(s3ObjectKeyFromUrl(
      `http://localhost:4001/api/local-files/${KEY}?x=/api/local-files/other.pdf`,
    )).toBe(KEY);
  });

  it('passes a bare key through unchanged', () => {
    expect(s3ObjectKeyFromUrl(KEY)).toBe(KEY);
  });

  // Losing the document over a malformed escape would be worse than trying the
  // literal key, which is what an unencoded URL would have given anyway.
  it('falls back to the literal key when the escape sequence is malformed', () => {
    expect(s3ObjectKeyFromUrl('https://b.s3.amazonaws.com/output/100%.pdf'))
      .toBe('output/100%.pdf');
  });
});
