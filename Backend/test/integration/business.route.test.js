import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../../src/app.js';
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
});
