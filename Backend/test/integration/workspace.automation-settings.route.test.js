import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import AutomationSettings from '../../src/models/AutomationSettings.js';
import { authenticatedAgent } from '../helpers/auth.js';

const WS = 'ws-automation-1';

describe('GET/PUT /api/workspaces/:workspaceId/automation-settings', () => {
  let app;
  let agent;

  beforeEach(async () => {
    await AutomationSettings.deleteMany({});
    app = createApp();
    ({ agent } = await authenticatedAgent(app));
  });

  it('returns defaults when no document exists', async () => {
    const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.status).toBe(200);
    expect(res.body.invoice.enabled).toBe(false);
    expect(res.body.invoice.nextRun).toBeNull();
  });

  it('persists a valid block', async () => {
    const res = await agent.put(`/api/workspaces/${WS}/automation-settings`).send({
      invoice: {
        enabled: true,
        every: { n: 1, unit: 'month' },
        runOn: 15,
        runAt: '09:00',
        sendMethod: 'isoplus',
        recipient: 'billing_contact',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.invoice.runOn).toBe(15);

    const stored = await AutomationSettings.findOne({ workspaceId: WS });
    expect(stored.invoice.enabled).toBe(true);
  });

  it('rejects a bad email with 400 and names the field', async () => {
    const res = await agent.put(`/api/workspaces/${WS}/automation-settings`).send({
      invoice: {
        enabled: true,
        every: { n: 1, unit: 'month' },
        runOn: 1,
        runAt: '09:00',
        sendMethod: 'isoplus',
        recipient: 'billing_contact',
        sendCopyTo: 'nope',
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/sendCopyTo/);
  });

  it('requires authentication', async () => {
    const res = await request(app).get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.status).toBe(401);
  });
});
