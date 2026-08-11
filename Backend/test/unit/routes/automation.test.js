import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { http, HttpResponse } from 'msw';
import { createApp } from '../../../src/app.js';
import { server } from '../../msw/server.js';
import { authenticatedAgent } from '../../helpers/auth.js';

/**
 * Characterization tests for src/routes/automation.js (mounted at /api/automation).
 *
 * The router talks to the ISO+ "automations" API through services/isoplus.js:
 *   GET  https://app.isoplus.online/api/{workspaceId}/automations/{boardId}
 *   PUT  https://app.isoplus.online/api/{workspaceId}/automations/{automationId}
 *
 * Note the GET puts the *boardId* in the automationId slot — that is what
 * buildIsoPlusAutomationUrl(workspaceId, boardId) produces, and the assertions
 * below pin it so a "fix" to the URL shape has to be a deliberate one.
 */

const app = createApp();

const AUTOMATION_HOST = 'https://app.isoplus.online';
const previousBackendUrl = process.env.BACKEND_URL;

beforeAll(() => {
  process.env.BACKEND_URL = 'https://portal.example.test';
});

afterAll(() => {
  if (previousBackendUrl === undefined) delete process.env.BACKEND_URL;
  else process.env.BACKEND_URL = previousBackendUrl;
});

function portalAutomation(overrides = {}) {
  return {
    id: 'auto-1',
    name: 'Portal - Generate Invoice',
    active: true,
    board_id: 'b1',
    workflow: [
      {
        type: 'webhook',
        config: {
          url: 'https://old-host.example.com/api/pdf/old-workspace/old-board/invoice',
          method: 'POST',
        },
      },
    ],
    ...overrides,
  };
}

function foreignAutomation(overrides = {}) {
  return {
    id: 'auto-2',
    name: 'Customer notification',
    active: true,
    board_id: 'b1',
    workflow: [
      {
        type: 'webhook',
        config: { url: 'https://old-host.example.com/api/pdf/old-workspace/old-board/quote' },
      },
    ],
    ...overrides,
  };
}

/**
 * Registers the automation list + update endpoints and records every request
 * the router makes, so the assertions can pin the URL and the PUT body rather
 * than only the response the route echoes back.
 */
function stubAutomationApi({ list, updateStatus = 200 }) {
  const calls = { gets: [], puts: [] };

  server.use(
    http.get(`${AUTOMATION_HOST}/api/:workspaceId/automations/:automationId`, ({ params }) => {
      calls.gets.push({ workspaceId: params.workspaceId, automationId: params.automationId });
      if (list === null) {
        return HttpResponse.json({ message: 'boom' }, { status: 500 });
      }
      return HttpResponse.json(list);
    }),
    http.put(
      `${AUTOMATION_HOST}/api/:workspaceId/automations/:automationId`,
      async ({ params, request: req }) => {
        const body = await req.json();
        calls.puts.push({ workspaceId: params.workspaceId, automationId: params.automationId, body });
        if (updateStatus !== 200) {
          return HttpResponse.json({ message: 'nope' }, { status: updateStatus });
        }
        return HttpResponse.json({ id: params.automationId, updated: true, name: body.name });
      }
    )
  );

  return calls;
}

describe('automation routes: authentication', () => {
  it('rejects an unauthenticated GET with 401', async () => {
    const res = await request(app).get('/api/automation/ws1/b1');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Authentication required' });
  });

  it('rejects an unauthenticated PUT with 401', async () => {
    const res = await request(app).put('/api/automation/ws1/b1').send({});

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Authentication required' });
  });
});

describe('GET /api/automation/:workspaceId/:boardId', () => {
  it('returns the automation list from ISO+ verbatim', async () => {
    const { agent } = await authenticatedAgent(app);
    const list = [portalAutomation(), foreignAutomation()];
    const calls = stubAutomationApi({ list });

    const res = await agent.get('/api/automation/ws1/b1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(list);
    expect(calls.gets).toEqual([{ workspaceId: 'ws1', automationId: 'b1' }]);
  });

  it('answers 500 when the workspaceId is not a safe path segment', async () => {
    // sanitizeApiPathSegment rejects '.', '/', '\' and '%'. No upstream call is
    // made, so no MSW handler is registered here — an unstubbed request would
    // fail the test via onUnhandledRequest: 'error'.
    const { agent } = await authenticatedAgent(app);

    const res = await agent.get('/api/automation/ws.1/b1');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to retrieve automation' });
  });

  it('answers 500 when the boardId is not a safe path segment', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent.get('/api/automation/ws1/b%5C1');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to retrieve automation' });
  });

  it('answers 200 with a null body when ISO+ fails, not 500', async () => {
    // getAutomation() swallows every axios error and returns null, so the
    // route's own catch block is unreachable for upstream failures and the
    // client receives a 200 carrying `null`.
    const { agent } = await authenticatedAgent(app);
    stubAutomationApi({ list: null });

    const res = await agent.get('/api/automation/ws1/b1');

    expect(res.status).toBe(200);
    expect(res.text).toBe('null');
  });
});

describe('PUT /api/automation/:workspaceId/:boardId', () => {
  it('rewrites the workflow callback URL of "Portal - " automations and returns the updates', async () => {
    const { agent } = await authenticatedAgent(app);
    const calls = stubAutomationApi({ list: [portalAutomation(), foreignAutomation()] });

    const res = await agent.put('/api/automation/ws1/b1').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'auto-1', updated: true, name: 'Portal - Generate Invoice' }]);

    expect(calls.puts).toHaveLength(1);
    expect(calls.puts[0].workspaceId).toBe('ws1');
    expect(calls.puts[0].automationId).toBe('auto-1');
    expect(calls.puts[0].body).toEqual({
      name: 'Portal - Generate Invoice',
      active: true,
      board_id: 'b1',
      workflow: [
        {
          type: 'webhook',
          config: {
            url: 'https://portal.example.test/api/pdf/ws1/b1/invoice',
            method: 'POST',
          },
        },
      ],
    });
  });

  it('leaves automations whose name lacks the "Portal - " prefix untouched', async () => {
    const { agent } = await authenticatedAgent(app);
    const calls = stubAutomationApi({ list: [foreignAutomation()] });

    const res = await agent.put('/api/automation/ws1/b1').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(calls.puts).toEqual([]);
  });

  it('returns 404 when ISO+ cannot supply the automation list', async () => {
    const { agent } = await authenticatedAgent(app);
    stubAutomationApi({ list: null });

    const res = await agent.put('/api/automation/ws1/b1').send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Automation not found' });
  });

  it('returns 200 with an empty array when the upstream update fails', async () => {
    // updateAutomation() returns null on any axios error, and the route logs a
    // warning and keeps going rather than surfacing a failure to the caller.
    const { agent } = await authenticatedAgent(app);
    const calls = stubAutomationApi({ list: [portalAutomation()], updateStatus: 500 });

    const res = await agent.put('/api/automation/ws1/b1').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(calls.puts).toHaveLength(1);
  });

  it('returns 200 with an empty array when ISO+ no longer lists the automation being updated', async () => {
    // updateAutomation re-reads the list and refuses to PUT an id it cannot find.
    const { agent } = await authenticatedAgent(app);
    let firstRead = true;
    const calls = { puts: [] };

    server.use(
      http.get(`${AUTOMATION_HOST}/api/:workspaceId/automations/:automationId`, () => {
        if (firstRead) {
          firstRead = false;
          return HttpResponse.json([portalAutomation()]);
        }
        return HttpResponse.json([foreignAutomation()]);
      }),
      http.put(`${AUTOMATION_HOST}/api/:workspaceId/automations/:automationId`, ({ params }) => {
        calls.puts.push(params.automationId);
        return HttpResponse.json({ id: params.automationId });
      })
    );

    const res = await agent.put('/api/automation/ws1/b1').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(calls.puts).toEqual([]);
  });

  it('answers 500 when an automation entry has no name', async () => {
    // shouldUpdatePortalAutomation calls automationItem.name.startsWith(...)
    // with no guard, so a nameless entry throws through to the route's catch.
    const { agent } = await authenticatedAgent(app);
    stubAutomationApi({ list: [{ id: 'auto-3', active: true, board_id: 'b1', workflow: [] }] });

    const res = await agent.put('/api/automation/ws1/b1').send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to update automations' });
  });

  it('answers 500 when the workspaceId is not a safe path segment', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent.put('/api/automation/ws%2F1/b1').send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to update automations' });
  });

  it('allows an owner through the role gate', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    stubAutomationApi({ list: [foreignAutomation()] });

    const res = await agent.put('/api/automation/ws1/b1').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('rewrites nothing when the workflow entry carries no config.url', async () => {
    const { agent } = await authenticatedAgent(app);
    const calls = stubAutomationApi({
      list: [portalAutomation({ workflow: [{ type: 'notify', config: { channel: 'email' } }] })],
    });

    const res = await agent.put('/api/automation/ws1/b1').send({});

    expect(res.status).toBe(200);
    expect(calls.puts[0].body.workflow).toEqual([{ type: 'notify', config: { channel: 'email' } }]);
  });
});
