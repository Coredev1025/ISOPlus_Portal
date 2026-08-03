import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const app = createApp();

describe('PDF webhook routes', () => {
  it('returns 200 with error message when invoice payload is invalid', async () => {
    const res = await request(app).post('/api/pdf/ws1/b1/invoice').send({});
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/No items found in the payload/i);
  });
});
