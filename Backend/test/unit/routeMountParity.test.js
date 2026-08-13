import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * `src/index.js` is the production entry point and does NOT use `createApp()`.
 * The two files are parallel express apps, so every route has to be mounted
 * twice. KAN-15 already shipped the failure mode this guards: a router mounted
 * only in `app.js` existed in every test and 404'd in production, with the
 * whole suite green.
 *
 * Read as text rather than by importing. Importing `index.js` would open a
 * listener, connect Mongoose, start the BullMQ workers and initialise Sentry —
 * far too much for a test whose entire question is "are the same paths
 * mounted". Consolidating `index.js` onto `createApp()` is the real fix and is
 * deliberately not attempted here: it restructures the production entry point
 * of a repository that deploys on merge.
 */

const SOURCES = {
  app: fileURLToPath(new URL('../../src/app.js', import.meta.url)),
  index: fileURLToPath(new URL('../../src/index.js', import.meta.url)),
};

/**
 * Every path passed to `app.use('/api/...')` in a file.
 *
 * Deliberately narrow: it matches the single-quoted literal form both files
 * use throughout. A mount written some other way is invisible here, which is
 * why the count assertion below exists — it fails if the extractor silently
 * stops finding anything.
 */
function mountedApiPaths(file) {
  const source = readFileSync(file, 'utf8');
  const matches = source.matchAll(/app\.use\(\s*'(\/api\/[^']*)'/g);
  return new Set([...matches].map((match) => match[1]));
}

describe('route mount parity between app.js and index.js', () => {
  const appMounts = mountedApiPaths(SOURCES.app);
  const indexMounts = mountedApiPaths(SOURCES.index);

  it('finds mounts in both files, so a broken extractor cannot pass silently', () => {
    expect(appMounts.size).toBeGreaterThan(10);
    expect(indexMounts.size).toBeGreaterThan(10);
  });

  it('mounts every app.js route in index.js as well', () => {
    const missing = [...appMounts].filter((path) => !indexMounts.has(path)).sort();

    // Named in the assertion so the failure says which route would 404 in
    // production rather than just "sets differ".
    expect(missing).toEqual([]);
  });

  it('tolerates index.js mounting more than app.js', () => {
    // Bull Board at /api/queues is deliberately production-only: it needs a
    // live Redis connection that the test app has no reason to open. The
    // invariant is one-directional on purpose — app.js ⊆ index.js.
    const indexOnly = [...indexMounts].filter((path) => !appMounts.has(path));

    expect(indexOnly).toContain('/api/queues');
  });
});
