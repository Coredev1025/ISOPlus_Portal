import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';

import { createApp } from '../../src/app.js';
import AutomationRun from '../../src/models/AutomationRun.js';
import AutomationSettings from '../../src/models/AutomationSettings.js';
import Business from '../../src/models/Business.js';
import SchedulerHealth from '../../src/models/SchedulerHealth.js';
import { authenticatedAgent } from '../helpers/auth.js';
import { RUN_FAILED, RUN_SUCCEEDED, HISTORY_PAGE_SIZE } from '../../src/constants/systemHealth.js';

const WS = 'ws-health-1';

describe('GET /api/system-health/overview', () => {
  let app;

  beforeEach(async () => {
    await AutomationRun.deleteMany({});
    await AutomationSettings.deleteMany({});
    await Business.deleteMany({});
    await SchedulerHealth.deleteMany({});
    app = createApp();
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/system-health/overview');
    expect(res.status).toBe(401);
  });

  it('refuses an isoplus_user, who must not see every client', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'isoplus_user' });
    // POST /api/auth/login hardcodes role: 'support_admin' into the JWT
    // regardless of the stored user's role (src/routes/auth.js); /verify
    // re-signs it from the DB. Same workaround as
    // workspace.route.test.js and business.xero-mapping.route.test.js.
    await agent.get('/api/auth/verify');
    const res = await agent.get('/api/system-health/overview');
    expect(res.status).toBe(403);
  });

  for (const role of ['support_admin', 'owner']) {
    it(`admits ${role}`, async () => {
      const { agent } = await authenticatedAgent(app, { role });
      const res = await agent.get('/api/system-health/overview');
      expect(res.status).toBe(200);
    });
  }

  it('returns a whole overview for an empty system without dividing by zero', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/overview');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      activeAutomations: 0,
      runsToday: 0,
      failed: 0,
      errorRate24h: 0,
    });
    expect(res.body.queue).toMatchObject({ total: 0, backlogged: false });
    expect(Array.isArray(res.body.trend)).toBe(true);
  });

  it('counts a workspace with either block enabled exactly once', async () => {
    await AutomationSettings.create({
      workspaceId: WS,
      invoice: { enabled: true },
      statement: { enabled: true },
    });
    const { agent } = await authenticatedAgent(app);

    const res = await agent.get('/api/system-health/overview');
    expect(res.body.activeAutomations).toBe(1);
  });

  it('reports a null last tick when the scheduler has never run', async () => {
    // The failure every other figure hides: with no ticks, runsToday is
    // legitimately 0 and the error rate is legitimately 0, and the overview
    // looks healthy while nothing is firing at all.
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/overview');

    expect(res.body).toHaveProperty('lastTickAt', null);
  });

  it('reports the last tick once the scheduler has run', async () => {
    const lastTickAt = new Date('2026-08-13T09:00:00.000Z');
    await SchedulerHealth.create({ lastTickAt });

    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/overview');

    expect(new Date(res.body.lastTickAt).toISOString()).toBe(lastTickAt.toISOString());
  });

  it('summarises recent runs', async () => {
    const base = {
      workspaceId: WS, boardId: 'b1', kind: 'invoice_automation', periodKey: 'p',
    };
    await AutomationRun.create({ ...base, jobId: 'j1', status: RUN_SUCCEEDED });
    await AutomationRun.create({ ...base, jobId: 'j2', status: RUN_FAILED });

    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/overview');

    expect(res.body.runsToday).toBe(2);
    expect(res.body.failed).toBe(1);
    expect(res.body.errorRate24h).toBe(0.5);
  });
});

describe('GET /api/system-health/clients', () => {
  let app;

  beforeEach(async () => {
    await AutomationSettings.deleteMany({});
    await Business.deleteMany({});
    app = createApp();
  });

  it('refuses an isoplus_user', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'isoplus_user' });
    // See the /verify note on the overview suite's equivalent test.
    await agent.get('/api/auth/verify');
    expect((await agent.get('/api/system-health/clients')).status).toBe(403);
  });

  it('lists each configured workspace with its connection status', async () => {
    await AutomationSettings.create({ workspaceId: WS, invoice: { enabled: true } });
    await Business.create({ workspaceId: WS, xeroIntegrated: true });

    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/clients');

    expect(res.status).toBe(200);
    expect(res.body.clients).toHaveLength(1);
    expect(res.body.clients[0]).toMatchObject({
      workspaceId: WS,
      connection: 'connected',
      provider: 'xero',
    });
  });

  it('reports disconnected for a configured workspace with no Business row', async () => {
    await AutomationSettings.create({ workspaceId: 'ws-no-business', invoice: { enabled: true } });

    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/clients');

    expect(res.body.clients[0].connection).toBe('disconnected');
  });
});

describe('GET /api/system-health/workspace/:workspaceId', () => {
  let app;

  beforeEach(async () => {
    await AutomationRun.deleteMany({});
    app = createApp();
  });

  async function seedRuns(count) {
    for (let i = 0; i < count; i += 1) {
      await AutomationRun.create({
        workspaceId: WS,
        boardId: `b${i}`,
        kind: 'invoice_automation',
        periodKey: `p${i}`,
        jobId: `j${i}`,
        status: RUN_SUCCEEDED,
        startedAt: new Date(Date.UTC(2026, 7, 1, 0, i)),
      });
    }
  }

  it('refuses an isoplus_user', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'isoplus_user' });
    // See the /verify note on the overview suite's equivalent test.
    await agent.get('/api/auth/verify');
    expect((await agent.get(`/api/system-health/workspace/${WS}`)).status).toBe(403);
  });

  it('returns newest runs first with a total', async () => {
    await seedRuns(3);
    const { agent } = await authenticatedAgent(app);

    const res = await agent.get(`/api/system-health/workspace/${WS}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.runs.map((r) => r.boardId)).toEqual(['b2', 'b1', 'b0']);
  });

  it('pages rather than truncating, so the history stays uncapped', async () => {
    await seedRuns(HISTORY_PAGE_SIZE + 5);
    const { agent } = await authenticatedAgent(app);

    const first = await agent.get(`/api/system-health/workspace/${WS}`);
    const second = await agent.get(`/api/system-health/workspace/${WS}?page=2`);

    expect(first.body.runs).toHaveLength(HISTORY_PAGE_SIZE);
    expect(second.body.runs).toHaveLength(5);
    expect(first.body.total).toBe(HISTORY_PAGE_SIZE + 5);
    // No overlap between pages.
    const ids = new Set(first.body.runs.map((r) => r.jobId));
    expect(second.body.runs.every((r) => !ids.has(r.jobId))).toBe(true);
  });

  it('does not leak another workspace\'s runs', async () => {
    await seedRuns(2);
    await AutomationRun.create({
      workspaceId: 'someone-else', boardId: 'x', kind: 'invoice_automation',
      periodKey: 'p', jobId: 'other', status: RUN_SUCCEEDED,
    });

    const { agent } = await authenticatedAgent(app);
    const res = await agent.get(`/api/system-health/workspace/${WS}`);

    expect(res.body.total).toBe(2);
  });

  it('returns an empty history rather than 404 for an unknown workspace', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/workspace/never-configured');

    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('rejects a non-numeric page instead of returning NaN results', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get(`/api/system-health/workspace/${WS}?page=abc`);
    expect(res.status).toBe(400);
  });
});
