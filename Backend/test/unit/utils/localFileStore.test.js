// Backend/test/unit/utils/localFileStore.test.js
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  saveLocalFile,
  resolveLocalFilePath,
  buildLocalFileUrl,
} from '../../../src/utils/localFileStore.js';

// The offline stand-in for S3. uploadFileToS3 writes here instead of AWS when
// isOfflineMode(), and routes/localFiles.js serves the directory back, so the
// pdfUrl a webhook returns is genuinely downloadable with no AWS account.

describe('localFileStore', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'local-file-store-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips a buffer under the S3-style key, creating directories', async () => {
    const key = 'output/55369/eNiJpH14PN3/NDIS-quote/QT-1090-ISO+™-item.pdf';

    await saveLocalFile(key, Buffer.from('%PDF-fake'), root);

    const resolved = resolveLocalFilePath(key, root);
    expect(existsSync(resolved)).toBe(true);
    expect(readFileSync(resolved).toString()).toBe('%PDF-fake');
  });

  // The keys come from request-derived values, so the resolver is the only
  // thing between a crafted key and an arbitrary file read.
  it.each(['../escape.pdf', 'a/../../escape.pdf', '/etc/passwd', 'a/..%2f..%2fescape'])(
    'refuses the traversal attempt %s',
    (key) => {
      expect(() => resolveLocalFilePath(key, root)).toThrow(/outside|invalid/i);
    },
  );

  it('builds a URL under /api/local-files with the key percent-encoded', () => {
    const url = buildLocalFileUrl('output/a b/QT-1+™.pdf', 'https://example.test');

    expect(url).toBe(
      'https://example.test/api/local-files/output/a%20b/QT-1%2B%E2%84%A2.pdf',
    );
  });
});
