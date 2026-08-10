import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { auditHttpMiddleware } from '../../../src/middleware/auditHttp.js';
import AuditTrail from '../../../src/models/AuditTrail.js';

/**
 * Builds a request shaped like the ones Express hands the middleware: the
 * middleware reads originalUrl/method/params/query/body/headers/user and the
 * route pattern from baseUrl + route.path.
 */
function buildReq(overrides = {}) {
  return {
    method: 'POST',
    originalUrl: '/api/business/ws-1/profile',
    url: '/api/business/ws-1/profile',
    baseUrl: '/api/business',
    route: { path: '/:workspaceId/profile' },
    params: { workspaceId: 'ws-1' },
    query: {},
    body: {},
    headers: { 'x-request-id': 'req-1' },
    ip: '::ffff:10.0.0.9',
    user: { userId: 'u-1', email: 'admin@example.com', role: 'support_admin' },
    get(header) {
      return this.headers[header.toLowerCase()];
    },
    ...overrides,
  };
}

class FakeRes extends EventEmitter {
  constructor(statusCode = 200) {
    super();
    this.statusCode = statusCode;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the middleware and resolves once the audit write triggered by 'finish'
 * has settled.
 *
 * The middleware's 'finish' handler is async and Express never awaits it, so
 * there is nothing to await directly. `expect: 'audit'` polls until the row
 * lands; `expect: 'none'` waits out a fixed grace period so a late write
 * cannot silently pass the assertion (or leak into the next test).
 */
async function runMiddleware(req, res, { expect: expectation = 'audit' } = {}) {
  const before = await AuditTrail.countDocuments({});
  let nextCalled = 0;
  auditHttpMiddleware(req, res, () => {
    nextCalled += 1;
  });
  res.emit('finish');

  if (expectation === 'audit') {
    for (let i = 0; i < 100; i += 1) {
      await sleep(5);
      if ((await AuditTrail.countDocuments({})) > before) return nextCalled;
    }
    return nextCalled;
  }

  await sleep(150);
  return nextCalled;
}

describe('auditHttpMiddleware', () => {
  it('calls next synchronously so the request is never delayed', () => {
    const req = buildReq();
    const res = new FakeRes();
    let nextCalled = 0;
    auditHttpMiddleware(req, res, () => {
      nextCalled += 1;
    });
    expect(nextCalled).toBe(1);
  });

  it('writes one audit row for a successful write request', async () => {
    await runMiddleware(buildReq(), new FakeRes(200));

    const rows = await AuditTrail.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBe('ws-1');
    expect(rows[0].action).toBe('Profile');
    expect(rows[0].success).toBe(true);
    expect(rows[0].statusCode).toBe(200);
    expect(rows[0].category).toBe('APP');
  });

  it('records the request as failed for a 4xx response', async () => {
    await runMiddleware(buildReq(), new FakeRes(422));

    const row = await AuditTrail.findOne({}).lean();
    expect(row.success).toBe(false);
    expect(row.statusCode).toBe(422);
    expect(row.detail).toContain('FAILED');
    expect(row.detail).toContain('status=422');
  });

  it('treats 400 as the failure boundary and 399 as success', async () => {
    await runMiddleware(buildReq(), new FakeRes(399));
    await runMiddleware(buildReq(), new FakeRes(400));

    const rows = await AuditTrail.find({}).sort({ statusCode: 1 }).lean();
    expect(rows.map((r) => [r.statusCode, r.success])).toEqual([
      [399, true],
      [400, false],
    ]);
  });

  it.each([
    '/api/healthcheck',
    '/api/log',
    '/api/queues',
    '/api/audit/trail',
    '/api/sync/workspaces/status/ws-1',
  ])('skips the noisy endpoint %s', async (urlPath) => {
    const req = buildReq({ originalUrl: urlPath, url: urlPath });
    await runMiddleware(req, new FakeRes(200), { expect: 'none' });

    expect(await AuditTrail.countDocuments({})).toBe(0);
  });

  it('never audits a CORS preflight', async () => {
    await runMiddleware(buildReq({ method: 'OPTIONS' }), new FakeRes(204), { expect: 'none' });

    expect(await AuditTrail.countDocuments({})).toBe(0);
  });

  it('skips a request that cannot be tied to a workspace', async () => {
    const req = buildReq({
      params: {},
      query: {},
      body: {},
      originalUrl: '/api/business/profile',
      url: '/api/business/profile',
      route: { path: '/profile' },
    });
    await runMiddleware(req, new FakeRes(200), { expect: 'none' });

    expect(await AuditTrail.countDocuments({})).toBe(0);
  });

  it('falls back to the workspaceId on the query string', async () => {
    const req = buildReq({ params: {}, query: { workspaceId: 'ws-query' } });
    await runMiddleware(req, new FakeRes(200));

    expect((await AuditTrail.findOne({}).lean()).workspaceId).toBe('ws-query');
  });

  it('falls back to the workspaceId in the body', async () => {
    const req = buildReq({ params: {}, query: {}, body: { workspaceId: 'ws-body' } });
    await runMiddleware(req, new FakeRes(200));

    expect((await AuditTrail.findOne({}).lean()).workspaceId).toBe('ws-body');
  });

  it('skips a GET with no explicit or mapped action', async () => {
    const req = buildReq({ method: 'GET' });
    await runMiddleware(req, new FakeRes(200), { expect: 'none' });

    expect(await AuditTrail.countDocuments({})).toBe(0);
  });

  it('audits a GET carrying an explicit action header', async () => {
    const req = buildReq({
      method: 'GET',
      headers: { 'x-user-action': 'View Invoice List', 'x-request-id': 'req-1' },
    });
    await runMiddleware(req, new FakeRes(200));

    expect((await AuditTrail.findOne({}).lean()).action).toBe('View Invoice List');
  });

  it('does not store a request body for a GET', async () => {
    const req = buildReq({
      method: 'GET',
      body: { secretPayload: 'x' },
      headers: { 'x-user-action': 'View Invoice List' },
    });
    await runMiddleware(req, new FakeRes(200));

    const row = await AuditTrail.findOne({}).lean();
    expect(row.metadata.body).toBeUndefined();
  });

  it('prefers an explicit header action over the derived one', async () => {
    const req = buildReq({
      headers: { 'x-app-action': 'Custom Action', 'x-request-id': 'req-1' },
    });
    await runMiddleware(req, new FakeRes(200));

    expect((await AuditTrail.findOne({}).lean()).action).toBe('Custom Action');
  });

  it('prefers a body action when no header carries one', async () => {
    const req = buildReq({ body: { workspaceId: 'ws-1', action: 'Body Action' } });
    await runMiddleware(req, new FakeRes(200));

    expect((await AuditTrail.findOne({}).lean()).action).toBe('Body Action');
  });

  it('maps the known monthly-statement PDF route to its human action', async () => {
    const req = buildReq({
      originalUrl: '/api/pdf/ws-1/b-1/monthly-statement',
      url: '/api/pdf/ws-1/b-1/monthly-statement',
      baseUrl: '/api/pdf',
      route: { path: '/:workspaceId/:boardId/monthly-statement' },
      params: { workspaceId: 'ws-1', boardId: 'b-1' },
    });
    await runMiddleware(req, new FakeRes(200));

    expect((await AuditTrail.findOne({}).lean()).action).toBe('Generate Monthly Statement');
  });

  it('maps the known monthly-statement CSV export GET to its human action', async () => {
    const req = buildReq({
      method: 'GET',
      originalUrl: '/api/export/ws-1/b-1/monthly-statement-csv',
      url: '/api/export/ws-1/b-1/monthly-statement-csv',
      baseUrl: '/api/export',
      route: { path: '/:workspaceId/:boardId/monthly-statement-csv' },
      params: { workspaceId: 'ws-1', boardId: 'b-1' },
    });
    await runMiddleware(req, new FakeRes(200));

    expect((await AuditTrail.findOne({}).lean()).action).toBe(
      'View Monthly Statement Data (CSV)',
    );
  });

  it('titles a PUT as "Update <segment>"', async () => {
    const req = buildReq({
      method: 'PUT',
      baseUrl: '/api/business',
      route: { path: '/:workspaceId/business-profile' },
    });
    await runMiddleware(req, new FakeRes(200));

    expect((await AuditTrail.findOne({}).lean()).action).toBe('Update Business Profile');
  });

  it('titles a DELETE as "Delete <segment>"', async () => {
    const req = buildReq({
      method: 'DELETE',
      baseUrl: '/api/pdf-link',
      route: { path: '/:workspaceId/link' },
    });
    await runMiddleware(req, new FakeRes(200));

    expect((await AuditTrail.findOne({}).lean()).action).toBe('Delete Link');
  });

  it('derives the action from the URL path when there is no route pattern', async () => {
    const req = buildReq({
      baseUrl: '',
      route: undefined,
      originalUrl: '/api/business/ws-1/sync_now?force=1',
      url: '/api/business/ws-1/sync_now?force=1',
    });
    await runMiddleware(req, new FakeRes(200));

    expect((await AuditTrail.findOne({}).lean()).action).toBe('Sync Now');
  });

  it('redacts secret-bearing body keys', async () => {
    const req = buildReq({
      body: { workspaceId: 'ws-1', password: 'hunter2', apiKey: 'k-123', keep: 'visible' },
    });
    await runMiddleware(req, new FakeRes(200));

    const row = await AuditTrail.findOne({}).lean();
    expect(row.metadata.body.password).toBe('[REDACTED]');
    expect(row.metadata.body.apiKey).toBe('[REDACTED]');
    expect(row.metadata.body.keep).toBe('visible');
    expect(JSON.stringify(row.metadata)).not.toContain('hunter2');
  });

  it('truncates a nested body beyond three levels', async () => {
    const req = buildReq({
      body: { workspaceId: 'ws-1', a: { b: { c: { d: 'too deep' } } } },
    });
    await runMiddleware(req, new FakeRes(200));

    const row = await AuditTrail.findOne({}).lean();
    expect(row.metadata.body.a.b.c).toBe('[Truncated]');
  });

  it('truncates an over-long string in the body to 2000 characters', async () => {
    const req = buildReq({ body: { workspaceId: 'ws-1', note: 'n'.repeat(2500) } });
    await runMiddleware(req, new FakeRes(200));

    const row = await AuditTrail.findOne({}).lean();
    expect(row.metadata.body.note).toHaveLength(2000);
    expect(row.metadata.body.note.endsWith('...')).toBe(true);
  });

  it('records the item id from the body in the detail and metadata', async () => {
    const req = buildReq({ body: { workspaceId: 'ws-1', itemId: 'item-99' } });
    await runMiddleware(req, new FakeRes(200));

    const row = await AuditTrail.findOne({}).lean();
    expect(row.detail).toContain('item=item-99');
    expect(row.metadata.entity.itemId).toBe('item-99');
  });

  it('falls back to the first items[] entry for the item id', async () => {
    const req = buildReq({ body: { workspaceId: 'ws-1', items: [{ id: 'from-items' }] } });
    await runMiddleware(req, new FakeRes(200));

    expect((await AuditTrail.findOne({}).lean()).metadata.entity.itemId).toBe('from-items');
  });

  it('classifies the entity as Board when a boardId is present, Workspace otherwise', async () => {
    await runMiddleware(
      buildReq({ params: { workspaceId: 'ws-1', boardId: 'b-1' } }),
      new FakeRes(200),
    );
    let row = await AuditTrail.findOne({}).lean();
    expect(row.entityType).toBe('Board');
    expect(row.entityId).toBe('b-1');

    await AuditTrail.deleteMany({});
    await runMiddleware(buildReq(), new FakeRes(200));
    row = await AuditTrail.findOne({}).lean();
    expect(row.entityType).toBe('Workspace');
    expect(row.entityId).toBe('ws-1');
  });

  it('carries the request and user context into the metadata', async () => {
    await runMiddleware(buildReq(), new FakeRes(200));

    const row = await AuditTrail.findOne({}).lean();
    expect(row.metadata.request).toMatchObject({
      requestId: 'req-1',
      userId: 'u-1',
      userEmail: 'admin@example.com',
      userRole: 'support_admin',
    });
    expect(row.metadata.http).toMatchObject({
      method: 'POST',
      path: '/api/business/ws-1/profile',
      routePattern: '/api/business/:workspaceId/profile',
    });
  });

  it('records a non-negative duration in the metadata and detail', async () => {
    await runMiddleware(buildReq(), new FakeRes(200));

    const row = await AuditTrail.findOne({}).lean();
    expect(row.metadata.timing.durationMs).toBeGreaterThanOrEqual(0);
    expect(row.detail).toMatch(/durationMs=\d/);
  });

  it('swallows a failure raised while building the audit entry', async () => {
    const req = buildReq();
    Object.defineProperty(req, 'params', {
      get() {
        throw new Error('params exploded');
      },
    });
    const res = new FakeRes(200);

    await expect(runMiddleware(req, res, { expect: 'none' })).resolves.toBe(1);
    expect(await AuditTrail.countDocuments({})).toBe(0);
  });

  it('audits nothing until the response finishes', async () => {
    const req = buildReq();
    const res = new FakeRes(200);
    auditHttpMiddleware(req, res, () => {});
    await new Promise((resolve) => setImmediate(resolve));

    expect(await AuditTrail.countDocuments({})).toBe(0);
  });
});
