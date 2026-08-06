import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createApp } from '../../src/app.js';
import { authenticatedAgent } from '../helpers/auth.js';
import { server } from '../msw/server.js';

const app = createApp();

const ATTRS_URL =
  'https://app.isoplus.online/api/v2/workspaces/:workspaceId/boards/:boardId/attributes';

// GET /api/boards/attribute feeds the two dropdowns on Board Configuration.
// It had two defects: it crashed whenever ISO+ was unavailable, and it had no
// offline path at all, so a local stack without credentials could not render
// the page.

describe('GET /api/boards/attribute', () => {
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

  it('requires authentication', async () => {
    const request = (await import('supertest')).default;
    const res = await request(app)
      .get('/api/boards/attribute')
      .query({ workspaceId: '55369', boardId: 'eNiJpH14PN3' });
    expect(res.status).toBe(401);
  });

  describe('offline (no ISO+ credentials)', () => {
    beforeEach(() => {
      process.env.PERSONAL_ACCESS_TOKEN = '';
      process.env.ISOPLUS_OFFLINE = '1';
    });

    it('serves text and longtext attributes from the fixture', async () => {
      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
      const res = await agent
        .get('/api/boards/attribute')
        .query({ workspaceId: '55369', boardId: 'eNiJpH14PN3' });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.attributes)).toBe(true);

      const names = res.body.attributes.map((a) => a.name);
      expect(names).toContain('Integration Message');
      expect(names).toContain('Generated PDF Link');
    });

    it('returns only text and longtext, since that is what the dropdowns accept', async () => {
      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
      const res = await agent
        .get('/api/boards/attribute')
        .query({ workspaceId: '55369', boardId: 'eNiJpH14PN3' });

      const types = [...new Set(res.body.attributes.map((a) => a.type))];
      expect(types.sort()).toEqual(['longtext', 'text']);
      // The fixture holds reference attributes too; they must be filtered out.
      expect(types).not.toContain('reference');
    });

    it('answers with an empty list for a board the fixture does not cover', async () => {
      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
      const res = await agent
        .get('/api/boards/attribute')
        .query({ workspaceId: '55369', boardId: 'not-the-fixture-board' });

      expect(res.status).toBe(200);
      expect(res.body.attributes).toEqual([]);
    });
  });

  describe('online, when ISO+ fails', () => {
    beforeEach(() => {
      process.env.PERSONAL_ACCESS_TOKEN = 'test-pat';
      process.env.ISOPLUS_OFFLINE = '0';
    });

    it('reports the upstream failure instead of crashing on undefined', async () => {
      // The regression this pins: getBoardAttributes() returns { message, status }
      // with no `attribute` key when its ISO+ call throws, and the route used to
      // read `.attribute.filter(...)` directly. That produced a TypeError and an
      // opaque 500 "Server error" for every upstream outage or expired token.
      server.use(http.get(ATTRS_URL, () => HttpResponse.json({ message: 'upstream exploded' }, { status: 503 })));

      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
      const res = await agent
        .get('/api/boards/attribute')
        .query({ workspaceId: '55369', boardId: 'eNiJpH14PN3' });

      expect(res.status).toBeGreaterThanOrEqual(400);
      // The distinguishing assertion: a real message, not the catch-all string
      // the TypeError used to produce.
      expect(res.body.message).toBeTruthy();
      expect(res.body.message).not.toBe('Server error');
    });

    it('returns an empty list, not a crash, when ISO+ has no attributes', async () => {
      server.use(http.get(ATTRS_URL, () => HttpResponse.json({ data: [], has_more: false, after: null })));

      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
      const res = await agent
        .get('/api/boards/attribute')
        .query({ workspaceId: '55369', boardId: 'eNiJpH14PN3' });

      expect(res.status).toBe(200);
      expect(res.body.attributes).toEqual([]);
    });

    it('passes through text and longtext attributes from ISO+', async () => {
      server.use(http.get(ATTRS_URL, () => HttpResponse.json({
        data: [
          { id: 'a1', name: 'Integration Message', type: 'longtext' },
          { id: 'a2', name: 'Some Reference', type: 'reference' },
          { id: 'a3', name: 'A Text Field', type: 'text' },
        ],
        has_more: false,
        after: null,
      })));

      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
      const res = await agent
        .get('/api/boards/attribute')
        .query({ workspaceId: '55369', boardId: 'eNiJpH14PN3' });

      expect(res.status).toBe(200);
      expect(res.body.attributes.map((a) => a.id).sort()).toEqual(['a1', 'a3']);
    });
  });
});
