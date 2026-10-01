import { OUTPUT_PREFIX } from '../constants/storage.js';

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
 * A filename safe to put in Content-Disposition: attachment; filename="...".
 * Strips CR/LF/quotes (header injection) and path separators (directory climb).
 *
 * Touchpoints: routes/pdfLink.js (POST /file).
 */
export function safeAttachmentFilename(name, fallback = 'document.pdf') {
  const raw = typeof name === 'string' ? name.trim() : '';
  const source = raw || fallback;
  const flattened = source.replace(/[/\\]/g, '-').replace(/["\r\n]/g, '');
  if (!flattened) return fallback;
  return /\.pdf$/i.test(flattened) ? flattened : `${flattened}.pdf`;
}
