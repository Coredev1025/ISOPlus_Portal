import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const app = createApp();

describe('GET /api/healthcheck', () => {
  it('returns 200 with status OK', async () => {
    const res = await request(app).get('/api/healthcheck');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'OK' });
  });
});
