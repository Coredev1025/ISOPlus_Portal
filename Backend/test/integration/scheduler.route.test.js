import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import ScheduledJob from '../../src/models/ScheduledJob.js';
import { register, clearRegistry } from '../../src/services/scheduler/registry.js';
import { AT_MOST_ONCE } from '../../src/constants/scheduler.js';
import { KIND_INVOICE, KIND_STATEMENT } from '../../src/constants/automation.js';

const app = createApp();

describe('POST /api/scheduler/tick', () => {
  const originalSchedulerApiKey = process.env.SCHEDULER_API_KEY;
  const originalAdminApiKey = process.env.Admin_API_Key;

  beforeEach(() => {
    clearRegistry();
    process.env.SCHEDULER_API_KEY = 'test-scheduler-key';
    delete process.env.SCHEDULER_API_KEY_INVOICE;
    delete process.env.SCHEDULER_API_KEY_STATEMENT;
  });

  afterEach(() => {
    if (originalSchedulerApiKey === undefined) {
      delete process.env.SCHEDULER_API_KEY;
    } else {
      process.env.SCHEDULER_API_KEY = originalSchedulerApiKey;
    }
    if (originalAdminApiKey === undefined) {
      delete process.env.Admin_API_Key;
    } else {
      process.env.Admin_API_Key = originalAdminApiKey;
    }
    delete process.env.SCHEDULER_API_KEY_INVOICE;
    delete process.env.SCHEDULER_API_KEY_STATEMENT;
  });

  /** One due automation job of `kind`, the way upsertSchedule writes them. */
  async function dueAutomationJob(kind) {
    return ScheduledJob.create({
      kind,
      targetId: `ws-${kind}`,
      cron: '*/30 * * * *',
      timezone: 'Australia/Sydney',
      nextRunAt: new Date(Date.now() - 60_000),
    });
  }

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
      .set('Authorization', 'Bearer test-scheduler-key');
    expect(res.status).toBe(401);
  });

  it('rejects a correct Admin_API_Key that is not the scheduler key, proving the two secrets are separate', async () => {
    process.env.Admin_API_Key = 'test-admin-key';
    const res = await request(app)
      .post('/api/scheduler/tick')
      .set('Authorization', 'test-admin-key');
    expect(res.status).toBe(401);
  });

  it('a per-kind key ticks only its kind, leaving the other still due', async () => {
    // One EventBridge rule per kind, each holding its own credential: the
    // presented key IS the scope, so the invoice rule cannot fire statements.
    process.env.SCHEDULER_API_KEY_INVOICE = 'test-invoice-key';
    const handler = vi.fn().mockResolvedValue(undefined);
    register(KIND_INVOICE, { handler, policy: AT_MOST_ONCE });
    register(KIND_STATEMENT, { handler, policy: AT_MOST_ONCE });
    await dueAutomationJob(KIND_INVOICE);
    await dueAutomationJob(KIND_STATEMENT);

    const res = await request(app)
      .post('/api/scheduler/tick')
      .set('Authorization', 'test-invoice-key');
    expect(res.status).toBe(200);
    expect(res.body.claimed).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ kind: KIND_INVOICE }),
    );

    // The statement job is untouched; the master key still claims it.
    const master = await request(app)
      .post('/api/scheduler/tick')
      .set('Authorization', 'test-scheduler-key');
    expect(master.body.claimed).toBe(1);
  });

  it('the statement key mirrors the invoice key for its own kind', async () => {
    process.env.SCHEDULER_API_KEY_STATEMENT = 'test-statement-key';
    const handler = vi.fn().mockResolvedValue(undefined);
    register(KIND_INVOICE, { handler, policy: AT_MOST_ONCE });
    register(KIND_STATEMENT, { handler, policy: AT_MOST_ONCE });
    await dueAutomationJob(KIND_INVOICE);
    await dueAutomationJob(KIND_STATEMENT);

    const res = await request(app)
      .post('/api/scheduler/tick')
      .set('Authorization', 'test-statement-key');
    expect(res.body.claimed).toBe(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ kind: KIND_STATEMENT }),
    );
  });

  it('a per-kind key whose env var is unset cannot authorize', async () => {
    // SCHEDULER_API_KEY_INVOICE deliberately not set.
    const res = await request(app)
      .post('/api/scheduler/tick')
      .set('Authorization', 'test-invoice-key');
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
      .set('Authorization', 'test-scheduler-key');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ claimed: 1, dispatched: 1, failed: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not let one un-parseable cron take the whole tick down with it', async () => {
    // Bypass the model entirely, the same way a row written directly against
    // the collection (as docs/scheduling.md tells support they may do) would
    // reach production with no validator to stop it.
    await ScheduledJob.collection.insertOne({
      kind: 'demo',
      targetId: 'bad-cron-target',
      cron: 'not-a-cron',
      timezone: 'Australia/Sydney',
      enabled: true,
      nextRunAt: new Date('2000-01-01T00:00:00Z'),
      missedRuns: 0,
      consecutiveFailures: 0,
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    register('demo', { handler, policy: AT_MOST_ONCE });
    await ScheduledJob.create({
      kind: 'demo',
      targetId: 'good-target',
      cron: '*/30 * * * *',
      timezone: 'Australia/Sydney',
      nextRunAt: new Date('2000-01-01T00:00:01Z'),
    });

    const res = await request(app)
      .post('/api/scheduler/tick')
      .set('Authorization', 'test-scheduler-key');

    expect(res.status).toBe(200);
    expect(res.body.dispatched).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);

    const bad = await ScheduledJob.findOne({ targetId: 'bad-cron-target' });
    expect(bad.lastError).toBeTruthy();
  });

  it('returns a zero summary when nothing is due', async () => {
    const res = await request(app)
      .post('/api/scheduler/tick')
      .set('Authorization', 'test-scheduler-key');

    expect(res.status).toBe(200);
    expect(res.body.claimed).toBe(0);
  });
});
