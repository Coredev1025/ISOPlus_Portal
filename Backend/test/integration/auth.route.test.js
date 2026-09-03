import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import User from '../../src/models/User.js';

const app = createApp();

describe('Auth routes', () => {
  const originalAdminKey = process.env.Admin_API_Key;
  const originalJwtSecret = process.env.JWT_SECRET;
  beforeEach(() => {
    process.env.Admin_API_Key = 'test-admin-key';
    process.env.JWT_SECRET = 'test-jwt-secret';
  });
  afterEach(() => {
    process.env.Admin_API_Key = originalAdminKey;
    process.env.JWT_SECRET = originalJwtSecret;
  });

  describe('POST /api/auth/register', () => {
    it('returns 401 when Admin API key is missing', async () => {
      const res = await request(app).post('/api/auth/register').send({
        email: 'newuser@isoplus.com',
        password: 'Sup3r-Pass',
        name: 'New User',
      });
      expect(res.status).toBe(401);
    });

    it('returns 400 for invalid email', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('Authorization', 'test-admin-key')
        .send({ email: 'not-an-email', password: 'Sup3r-Pass', name: 'Bad Email' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for short password', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('Authorization', 'test-admin-key')
        .send({ email: 'x@iso.com', password: '1', name: 'Short Pass' });
      expect(res.status).toBe(400);
    });

    it('registers a new user (201)', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .set('Authorization', 'test-admin-key')
        .send({ email: 'auth-new@isoplus.com', password: 'GoodPass!1', name: 'Auth New' });
      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe('auth-new@isoplus.com');
    });

    it('returns 400 when user already exists', async () => {
      await User.create({ email: 'dup@isoplus.com', password: 'GoodPass!1', name: 'Dup' });
      const res = await request(app)
        .post('/api/auth/register')
        .set('Authorization', 'test-admin-key')
        .send({ email: 'dup@isoplus.com', password: 'GoodPass!1', name: 'Dup' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/exists/i);
    });
  });

  describe('POST /api/auth/login', () => {
    it('returns 404 because password login was removed', async () => {
      await User.create({ email: 'good@isoplus.com', password: 'GoodPass!1', name: 'Good' });
      const res = await request(app).post('/api/auth/login').send({
        email: 'good@isoplus.com',
        password: 'GoodPass!1',
      });
      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/Google sign-in/i);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('returns success after establishing a session', async () => {
      const user = await User.create({ email: 'out@isoplus.com', password: 'GoodPass!1', name: 'Out' });
      const agent = request.agent(app);
      await agent.post('/api/__test/session').send({
        userId: user._id.toString(),
        email: user.email,
        name: user.name,
        role: user.role,
      });
      const res = await agent.post('/api/auth/logout');
      expect([200, 204]).toContain(res.status);
    });

    it('destroys the session so a later verify is unauthenticated', async () => {
      const user = await User.create({
        email: 'logout-verify@isoplus.com',
        password: 'GoodPass!1',
        name: 'Out',
        role: 'support_admin',
      });
      const agent = request.agent(app);
      await agent.post('/api/__test/session').send({
        userId: user._id.toString(),
        email: user.email,
        name: user.name,
        role: 'support_admin',
      });
      expect((await agent.get('/api/auth/verify')).body.authenticated).toBe(true);

      const logout = await agent.post('/api/auth/logout');
      expect(logout.status).toBe(200);

      const verify = await agent.get('/api/auth/verify');
      expect(verify.status).toBe(200);
      expect(verify.body.authenticated).toBe(false);
    });
  });
});
