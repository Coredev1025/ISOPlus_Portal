import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { authenticatedAgent } from '../helpers/auth.js';
import Business from '../../src/models/Business.js';

vi.mock('../../src/utils/workspaceFeatureToggleHelpers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findBusinessByWorkspaceId: vi.fn(actual.findBusinessByWorkspaceId),
    upsertInvoiceStatementAutomation: vi.fn(actual.upsertInvoiceStatementAutomation),
  };
});

import {
  findBusinessByWorkspaceId,
  upsertInvoiceStatementAutomation,
} from '../../src/utils/workspaceFeatureToggleHelpers.js';

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
    vi.clearAllMocks();
    findBusinessByWorkspaceId.mockImplementation(async (workspaceId) =>
      Business.findOne({ workspaceId: { $eq: String(workspaceId) } })
    );
    upsertInvoiceStatementAutomation.mockImplementation(
      async (workspaceId, enabled) =>
        Business.findOneAndUpdate(
          { workspaceId: { $eq: String(workspaceId) } },
          { $set: { 'featureToggles.invoiceStatementAutomation': enabled } },
          { new: true }
        )
    );
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

  it('returns 404 on PUT when business profile is missing', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const putRes = await agent
      .put('/api/workspaces/ws-no-biz/feature-toggles')
      .send({ invoiceStatementAutomation: true });
    expect(putRes.status).toBe(404);
    expect(putRes.body.message).toMatch(/business/i);
  });

  it('persists flag via PUT and returns it on GET for owner', async () => {
    await Business.create({ name: 'Owner Biz', workspaceId: 'ws-put-2' });
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

  it('returns 500 when GET feature-toggles helper throws', async () => {
    findBusinessByWorkspaceId.mockRejectedValueOnce(new Error('db down'));
    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const res = await agent.get('/api/workspaces/ws-get-500/feature-toggles');
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Failed to fetch feature toggles');
  });

  it('returns 500 when PUT feature-toggles helper throws', async () => {
    await Business.create({ name: 'Boom Biz', workspaceId: 'ws-put-500' });
    upsertInvoiceStatementAutomation.mockRejectedValueOnce(
      new Error('write failed')
    );
    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const res = await agent
      .put('/api/workspaces/ws-put-500/feature-toggles')
      .send({ invoiceStatementAutomation: true });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Failed to update feature toggles');
  });
});
