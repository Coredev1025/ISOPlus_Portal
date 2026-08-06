import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { authenticatedAgent } from '../helpers/auth.js';

const app = createApp();

describe('Workspace routes', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.PERSONAL_ACCESS_TOKEN = 'test-pat';
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/workspaces');
    expect(res.status).toBe(401);
  });

  it('returns 400 when boards endpoint lacks workspaceId', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/workspaces/boards');
    expect(res.status).toBe(400);
  });
});

describe('Workspace feature-toggles routes', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.PERSONAL_ACCESS_TOKEN = 'test-pat';
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/workspaces/ws-1/feature-toggles');
    expect(res.status).toBe(401);
  });

  it('rejects isoplus_user with 403', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'isoplus_user' });
    // Login JWT hardcodes support_admin; refresh from DB role via verify.
    await agent.get('/api/auth/verify');
    const res = await agent.get('/api/workspaces/ws-1/feature-toggles');
    expect(res.status).toBe(403);
  });

  it('returns false by default for support_admin when business is missing', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
    const res = await agent.get('/api/workspaces/ws-missing/feature-toggles');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ invoiceStatementAutomation: false });
  });

  it('rejects invalid workspaceId', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const res = await agent.get('/api/workspaces/ws.bad/feature-toggles');
    expect(res.status).toBe(400);
  });

  it('rejects non-boolean PUT body', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const res = await agent
      .put('/api/workspaces/ws-put-1/feature-toggles')
      .send({ invoiceStatementAutomation: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/boolean/i);
  });

  it('persists flag via PUT and returns it on GET for owner', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const putRes = await agent
      .put('/api/workspaces/ws-put-2/feature-toggles')
      .send({ invoiceStatementAutomation: true });
    expect(putRes.status).toBe(200);
    expect(putRes.body).toEqual({ invoiceStatementAutomation: true });

    const getRes = await agent.get('/api/workspaces/ws-put-2/feature-toggles');
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({ invoiceStatementAutomation: true });
  });
});

