import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import AutomationSettings from '../../src/models/AutomationSettings.js';
import ScheduledJob from '../../src/models/ScheduledJob.js';
import { KIND_INVOICE, KIND_STATEMENT } from '../../src/constants/automation.js';
import { authenticatedAgent } from '../helpers/auth.js';

const WS = 'ws-automation-1';

// The workspace has no Business, so resolveTimezone falls back to
// DEFAULT_TIMEZONE. Pinning it here lets the assertions below check the
// wall-clock fields of nextRunAt rather than settling for "is truthy".
const TZ = 'Australia/Sydney';

/** Wall-clock fields of `date` in the job's timezone. */
function wallClock(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    hour12: false,
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
  })
    .formatToParts(date)
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});

  return {
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    weekday: String(parts.weekday).toLowerCase(),
  };
}

const MONTHLY_INVOICE = {
  enabled: true,
  every: { n: 1, unit: 'month' },
  runOn: 15,
  runAt: '09:00',
  sendMethod: 'isoplus',
  recipient: 'billing_contact',
};

// quarter and year are the two units that made this route return 500 on save:
// their runOn is {month, day} — the only shape validateRunOn accepts and the
// only shape the picker sends — and the schedule arithmetic read it as an
// integer, so Number({month, day}) was NaN and Intl threw RangeError: Invalid
// time value out of computeNextRun, before anything was written.
const QUARTERLY_INVOICE = {
  enabled: true,
  every: { n: 1, unit: 'quarter' },
  runOn: { month: 3, day: 20 },
  runAt: '09:00',
  sendMethod: 'isoplus',
  recipient: 'billing_contact',
};

const WEEKLY_STATEMENT = {
  enabled: true,
  every: { n: 2, unit: 'week' },
  runOn: 'friday',
  runAt: '17:30',
  sendMethod: 'isoplus',
  recipient: 'billing_contact',
};

describe('GET/PUT /api/workspaces/:workspaceId/automation-settings', () => {
  let app;
  let agent;

  beforeEach(async () => {
    await AutomationSettings.deleteMany({});
    await ScheduledJob.deleteMany({});
    app = createApp();
    ({ agent } = await authenticatedAgent(app));
  });

  it('returns defaults when no document exists', async () => {
    const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.status).toBe(200);
    expect(res.body.invoice.enabled).toBe(false);
    expect(res.body.invoice.nextRun).toBeNull();
  });

  it('persists a valid block', async () => {
    const res = await agent.put(`/api/workspaces/${WS}/automation-settings`).send({
      invoice: {
        enabled: true,
        every: { n: 1, unit: 'month' },
        runOn: 15,
        runAt: '09:00',
        sendMethod: 'isoplus',
        recipient: 'billing_contact',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.invoice.runOn).toBe(15);

    const stored = await AutomationSettings.findOne({ workspaceId: WS });
    expect(stored.invoice.enabled).toBe(true);
  });

  it('rejects a bad email with 400 and names the field', async () => {
    const res = await agent.put(`/api/workspaces/${WS}/automation-settings`).send({
      invoice: {
        enabled: true,
        every: { n: 1, unit: 'month' },
        runOn: 1,
        runAt: '09:00',
        sendMethod: 'isoplus',
        recipient: 'billing_contact',
        sendCopyTo: 'nope',
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/sendCopyTo/);
  });

  it('requires authentication', async () => {
    const res = await request(app).get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.status).toBe(401);
  });

  it('creates a picker ScheduledJob when a block is enabled', async () => {
    const res = await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE });
    expect(res.status).toBe(200);

    const job = await ScheduledJob.findOne({ kind: KIND_INVOICE, targetId: WS });
    expect(job).not.toBeNull();
    expect(job.enabled).toBe(true);
    expect(job.workspaceId).toBe(WS);
    expect(job.timezone).toBe(TZ);
    // cron null is what makes this a picker schedule; the scheduler's
    // exactly-one check rejects a row carrying both.
    expect(job.cron).toBeNull();
    expect(job.schedule.every.n).toBe(1);
    expect(job.schedule.every.unit).toBe('month');
    expect(job.schedule.runOn).toBe(15);
    expect(job.schedule.runAt).toBe('09:00');
    expect(wallClock(job.nextRunAt)).toMatchObject({ day: '15', hour: '09', minute: '00' });
    expect(job.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('saves a quarterly block, whose runOn is {month, day}, and schedules it in the chosen month', async () => {
    const res = await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: QUARTERLY_INVOICE });

    expect(res.status).toBe(200);
    expect(res.body.invoice.runOn).toEqual({ month: 3, day: 20 });

    const job = await ScheduledJob.findOne({ kind: KIND_INVOICE, targetId: WS });
    expect(job.schedule.runOn).toEqual({ month: 3, day: 20 });

    // No startDate, so the series is anchored on today and the exact instant
    // moves with the calendar. What must hold whatever day this runs on: the
    // 20th, at 09:00, in a month sharing March's position in the quarter —
    // i.e. March, June, September or December. Ignoring runOn.month would
    // anchor on today's month instead, which for nine months of the year is
    // none of those.
    const clock = wallClock(job.nextRunAt);
    expect(clock).toMatchObject({ day: '20', hour: '09', minute: '00' });

    const month = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, month: '2-digit' })
      .format(job.nextRunAt);
    expect(['03', '06', '09', '12']).toContain(month);
    expect(job.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('disables the ScheduledJob rather than deleting it when the block is turned off', async () => {
    await agent.put(`/api/workspaces/${WS}/automation-settings`).send({ invoice: MONTHLY_INVOICE });
    await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: { ...MONTHLY_INVOICE, enabled: false } });

    // Disable, not delete: lastRunAt and missedRuns have to survive a toggle.
    expect(await ScheduledJob.countDocuments({ kind: KIND_INVOICE, targetId: WS })).toBe(1);
    const job = await ScheduledJob.findOne({ kind: KIND_INVOICE, targetId: WS });
    expect(job.enabled).toBe(false);
    expect(job.schedule.every.unit).toBe('month');
  });

  it('disabling a block that was never enabled is a harmless no-op', async () => {
    const res = await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: { enabled: false } });

    expect(res.status).toBe(200);
    expect(res.body.invoice.nextRun).toBeNull();
    expect(await ScheduledJob.countDocuments({})).toBe(0);
  });

  it('returns nextRun from the linked job on GET and on the PUT that created it', async () => {
    const putRes = await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE });

    const job = await ScheduledJob.findOne({ kind: KIND_INVOICE, targetId: WS });
    expect(putRes.body.invoice.nextRun).toBe(job.nextRunAt.toISOString());

    const getRes = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.invoice.nextRun).toBe(job.nextRunAt.toISOString());
    expect(getRes.body.statement.nextRun).toBeNull();
  });

  it('stops reporting nextRun once the block is disabled', async () => {
    await agent.put(`/api/workspaces/${WS}/automation-settings`).send({ invoice: MONTHLY_INVOICE });
    await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: { ...MONTHLY_INVOICE, enabled: false } });

    const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.body.invoice.nextRun).toBeNull();
  });

  it('returns 400 and leaves the settings unwritten when the schedule write fails', async () => {
    const res = await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: { ...MONTHLY_INVOICE, startDate: 'not-a-date' } });

    expect(res.status).toBe(400);
    // Schedules are written first precisely so this holds: a failed schedule
    // write must not leave the UI claiming "enabled" for something that
    // cannot fire.
    expect(await AutomationSettings.countDocuments({})).toBe(0);
    expect(await ScheduledJob.countDocuments({})).toBe(0);
  });

  it('enables both blocks independently', async () => {
    const res = await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE, statement: WEEKLY_STATEMENT });
    expect(res.status).toBe(200);

    const invoiceJob = await ScheduledJob.findOne({ kind: KIND_INVOICE, targetId: WS });
    const statementJob = await ScheduledJob.findOne({ kind: KIND_STATEMENT, targetId: WS });

    expect(invoiceJob.enabled).toBe(true);
    expect(statementJob.enabled).toBe(true);
    expect(statementJob.schedule.every.n).toBe(2);
    expect(statementJob.schedule.every.unit).toBe('week');
    expect(statementJob.schedule.runOn).toBe('friday');
    expect(wallClock(statementJob.nextRunAt)).toMatchObject({
      hour: '17',
      minute: '30',
      weekday: 'friday',
    });
    expect(res.body.invoice.nextRun).toBe(invoiceJob.nextRunAt.toISOString());
    expect(res.body.statement.nextRun).toBe(statementJob.nextRunAt.toISOString());
  });

  it('turning one block off leaves the other running', async () => {
    await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE, statement: WEEKLY_STATEMENT });
    await agent
      .put(`/api/workspaces/${WS}/automation-settings`)
      .send({ invoice: MONTHLY_INVOICE, statement: { ...WEEKLY_STATEMENT, enabled: false } });

    const invoiceJob = await ScheduledJob.findOne({ kind: KIND_INVOICE, targetId: WS });
    const statementJob = await ScheduledJob.findOne({ kind: KIND_STATEMENT, targetId: WS });
    expect(invoiceJob.enabled).toBe(true);
    expect(statementJob.enabled).toBe(false);

    const res = await agent.get(`/api/workspaces/${WS}/automation-settings`);
    expect(res.body.invoice.nextRun).toBe(invoiceJob.nextRunAt.toISOString());
    expect(res.body.statement.nextRun).toBeNull();
  });
});
