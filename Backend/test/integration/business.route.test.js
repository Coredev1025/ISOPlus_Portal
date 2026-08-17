import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../../src/app.js';
import AuditTrail from '../../src/models/AuditTrail.js';
import Business from '../../src/models/Business.js';
import { authenticatedAgent } from '../helpers/auth.js';

const app = createApp();

describe('Business routes', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.PERSONAL_ACCESS_TOKEN = 'test-pat';
  });
  afterEach(() => {});

  it('requires authentication for profile', async () => {
    const request = (await import('supertest')).default;
    const res = await request(app).get('/api/business/profile').query({ workspaceId: 'ws' });
    expect(res.status).toBe(401);
  });

  it('returns 404 when profile is missing', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/business/profile').query({ workspaceId: 'missing' });
    expect(res.status).toBe(404);
  });

  it('returns profile when business exists', async () => {
    await Business.create({ workspaceId: 'ws-biz', name: 'Biz Co' });
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/business/profile').query({ workspaceId: 'ws-biz' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Biz Co');
  });

  it('omits leftover xeroConnectionLogs from the profile response', async () => {
    await Business.collection.insertOne({
      workspaceId: 'ws-logs',
      name: 'Biz Co',
      xeroConnectionLogs: [{ message: 'Connected', outcome: 'success' }],
    });
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/business/profile').query({ workspaceId: 'ws-logs' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Biz Co');
    expect(res.body.xeroConnectionLogs).toBeUndefined();
  });

  it('records a xero-category audit trail when connecting Xero', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.post('/api/business/xero/connect').send({
      workspaceId: 'ws-connect',
      tenantId: 'tenant-1',
      tokens: {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_at: Date.now() + 60_000,
      },
    });
    expect(res.status).toBe(200);

    const trails = await AuditTrail.find({ workspaceId: 'ws-connect' }).lean();
    expect(trails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'Connected Xero',
          category: 'xero',
          success: true,
        }),
      ])
    );
  });
});
