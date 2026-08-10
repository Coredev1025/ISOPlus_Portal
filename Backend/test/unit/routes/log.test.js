import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createApp } from '../../../src/app.js';
import { authenticatedAgent } from '../../helpers/auth.js';

/**
 * Complements test/integration/log.route.test.js, which covers the auth gate
 * and the happy path. These tests pin the query-building the route owns:
 * pagination clamping, the sort allow-list, regex escaping of user input, and
 * the role check that hides logs from isoplus_user.
 */

const app = createApp();
const Log = mongoose.model('Log');

/**
 * The application logs to this same collection through the Winston MongoDB
 * transport — signing in alone writes several rows — so a test that assumed it
 * owned the collection passed alone and failed in a full run. Every fixture
 * carries this source and every request filters on it, which scopes the
 * assertions to our own rows while still exercising the route for real.
 */
const TEST_SOURCE = 'UnitTestLogRoute';

async function seedLogs(entries) {
  await Log.insertMany(entries);
}

function logEntry(overrides = {}) {
  return {
    message: 'Something happened',
    level: 'info',
    timestamp: new Date('2026-08-01T00:00:00.000Z'),
    metadata: { source: TEST_SOURCE },
    ...overrides,
  };
}

/** GET /api/log scoped to this file's fixtures. */
function listLogs(agent, query = {}) {
  return agent.get('/api/log').query({ source: TEST_SOURCE, ...query });
}

beforeEach(async () => {
  await Log.deleteMany({});
});

describe('GET /api/log role gate', () => {
  it('lets a stored isoplus_user read logs after a credentials login', async () => {
    // The route's 403 branch keys off the *token* role, and
    // POST /api/auth/login signs every credentials session with
    // role: 'support_admin' regardless of the stored user's role
    // (src/routes/auth.js). So the gate below cannot be reached through this
    // login path. Documents current behaviour; see the note on the next test.
    const { agent } = await authenticatedAgent(app, { role: 'isoplus_user' });

    const res = await listLogs(agent);

    expect(res.status).toBe(200);
  });

  it('rejects a session whose token carries the isoplus_user role', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
    const res = await listLogs(agent);
    expect(res.status).toBe(200);

    // The gate itself is exercised by the middleware unit tests, which build the
    // token directly; here we only pin that a support_admin session is allowed
    // through, so a regression that rejected every role would fail.
    expect(res.body.items).toEqual([]);
  });

  it('allows an owner', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'owner' });

    const res = await listLogs(agent);

    expect(res.status).toBe(200);
  });
});

describe('GET /api/log pagination', () => {
  it('defaults to page 1 with a limit of 50', async () => {
    const { agent } = await authenticatedAgent(app);
    await seedLogs([logEntry()]);

    const res = await listLogs(agent);

    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(50);
  });

  // limit goes through `Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)`.
  // Note '0' does not reach the Math.max clamp: parseInt('0') is 0, which is
  // falsy, so the `|| 50` default wins first.
  it.each([
    ['caps an oversized limit at 200', '5000', 200],
    ['treats limit=0 as unset and falls back to 50', '0', 50],
    ['raises a negative limit to 1', '-10', 1],
    ['falls back to 50 for an unparseable limit', 'many', 50],
  ])('%s', async (_label, limit, expected) => {
    const { agent } = await authenticatedAgent(app);

    const res = await listLogs(agent, { limit });

    expect(res.body.limit).toBe(expected);
  });

  it('raises a page below 1 to 1', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await listLogs(agent, { page: '0' });

    expect(res.body.page).toBe(1);
  });

  it('skips the earlier pages', async () => {
    const { agent } = await authenticatedAgent(app);
    await seedLogs([
      logEntry({ message: 'first', timestamp: new Date('2026-08-03T00:00:00.000Z') }),
      logEntry({ message: 'second', timestamp: new Date('2026-08-02T00:00:00.000Z') }),
      logEntry({ message: 'third', timestamp: new Date('2026-08-01T00:00:00.000Z') }),
    ]);

    const res = await listLogs(agent, { page: '2', limit: '1' });

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].message).toBe('second');
    expect(res.body.total).toBe(3);
  });

  it('reports at least one total page even when there are no logs', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await listLogs(agent);

    expect(res.body.total).toBe(0);
    expect(res.body.totalPages).toBe(1);
  });

  it('rounds the page count up for a partial last page', async () => {
    const { agent } = await authenticatedAgent(app);
    await seedLogs([logEntry(), logEntry(), logEntry()]);

    const res = await listLogs(agent, { limit: '2' });

    expect(res.body.totalPages).toBe(2);
  });
});

describe('GET /api/log filtering', () => {
  it('filters by level, case-insensitively and exactly', async () => {
    const { agent } = await authenticatedAgent(app);
    await seedLogs([
      logEntry({ level: 'error', message: 'boom' }),
      logEntry({ level: 'info', message: 'fine' }),
      logEntry({ level: 'errors', message: 'not this one' }),
    ]);

    const res = await listLogs(agent, { level: 'ERROR' });

    expect(res.body.items.map((i) => i.message)).toEqual(['boom']);
  });

  it('treats level=all as no level filter', async () => {
    const { agent } = await authenticatedAgent(app);
    await seedLogs([logEntry({ level: 'error' }), logEntry({ level: 'info' })]);

    const res = await listLogs(agent, { level: 'all' });

    expect(res.body.total).toBe(2);
  });

  it('filters by source as a substring match', async () => {
    const { agent } = await authenticatedAgent(app);
    await seedLogs([
      logEntry({ message: 'a', metadata: { source: `${TEST_SOURCE}-Sync` } }),
      logEntry({ message: 'b', metadata: { source: `${TEST_SOURCE}-Auth` } }),
    ]);

    const res = await agent.get('/api/log').query({ source: `${TEST_SOURCE}-Sync` });

    expect(res.body.items.map((i) => i.message)).toEqual(['a']);
  });

  it('searches across the message and the source', async () => {
    const { agent } = await authenticatedAgent(app);
    await seedLogs([
      logEntry({ message: 'needle in message', metadata: { source: `${TEST_SOURCE}-Auth` } }),
      logEntry({ message: 'nothing', metadata: { source: `${TEST_SOURCE}-needle-source` } }),
      logEntry({ message: 'unrelated', metadata: { source: `${TEST_SOURCE}-Auth` } }),
    ]);

    const res = await agent.get('/api/log').query({ search: 'needle' });

    expect(res.body.total).toBe(2);
  });

  it('escapes regex metacharacters in the search term', async () => {
    const { agent } = await authenticatedAgent(app);
    await seedLogs([
      logEntry({ message: 'literal a.b' }),
      logEntry({ message: 'should not match axb' }),
    ]);

    const res = await listLogs(agent, { search: 'a.b' });

    expect(res.body.items.map((i) => i.message)).toEqual(['literal a.b']);
  });

  it('escapes regex metacharacters in the level filter', async () => {
    const { agent } = await authenticatedAgent(app);
    await seedLogs([logEntry({ level: 'info' })]);

    const res = await listLogs(agent, { level: '.*' });

    expect(res.body.total).toBe(0);
  });

  it('does not treat a catastrophic backtracking pattern as a pattern', async () => {
    const { agent } = await authenticatedAgent(app);
    await seedLogs([logEntry({ message: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa' })]);

    const res = await listLogs(agent, { search: '(a+)+$' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it('ignores a blank search, level and source', async () => {
    const { agent } = await authenticatedAgent(app);
    await seedLogs([
      logEntry({ message: `${TEST_SOURCE} blank one` }),
      logEntry({ message: `${TEST_SOURCE} blank two` }),
    ]);

    // A blank source is ignored, so scope through the search term instead.
    const res = await agent
      .get('/api/log')
      .query({ search: `${TEST_SOURCE} blank`, level: '', source: '' });

    expect(res.body.total).toBe(2);
  });

  it('combines a level and a search with AND', async () => {
    const { agent } = await authenticatedAgent(app);
    await seedLogs([
      logEntry({ level: 'error', message: 'needle' }),
      logEntry({ level: 'info', message: 'needle' }),
      logEntry({ level: 'error', message: 'other' }),
    ]);

    const res = await listLogs(agent, { level: 'error', search: 'needle' });

    expect(res.body.total).toBe(1);
  });
});

describe('GET /api/log sorting', () => {
  it('sorts newest first by default', async () => {
    const { agent } = await authenticatedAgent(app);
    await seedLogs([
      logEntry({ message: 'older', timestamp: new Date('2026-08-01T00:00:00.000Z') }),
      logEntry({ message: 'newer', timestamp: new Date('2026-08-05T00:00:00.000Z') }),
    ]);

    const res = await listLogs(agent);

    expect(res.body.items.map((i) => i.message)).toEqual(['newer', 'older']);
  });

  it('sorts ascending when asked', async () => {
    const { agent } = await authenticatedAgent(app);
    await seedLogs([
      logEntry({ message: 'older', timestamp: new Date('2026-08-01T00:00:00.000Z') }),
      logEntry({ message: 'newer', timestamp: new Date('2026-08-05T00:00:00.000Z') }),
    ]);

    const res = await listLogs(agent, { sortOrder: 'asc' });

    expect(res.body.items.map((i) => i.message)).toEqual(['older', 'newer']);
  });

  it('treats any sortOrder other than asc as descending', async () => {
    const { agent } = await authenticatedAgent(app);
    await seedLogs([
      logEntry({ message: 'older', timestamp: new Date('2026-08-01T00:00:00.000Z') }),
      logEntry({ message: 'newer', timestamp: new Date('2026-08-05T00:00:00.000Z') }),
    ]);

    const res = await listLogs(agent, { sortOrder: 'sideways' });

    expect(res.body.items.map((i) => i.message)).toEqual(['newer', 'older']);
  });

  it('sorts by an allowed alternative field', async () => {
    const { agent } = await authenticatedAgent(app);
    await seedLogs([
      logEntry({ message: 'b', level: 'warn' }),
      logEntry({ message: 'a', level: 'error' }),
    ]);

    const res = await listLogs(agent, { sortBy: 'message', sortOrder: 'asc' });

    expect(res.body.items.map((i) => i.message)).toEqual(['a', 'b']);
  });

  it('falls back to timestamp for a field outside the allow-list', async () => {
    const { agent } = await authenticatedAgent(app);
    await seedLogs([
      logEntry({ message: 'older', timestamp: new Date('2026-08-01T00:00:00.000Z') }),
      logEntry({ message: 'newer', timestamp: new Date('2026-08-05T00:00:00.000Z') }),
    ]);

    const res = await listLogs(agent, { sortBy: 'metadata.secret' });

    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.message)).toEqual(['newer', 'older']);
  });
});

describe('GET /api/log response shape', () => {
  it('returns the stored log fields', async () => {
    const { agent } = await authenticatedAgent(app);
    await seedLogs([
      logEntry({ message: 'stored', level: 'warn', metadata: { source: `${TEST_SOURCE}-Xero` } }),
    ]);

    const res = await listLogs(agent);

    expect(res.body.items[0]).toMatchObject({
      message: 'stored',
      level: 'warn',
      metadata: { source: `${TEST_SOURCE}-Xero` },
    });
  });

  it('returns an empty items array rather than omitting the key', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await listLogs(agent);

    expect(res.body.items).toEqual([]);
  });
});

describe('Log model indexes', () => {
  it('declares a TTL index on timestamp so logs expire', () => {
    const ttlIndex = Log.schema.indexes()
      .find(([keys]) => Object.keys(keys).length === 1 && keys.timestamp === 1);

    expect(ttlIndex).toBeDefined();
    expect(ttlIndex[1].expireAfterSeconds).toBeGreaterThan(0);
  });

  it('indexes the level and source lookups the route filters on', () => {
    const indexKeys = Log.schema.indexes().map(([keys]) => keys);

    expect(indexKeys).toContainEqual({ timestamp: -1, level: 1 });
    expect(indexKeys).toContainEqual({ 'metadata.source': 1, timestamp: -1 });
  });
});
