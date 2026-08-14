import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';

import { createApp } from '../../src/app.js';
import AutomationRun from '../../src/models/AutomationRun.js';
import AutomationSettings from '../../src/models/AutomationSettings.js';
import { authenticatedAgent } from '../helpers/auth.js';
import { CLIENT_PANEL_RUN_LIMIT, RUN_SKIPPED } from '../../src/constants/systemHealth.js';

const WS = 'ws-status-1';

describe('GET /api/automation/:workspaceId/status', () => {
  let app;
  let agent;

  beforeEach(async () => {
    await AutomationRun.deleteMany({});
    await AutomationSettings.deleteMany({});
    app = createApp();
    ({ agent } = await authenticatedAgent(app));
  });

  it('requires authentication', async () => {
    expect((await request(app).get(`/api/automation/${WS}/status`)).status).toBe(401);
  });

  it('reports delivery as not yet enabled, so the panel can say so', async () => {
    const res = await agent.get(`/api/automation/${WS}/status`);
    expect(res.status).toBe(200);
    expect(res.body.deliveryEnabled).toBe(false);
  });

  it('returns an empty but valid shape for a workspace with no settings', async () => {
    const res = await agent.get(`/api/automation/${WS}/status`);

    expect(res.body.invoice).toMatchObject({ enabled: false, nextRun: null });
    expect(res.body.runs).toEqual([]);
  });

  it(`caps the history at ${CLIENT_PANEL_RUN_LIMIT} runs, newest first`, async () => {
    for (let i = 0; i < CLIENT_PANEL_RUN_LIMIT + 4; i += 1) {
      await AutomationRun.create({
        workspaceId: WS, boardId: `b${i}`, kind: 'invoice_automation',
        periodKey: `p${i}`, jobId: `j${i}`, status: RUN_SKIPPED,
        startedAt: new Date(Date.UTC(2026, 7, 1, 0, i)),
      });
    }

    const res = await agent.get(`/api/automation/${WS}/status`);

    expect(res.body.runs).toHaveLength(CLIENT_PANEL_RUN_LIMIT);
    expect(res.body.runs[0].boardId).toBe(`b${CLIENT_PANEL_RUN_LIMIT + 3}`);
  });

  it('does not return another workspace\'s runs', async () => {
    await AutomationRun.create({
      workspaceId: 'other', boardId: 'x', kind: 'invoice_automation',
      periodKey: 'p', jobId: 'other', status: RUN_SKIPPED,
    });

    const res = await agent.get(`/api/automation/${WS}/status`);
    expect(res.body.runs).toEqual([]);
  });
});
