import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import AuditTrail from '../../src/models/AuditTrail.js';
import { authenticatedAgent } from '../helpers/auth.js';

const app = createApp();

describe('Audit trail routes', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.PERSONAL_ACCESS_TOKEN = 'test-pat';
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/audit').query({ workspaceId: 'ws' });
    expect(res.status).toBe(401);
  });

  it('lists and creates audit trails', async () => {
    await AuditTrail.create({ workspaceId: 'ws-a', action: 'A', detail: 'd' });
    const { agent } = await authenticatedAgent(app);
    const list = await agent.get('/api/audit').query({ workspaceId: 'ws-a' });
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(1);

    const created = await agent.post('/api/audit').send({
      workspaceId: 'ws-a',
      action: 'Manual',
      detail: 'note',
    });
    expect(created.status).toBe(201);
    expect(created.body.action).toBe('Manual');
  });
});
