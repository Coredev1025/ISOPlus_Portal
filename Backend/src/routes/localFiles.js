// Serves the offline stand-in for S3 (utils/localFileStore.js), so the pdfUrl
// an offline PDF webhook returns is genuinely downloadable — including through
// an ngrok tunnel, which makes the "Click here to download" link written back
// to a live ISO+ board work against a local backend.
//
// The whole mount answers 404 outside offline mode, checked per request rather
// than at boot so a test can flip modes without rebuilding the app. In
// production these files do not exist and isOfflineMode() is hard false, so
// this can never become an unauthenticated file server on a deployed host.
// Mounted in BOTH src/index.js and src/app.js — see routeMountParity.test.js.

import express from 'express';
import { existsSync } from 'node:fs';

import { isOfflineMode } from '../services/offlineIsoplus.js';
import { resolveLocalFilePath } from '../utils/localFileStore.js';
import { warn } from '../utils/logger.js';

const router = express.Router();

router.get(/^\/(.+)/, (req, res) => {
  if (!isOfflineMode()) return res.status(404).end();

  let path;
  try {
    path = resolveLocalFilePath(req.params[0]);
  } catch (err) {
    // A traversal attempt and a malformed key get the same 404 as a missing
    // file: nothing here needs to explain itself to a prober.
    warn('Local-Files', 'Refused local file key', { message: err.message }, req);
    return res.status(404).end();
  }

  if (!existsSync(path)) return res.status(404).end();
  return res.sendFile(path);
});

export default router;
