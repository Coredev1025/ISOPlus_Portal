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
