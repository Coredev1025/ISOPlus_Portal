import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const app = createApp();

describe('PDF webhook routes', () => {
  it('rejects invoice generation without required payload', async () => {
    const res = await request(app).post('/api/pdf/ws1/b1/invoice').send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
