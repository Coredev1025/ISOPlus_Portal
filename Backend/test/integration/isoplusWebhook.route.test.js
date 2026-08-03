import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

const app = createApp();

describe('Isoplus webhook routes', () => {
  it('returns 400 for invalid payload', async () => {
    const res = await request(app).post('/api/webhooks/isoplus').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('accepts a known event shape without crashing', async () => {
    const res = await request(app).post('/api/webhooks/isoplus').send({
      event: 'comment.created',
      payload: { id: 'c1', object: 'comment' },
    });
    expect(res.status).toBeLessThan(500);
  });
});
