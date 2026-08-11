import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import ScheduledJob from '../../src/models/ScheduledJob.js';
import {
  register,
  clearRegistry,
  AT_MOST_ONCE,
} from '../../src/services/scheduler/registry.js';

const app = createApp();

describe('POST /api/scheduler/tick', () => {
  const originalAdminApiKey = process.env.Admin_API_Key;

  beforeEach(() => {
    clearRegistry();
    process.env.Admin_API_Key = 'test-admin-key';
  });

  afterEach(() => {
    if (originalAdminApiKey === undefined) {
      delete process.env.Admin_API_Key;
    } else {
      process.env.Admin_API_Key = originalAdminApiKey;
    }
  });

  it('rejects a request with no credential', async () => {
    const res = await request(app).post('/api/scheduler/tick');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong credential', async () => {
    const res = await request(app)
      .post('/api/scheduler/tick')
      .set('Authorization', 'wrong-key');
    expect(res.status).toBe(401);
  });

  it('rejects the key with a Bearer prefix, which is the likely misconfiguration', async () => {
    const res = await request(app)
      .post('/api/scheduler/tick')
      .set('Authorization', 'Bearer test-admin-key');
    expect(res.status).toBe(401);
  });

  it('dispatches due schedules and returns a summary', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    register('demo', { handler, policy: AT_MOST_ONCE });
    await ScheduledJob.create({
      kind: 'demo',
      targetId: 'target-1',
      cron: '*/30 * * * *',
      timezone: 'Australia/Sydney',
      nextRunAt: new Date('2000-01-01T00:00:00Z'),
    });

    const res = await request(app)
      .post('/api/scheduler/tick')
      .set('Authorization', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ claimed: 1, dispatched: 1, failed: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('returns a zero summary when nothing is due', async () => {
    const res = await request(app)
      .post('/api/scheduler/tick')
      .set('Authorization', 'test-admin-key');

    expect(res.status).toBe(200);
    expect(res.body.claimed).toBe(0);
  });
});
