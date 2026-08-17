// Serves the offline stand-in for S3 (utils/localFileStore.js), so the pdfUrl
// an offline PDF webhook returns is genuinely downloadable — including through
// an ngrok tunnel, which makes the "Click here to download" link written back
// to a live ISO+ board work against a local backend.
//
// The whole mount answers 404 outside offline mode, checked per request rather
// than at boot so a test can flip modes without rebuilding the app.
//
// It also answers 404 in production unconditionally, and that check is not
// redundant with the offline one: isOfflineMode() reads ISOPLUS_OFFLINE before
// NODE_ENV, so ISOPLUS_OFFLINE=1 on a deployed host — what someone reaches for
// to debug a credentials problem — used to satisfy the only gate this route
// has. There is no auth middleware here, so that turned .local-s3 (generated
// invoice and statement PDFs, and the composed-email outbox with participant
// addresses) into an unauthenticated, unscoped read. What this now guarantees
// is narrow and worth stating exactly: in production the mount is inert
// whatever the environment says, and outside production it is still an
// unauthenticated file server for anything under the store.
// Mounted in BOTH src/index.js and src/app.js — see routeMountParity.test.js.

import express from 'express';
import { existsSync } from 'node:fs';

import { isOfflineMode } from '../services/offlineIsoplus.js';
import { resolveLocalFilePath } from '../utils/localFileStore.js';
import { warn } from '../utils/logger.js';

const router = express.Router();

router.get(/^\/(.+)/, (req, res) => {
  if (process.env.NODE_ENV === 'production' || !isOfflineMode()) {
    return res.status(404).end();
  }

  let path;
  try {
    path = resolveLocalFilePath(req.params[0]);
  } catch (err) {
    // A traversal attempt gets the same 404 as a missing file: nothing here
    // needs to explain itself to a prober.
    warn('Local-Files', 'Refused local file key', { message: err.message }, req);
    return res.status(404).end();
  }

  if (!existsSync(path)) return res.status(404).end();
  return res.sendFile(path);
});

export default router;
