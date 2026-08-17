// Backend/test/unit/routes/localFiles.test.js
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

import { createApp } from '../../../src/app.js';
import { saveLocalFile } from '../../../src/utils/localFileStore.js';

/**
 * Serves the offline stand-in for S3 (see utils/localFileStore.js). The whole
 * mount answers 404 outside offline mode: in production these files do not
 * exist, and a route that only ever 404s there is indistinguishable from no
 * route — which is the point, it must not become an unauthenticated file
 * server on a deployed host.
 */

const app = createApp();
const KEY = 'output/55369/test-board/NDIS-quote/route-test.pdf';

describe('GET /api/local-files', () => {
  const saved = {};

  let root;

  beforeEach(async () => {
    saved.ISOPLUS_OFFLINE = process.env.ISOPLUS_OFFLINE;
    saved.LOCAL_FILE_ROOT = process.env.LOCAL_FILE_ROOT;
    saved.NODE_ENV = process.env.NODE_ENV;
    // A temp root, NOT the real store: this suite once rm -rf'd the
    // developer's freshly generated PDFs through the default path.
    root = mkdtempSync(join(tmpdir(), 'local-files-route-'));
    process.env.LOCAL_FILE_ROOT = root;
    await saveLocalFile(KEY, Buffer.from('%PDF-route-test'));
  });

  afterEach(() => {
    process.env.ISOPLUS_OFFLINE = saved.ISOPLUS_OFFLINE;
    process.env.LOCAL_FILE_ROOT = saved.LOCAL_FILE_ROOT;
    process.env.NODE_ENV = saved.NODE_ENV;
    rmSync(root, { recursive: true, force: true });
  });

  it('serves a stored file as a PDF when offline', async () => {
    process.env.ISOPLUS_OFFLINE = '1';

    const res = await request(app).get(`/api/local-files/${KEY}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.toString()).toBe('%PDF-route-test');
  });

  it('404s for a key that was never stored', async () => {
    process.env.ISOPLUS_OFFLINE = '1';

    const res = await request(app).get('/api/local-files/output/nope.pdf');
    expect(res.status).toBe(404);
  });

  it('404s everywhere outside offline mode, even for a stored file', async () => {
    process.env.ISOPLUS_OFFLINE = '0';

    const res = await request(app).get(`/api/local-files/${KEY}`);
    expect(res.status).toBe(404);
  });

  it('404s in production even when ISOPLUS_OFFLINE=1 says otherwise', async () => {
    // isOfflineMode() checks ISOPLUS_OFFLINE before NODE_ENV, so this env
    // combination — what someone reaches for to debug a credentials problem on
    // a deployed host — used to turn this mount into an unauthenticated read of
    // Backend/.local-s3, which holds generated invoice PDFs and the composed
    // email outbox. The route refuses in production unconditionally.
    process.env.ISOPLUS_OFFLINE = '1';
    process.env.NODE_ENV = 'production';

    const res = await request(app).get(`/api/local-files/${KEY}`);
    expect(res.status).toBe(404);
  });

  it('refuses a traversal attempt rather than reading outside the store', async () => {
    process.env.ISOPLUS_OFFLINE = '1';

    const res = await request(app).get('/api/local-files/..%2f..%2fpackage.json');
    expect(res.status).toBe(404);
  });
});
