import { OUTPUT_PREFIX } from '../constants/storage.js';
import { getS3File } from './uploadS3.js';

/**
 * Whether `key` is a generated document under the claimed workspace.
 *
 * Generated PDFs live at `output/<workspaceId>/<boardId>/<type>/<name>`
 * (see buildOutputKey). The browser download proxy must refuse any other key
 * so a caller cannot ask this route to stream logos or another tenant's files
 * by swapping the URL while keeping their own workspaceId in the body.
 *
 * Touchpoints: routes/pdfLink.js (POST /file).
 */
export function assertGeneratedDocumentKeyForWorkspace(key, workspaceId) {
  if (typeof key !== 'string' || typeof workspaceId !== 'string') return false;
  if (!key || !workspaceId) return false;
  const prefix = `${OUTPUT_PREFIX}/${workspaceId}/`;
  return key.startsWith(prefix);
}

/**
 * Last path segment of an object key, for Content-Disposition when the client
 * did not supply a filename.
 *
 * Touchpoints: routes/pdfLink.js (POST /file).
 */
export function filenameFromObjectKey(key) {
  if (typeof key !== 'string' || !key) return 'document.pdf';
  const parts = key.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'document.pdf';
}

/**
 * ASCII-only fallback for the `filename="..."` Content-Disposition parameter.
 * Does not change S3 keys or the client `link.download` name — that stays
 * whatever the origin Invoice Generator / Monthly Statement code built.
 *
 * Touchpoints: contentDispositionAttachment.
 */
export function safeAttachmentFilename(name, fallback = 'document.pdf') {
  const raw = typeof name === 'string' ? name.trim() : '';
  const source = raw || fallback;
  const flattened = source
    .replace(/[/\\]/g, '-')
    .replace(/["\r\n]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flattened) return fallback;
  return /\.pdf$/i.test(flattened) ? flattened : `${flattened}.pdf`;
}

/**
 * Percent-encode a filename for RFC 5987 `filename*=UTF-8''...` so the origin
 * download name (including ISO+™) survives in the header without Node's
 * ERR_INVALID_CHAR on non-ASCII `filename="..."`.
 */
export function encodeContentDispositionFilename(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Content-Disposition that preserves the origin download filename.
 * - `filename=` — ASCII fallback (Node-safe)
 * - `filename*=` — full origin name, including ™
 *
 * Touchpoints: routes/pdfLink.js (POST /file).
 */
export function contentDispositionAttachment(name) {
  const original = (typeof name === 'string' && name.trim()) || 'document.pdf';
  const ascii = safeAttachmentFilename(original);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeContentDispositionFilename(original)}`;
}

/**
 * Older generated PDFs may still live on AWS_BUCKET_PUBLIC; current ones use
 * the private bucket with a presigned URL. Prefer the bucket the URL names.
 *
 * Touchpoints: readGeneratedDocumentBytes.
 */
export function preferPublicBucketFromUrl(fileUrl) {
  const publicBucket = process.env.AWS_BUCKET_PUBLIC;
  if (!publicBucket || typeof fileUrl !== 'string') return false;
  return fileUrl.includes(publicBucket);
}

/**
 * Load generated-document bytes without renaming keys. Tries private then
 * public (or public first when the stored URL already points at the public
 * bucket) so older invoices remain downloadable after the private-bucket move.
 *
 * Touchpoints: routes/pdfLink.js (POST /file).
 */
export async function readGeneratedDocumentBytes(key, fileUrl, deps = {}) {
  const getFile = deps.getS3File ?? getS3File;
  const order = preferPublicBucketFromUrl(fileUrl) ? [true, false] : [false, true];
  let lastErr;
  for (const publicRead of order) {
    try {
      return await getFile(key, publicRead);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
