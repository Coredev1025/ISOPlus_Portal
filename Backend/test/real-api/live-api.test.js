import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { run, baseUrl, email, password, sessionCookie } from './config.js';

describe.skipIf(!run)('Live API smoke', () => {
  it('requires API_TEST_BASE_URL', () => {
    expect(baseUrl).toBeTruthy();
  });

  it('healthcheck does not return 5xx', async () => {
    const res = await request(baseUrl).get('/api/healthcheck');
    expect(res.status).toBeLessThan(500);
  });

  it('password login was removed in favour of Google support sign-in', async () => {
    if (!email || !password) return;
    const agent = request.agent(baseUrl);
    const res = await agent.post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(404);
  });

  it('accepts session cookie when provided', async () => {
    if (!sessionCookie) return;
    const res = await request(baseUrl)
      .get('/api/auth/verify')
      .set('Cookie', sessionCookie);
    expect(res.status).toBeLessThan(500);
  });
});
