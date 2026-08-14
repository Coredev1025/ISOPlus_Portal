// The offline stand-in for S3 object storage.
//
// Why this exists: the PDF webhooks end by uploading the generated document and
// writing back a download URL. Both halves are AWS calls, so without real
// credentials the pipeline that offline mode otherwise supports end to end
// dies at the very last step. When isOfflineMode(), utils/uploadS3.js writes
// here instead and builds a URL under /api/local-files, which
// routes/localFiles.js serves — so the pdfUrl a webhook returns is genuinely
// downloadable, including through an ngrok tunnel from a live ISO+ board.
//
// This is a development affordance with the same posture as
// services/offlineIsoplus.js: never active in production (see isOfflineMode),
// and the serving route 404s entirely outside offline mode.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Backend/.local-s3, gitignored. Bind-mounted in dev compose like the rest of
 * Backend/, so files written inside the container are visible on the host.
 */
const DEFAULT_ROOT = fileURLToPath(new URL('../../.local-s3', import.meta.url));

/**
 * Read at call time, not import time, so a test can point the store at a
 * temp directory via LOCAL_FILE_ROOT instead of deleting the developer's real
 * one — which is exactly what the first version of the route test did.
 */
export function localFileRoot() {
  return process.env.LOCAL_FILE_ROOT || DEFAULT_ROOT;
}

/**
 * The absolute path a key may read or write, or a throw.
 *
 * Keys are request-derived (workspace, board and item ids compose them), so
 * this resolver is the only thing between a crafted key and an arbitrary file
 * access. Percent-decode first — '..%2f' arrives encoded — then require the
 * resolved path to stay strictly inside the root.
 */
export function resolveLocalFilePath(key, root = localFileRoot()) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(key));
  } catch {
    throw new Error(`invalid local file key: ${key}`);
  }

  const resolved = resolve(root, decoded);
  if (!resolved.startsWith(resolve(root) + sep)) {
    throw new Error(`local file key resolves outside the store: ${key}`);
  }
  return resolved;
}

export async function saveLocalFile(key, buffer, root = localFileRoot()) {
  const path = resolveLocalFilePath(key, root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
  return path;
}

/**
 * The URL uploadS3's offline branch hands back in place of an S3 one. Each
 * path segment is percent-encoded individually — S3-style keys contain '/',
 * which must survive, and '+', '™' and spaces, which must not.
 */
export function buildLocalFileUrl(key, baseUrl = process.env.BACKEND_URL || 'http://localhost:4001') {
  const encoded = String(key).split('/').map(encodeURIComponent).join('/');
  return `${String(baseUrl).replace(/\/$/, '')}/api/local-files/${encoded}`;
}
