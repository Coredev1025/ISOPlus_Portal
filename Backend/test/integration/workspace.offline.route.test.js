import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createApp } from '../../src/app.js';
import { authenticatedAgent } from '../helpers/auth.js';
import { server } from '../msw/server.js';
import Business from '../../src/models/Business.js';
import Board from '../../src/models/Board.js';

const app = createApp();

const V2 = 'https://app.isoplus.online/api/v2';

// routes/workspace.js chooses between the real ISO+ collection functions and the
// offline ones per request. The swap is invisible to the request handler, which
// is the point — so these tests drive the route, not the provider, to prove the
// substitution really is transparent.

describe('workspace routes, offline vs proxied', () => {
  const saved = {};
  const ENV = ['PERSONAL_ACCESS_TOKEN', 'JWT_SECRET', 'ISOPLUS_OFFLINE'];

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.JWT_SECRET = 'test-jwt-secret';
  });

  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('offline (no ISO+ credentials)', () => {
    beforeEach(() => {
      process.env.PERSONAL_ACCESS_TOKEN = '';
      process.env.ISOPLUS_OFFLINE = '1';
    });

    it('lists workspaces from MongoDB', async () => {
      // The whole reason offline mode exists: this endpoint proxies ISO+, so
      // with a blank token the local app showed no workspaces and every page
      // below it was unreachable. Seeding could not fix that.
      await Business.create({ workspaceId: '55369', name: 'Test' });

      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
      const res = await agent.get('/api/workspaces');

      expect(res.status).toBe(200);
      expect(res.body.workspace).toHaveLength(1);
      expect(res.body.workspace[0]).toMatchObject({ id: '55369', name: 'Test' });
    });

    it('gives support_admin the admin role on the workspace', async () => {
      // mapWorkspaceWithRole() derives this from the session, which is why the
      // offline getMemberRole returns null rather than inventing an answer.
      await Business.create({ workspaceId: '55369', name: 'Test' });

      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
      const res = await agent.get('/api/workspaces');

      expect(res.body.workspace[0].user_role).toBe('admin');
    });

    it('lists that workspace\'s boards from MongoDB', async () => {
      await Board.create({ boardId: 'eNiJpH14PN3', name: 'Care Management', workspaceId: '55369' });

      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
      const res = await agent.get('/api/workspaces/boards').query({ workspaceId: '55369' });

      expect(res.status).toBe(200);
      const ids = (res.body.board ?? res.body.boards ?? []).map((b) => b.id);
      expect(ids).toContain('eNiJpH14PN3');
    });

    it('still rejects a missing workspaceId', async () => {
      // Offline mode must not soften validation — the provider swap happens
      // after this check, and a 400 here is the documented contract.
      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
      const res = await agent.get('/api/workspaces/boards');
      expect(res.status).toBe(400);
    });

    it('makes no request to ISO+', async () => {
      // The guarantee that makes this usable on a laptop with no network. msw
      // is configured with onUnhandledRequest: 'error', so an escaping call
      // would fail the test rather than silently hang.
      let called = false;
      server.use(http.get(`${V2}/workspaces`, () => {
        called = true;
        return HttpResponse.json({ data: [], has_more: false, after: null });
      }));

      await Business.create({ workspaceId: '55369', name: 'Test' });
      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
      await agent.get('/api/workspaces');

      expect(called).toBe(false);
    });
  });

  describe('online (token present)', () => {
    beforeEach(() => {
      process.env.PERSONAL_ACCESS_TOKEN = 'test-pat';
      process.env.ISOPLUS_OFFLINE = '0';
    });

    it('proxies ISO+ and ignores what is in MongoDB', async () => {
      // The complement of the test above: with a token, Mongo must not be
      // consulted, or a developer with real credentials would see stub data.
      await Business.create({ workspaceId: 'from-mongo', name: 'Should Not Appear' });

      server.use(http.get(`${V2}/workspaces`, () => HttpResponse.json({
        data: [{ id: 'from-isoplus', name: 'Live Workspace' }],
        has_more: false,
        after: null,
      })));

      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
      const res = await agent.get('/api/workspaces');

      expect(res.status).toBe(200);
      const ids = res.body.workspace.map((w) => w.id);
      expect(ids).toContain('from-isoplus');
      expect(ids).not.toContain('from-mongo');
    });
  });
});
