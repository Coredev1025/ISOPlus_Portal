// The offline stand-in for S3 object storage. When isOfflineMode(),
// utils/uploadS3.js writes here instead of S3 and builds a URL under
// /api/local-files, which routes/localFiles.js serves — so a webhook's pdfUrl
// is genuinely downloadable with no AWS account, including through an ngrok
// tunnel from a live ISO+ board.
//
// A development affordance: see routes/localFiles.js for why the serving route
// gates on NODE_ENV as well as offline mode.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Backend/.local-s3, gitignored and bind-mounted in dev compose. */
const DEFAULT_ROOT = fileURLToPath(new URL('../../.local-s3', import.meta.url));

/**
 * Read at call time, not import time, so a test can point the store at a temp
 * directory via LOCAL_FILE_ROOT instead of deleting the developer's real one.
 */
export function localFileRoot() {
  return process.env.LOCAL_FILE_ROOT || DEFAULT_ROOT;
}

/**
 * The absolute path a key may read or write, or a throw.
 *
 * Keys are request-derived, so this resolver is the only thing between a
 * crafted key and an arbitrary file access. Percent-decode first — '..%2f'
 * arrives encoded — then require the resolved path to stay inside the root.
 *
 * A key that is not a valid escape sequence falls back to itself rather than
 * throwing: Express already decoded the path param, so a document named
 * "100% Funded" carries a literal '%' that decodeURIComponent cannot parse, and
 * refusing it killed the offline PDF pipeline. The containment check below
 * still runs on whichever string won.
 */
export function resolveLocalFilePath(key, root = localFileRoot()) {
  const raw = String(key);
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
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
