import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { authenticatedAgent } from '../helpers/auth.js';

const app = createApp();

describe('Log routes', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.PERSONAL_ACCESS_TOKEN = 'test-pat';
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/log');
    expect(res.status).toBe(401);
  });

  it('allows support_admin to list logs', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
    const res = await agent.get('/api/log');
    expect(res.status).toBe(200);
  });
});
