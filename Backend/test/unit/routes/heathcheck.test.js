import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app.js';

/**
 * The healthcheck is what Elastic Beanstalk polls to decide whether an instance
 * is in service, so its contract is narrow and load-bearing: 200 with exactly
 * {"status":"OK"}, reachable without a session.
 */

const app = createApp();

describe('GET /api/healthcheck', () => {
  it('returns 200 with the status payload the deployment probe expects', async () => {
    const res = await request(app).get('/api/healthcheck');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'OK' });
  });

  it('answers without authentication', async () => {
    const res = await request(app).get('/api/healthcheck');

    expect(res.status).not.toBe(401);
  });

  it('responds as JSON', async () => {
    const res = await request(app).get('/api/healthcheck');

    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('does not advertise Express on the healthcheck response', async () => {
    const res = await request(app).get('/api/healthcheck');

    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('answers a HEAD request with 200 and no body', async () => {
    const res = await request(app).head('/api/healthcheck');

    expect(res.status).toBe(200);
    expect(res.text).toBeUndefined();
  });

  it('404s any sub-path, so only the root is a health signal', async () => {
    const res = await request(app).get('/api/healthcheck/deep');

    expect(res.status).toBe(404);
  });

  it('rejects a POST, since the probe only ever GETs', async () => {
    const res = await request(app).post('/api/healthcheck').send({});

    expect(res.status).toBe(404);
  });

  it('stays 200 across repeated polls', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).get('/api/healthcheck');
      expect(res.status).toBe(200);
    }
  });

  it('is excluded from audit logging, so polling does not fill the audit trail', async () => {
    const { default: AuditTrail } = await import('../../../src/models/AuditTrail.js');
    await AuditTrail.deleteMany({});

    await request(app).get('/api/healthcheck');
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await AuditTrail.countDocuments({})).toBe(0);
  });
});
