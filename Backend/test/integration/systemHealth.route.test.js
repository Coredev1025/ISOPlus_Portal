import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import EmailEvent from '../../src/models/EmailEvent.js';
import EmailSend from '../../src/models/EmailSend.js';

vi.mock('../../src/utils/automationConnectionStatus.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, xeroConnectionStatus: vi.fn(actual.xeroConnectionStatus) };
});

import { createApp } from '../../src/app.js';
import AutomationRun from '../../src/models/AutomationRun.js';
import AutomationSettings from '../../src/models/AutomationSettings.js';
import Business from '../../src/models/Business.js';
import SchedulerHealth from '../../src/models/SchedulerHealth.js';
import Board from '../../src/models/Board.js';
import { authenticatedAgent } from '../helpers/auth.js';
import { RUN_FAILED, RUN_SUCCEEDED, HISTORY_PAGE_SIZE, TRIGGER_MANUAL } from '../../src/constants/systemHealth.js';
import { recordedJobIds, resetRecordedJobs } from '../helpers/queue.js';
import { xeroConnectionStatus } from '../../src/utils/automationConnectionStatus.js';

const WS = 'ws-health-1';

describe('GET /api/system-health/overview', () => {
  let app;

  beforeEach(async () => {
    await AutomationRun.deleteMany({});
    await AutomationSettings.deleteMany({});
    await Business.deleteMany({});
    await SchedulerHealth.deleteMany({});
    app = createApp();
  });

  /**
   * 6.4 names "bounce/complaint count" as one of the overview's six metrics.
   * It shipped as a hardcoded paragraph saying the feature was not built —
   * written when that was true, and left standing after the SES event pipeline
   * landed. EmailEvent rows are on this branch's own head, so the screen was
   * telling operators to stop looking at the one place the answer lives.
   */
  describe('bounce and complaint counts', () => {
    it('counts Bounce and Complaint events inside the window', async () => {
      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
      const recent = new Date(Date.now() - 60 * 60 * 1000);
      await EmailEvent.create([
        { eventType: 'Bounce', sesMessageId: 'm-1', eventAt: recent },
        { eventType: 'Bounce', sesMessageId: 'm-2', eventAt: recent },
        { eventType: 'Complaint', sesMessageId: 'm-3', eventAt: recent },
        // Delivery is not a problem and must not inflate either count.
        { eventType: 'Delivery', sesMessageId: 'm-4', eventAt: recent },
      ]);

      const res = await agent.get('/api/system-health/overview');

      expect(res.status).toBe(200);
      expect(res.body.delivery.bounced).toBe(2);
      expect(res.body.delivery.complained).toBe(3 - 2);
      expect(res.body.delivery.windowHours).toBe(24 * 7);
    });

    it('ignores events older than the window', async () => {
      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
      const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await EmailEvent.create([
        { eventType: 'Bounce', sesMessageId: 'old-1', eventAt: longAgo },
      ]);

      const res = await agent.get('/api/system-health/overview');

      expect(res.body.delivery.bounced).toBe(0);
    });

    it('reports zeroes rather than omitting the figures when nothing bounced', async () => {
      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

      const res = await agent.get('/api/system-health/overview');

      // Present-and-zero is the difference between "nothing bounced" and "this
      // build cannot tell you" — the confusion the placeholder created.
      expect(res.body.delivery).toEqual({ bounced: 0, complained: 0, windowHours: 24 * 7 });
    });
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/system-health/overview');
    expect(res.status).toBe(401);
  });

  it('refuses an isoplus_user, who must not see every client', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'isoplus_user' });
    // POST /api/auth/login hardcodes role: 'support_admin' into the JWT
    // regardless of the stored user's role (src/routes/auth.js); /verify
    // re-signs it from the DB. Same workaround as
    // workspace.route.test.js and business.xero-mapping.route.test.js.
    await agent.get('/api/auth/verify');
    const res = await agent.get('/api/system-health/overview');
    expect(res.status).toBe(403);
  });

  for (const role of ['support_admin', 'owner']) {
    it(`admits ${role}`, async () => {
      const { agent } = await authenticatedAgent(app, { role });
      const res = await agent.get('/api/system-health/overview');
      expect(res.status).toBe(200);
    });
  }

  it('returns a whole overview for an empty system without dividing by zero', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/overview');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      activeAutomations: 0,
      runsToday: 0,
      failed: 0,
      errorRate24h: 0,
    });
    expect(res.body.queue).toMatchObject({ total: 0, backlogged: false });
  });

  it('counts a workspace with either block enabled exactly once', async () => {
    await AutomationSettings.create({
      workspaceId: WS,
      invoice: { enabled: true },
      statement: { enabled: true },
    });
    const { agent } = await authenticatedAgent(app);

    const res = await agent.get('/api/system-health/overview');
    expect(res.body.activeAutomations).toBe(1);
  });

  it('reports a null last tick when the scheduler has never run', async () => {
    // The failure every other figure hides: with no ticks, runsToday is
    // legitimately 0 and the error rate is legitimately 0, and the overview
    // looks healthy while nothing is firing at all.
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/overview');

    expect(res.body).toHaveProperty('lastTickAt', null);
  });

  it('reports the last tick once the scheduler has run', async () => {
    const lastTickAt = new Date('2026-08-13T09:00:00.000Z');
    await SchedulerHealth.create({ lastTickAt });

    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/overview');

    expect(new Date(res.body.lastTickAt).toISOString()).toBe(lastTickAt.toISOString());
  });

  it('summarises recent runs', async () => {
    const base = {
      workspaceId: WS, boardId: 'b1', kind: 'invoice_automation', periodKey: 'p',
    };
    await AutomationRun.create({ ...base, jobId: 'j1', status: RUN_SUCCEEDED });
    await AutomationRun.create({ ...base, jobId: 'j2', status: RUN_FAILED });

    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/overview');

    expect(res.body.runsToday).toBe(2);
    expect(res.body.failed).toBe(1);
    expect(res.body.errorRate24h).toBe(0.5);
  });
});

describe('GET /api/system-health/clients', () => {
  let app;

  beforeEach(async () => {
    await AutomationSettings.deleteMany({});
    await Business.deleteMany({});
    xeroConnectionStatus.mockClear();
    app = createApp();
  });

  it('refuses an isoplus_user', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'isoplus_user' });
    // See the /verify note on the overview suite's equivalent test.
    await agent.get('/api/auth/verify');
    expect((await agent.get('/api/system-health/clients')).status).toBe(403);
  });

  // /overview passes summariseRuns(rows, now) explicitly; this route must too,
  // so xeroConnectionStatus's "pure" docblock is actually true rather than
  // silently depending on Date.now() at call time.
  it('passes an explicit clock to xeroConnectionStatus rather than relying on its default', async () => {
    await AutomationSettings.create({ workspaceId: WS, invoice: { enabled: true } });
    await Business.create({ workspaceId: WS, xeroIntegrated: true });

    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/clients');

    expect(res.status).toBe(200);
    expect(xeroConnectionStatus).toHaveBeenCalledTimes(1);
    const [, now] = xeroConnectionStatus.mock.calls[0];
    expect(now).toBeInstanceOf(Date);
  });

  it('lists each configured workspace with its connection status', async () => {
    await AutomationSettings.create({ workspaceId: WS, invoice: { enabled: true } });
    await Business.create({ workspaceId: WS, xeroIntegrated: true });

    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/clients');

    expect(res.status).toBe(200);
    expect(res.body.clients).toHaveLength(1);
    expect(res.body.clients[0]).toMatchObject({
      workspaceId: WS,
      connection: 'connected',
      provider: 'xero',
    });
  });

  it('reports disconnected for a configured workspace with no Business row', async () => {
    await AutomationSettings.create({ workspaceId: 'ws-no-business', invoice: { enabled: true } });

    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/clients');

    expect(res.body.clients[0].connection).toBe('disconnected');
  });
});

describe('GET /api/system-health/workspace/:workspaceId', () => {
  let app;

  beforeEach(async () => {
    await AutomationRun.deleteMany({});
    app = createApp();
  });

  async function seedRuns(count) {
    for (let i = 0; i < count; i += 1) {
      await AutomationRun.create({
        workspaceId: WS,
        boardId: `b${i}`,
        kind: 'invoice_automation',
        periodKey: `p${i}`,
        jobId: `j${i}`,
        status: RUN_SUCCEEDED,
        startedAt: new Date(Date.UTC(2026, 7, 1, 0, i)),
      });
    }
  }

  it('refuses an isoplus_user', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'isoplus_user' });
    // See the /verify note on the overview suite's equivalent test.
    await agent.get('/api/auth/verify');
    expect((await agent.get(`/api/system-health/workspace/${WS}`)).status).toBe(403);
  });

  it('returns newest runs first with a total', async () => {
    await seedRuns(3);
    const { agent } = await authenticatedAgent(app);

    const res = await agent.get(`/api/system-health/workspace/${WS}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.runs.map((r) => r.boardId)).toEqual(['b2', 'b1', 'b0']);
  });

  it('pages rather than truncating, so the history stays uncapped', async () => {
    await seedRuns(HISTORY_PAGE_SIZE + 5);
    const { agent } = await authenticatedAgent(app);

    const first = await agent.get(`/api/system-health/workspace/${WS}`);
    const second = await agent.get(`/api/system-health/workspace/${WS}?page=2`);

    expect(first.body.runs).toHaveLength(HISTORY_PAGE_SIZE);
    expect(second.body.runs).toHaveLength(5);
    expect(first.body.total).toBe(HISTORY_PAGE_SIZE + 5);
    // No overlap between pages.
    const ids = new Set(first.body.runs.map((r) => r.jobId));
    expect(second.body.runs.every((r) => !ids.has(r.jobId))).toBe(true);
  });

  it('does not leak another workspace\'s runs', async () => {
    await seedRuns(2);
    await AutomationRun.create({
      workspaceId: 'someone-else', boardId: 'x', kind: 'invoice_automation',
      periodKey: 'p', jobId: 'other', status: RUN_SUCCEEDED,
    });

    const { agent } = await authenticatedAgent(app);
    const res = await agent.get(`/api/system-health/workspace/${WS}`);

    expect(res.body.total).toBe(2);
  });

  it('returns an empty history rather than 404 for an unknown workspace', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get('/api/system-health/workspace/never-configured');

    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('rejects a non-numeric page instead of returning NaN results', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get(`/api/system-health/workspace/${WS}?page=abc`);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/system-health/workspace/:workspaceId/run', () => {
  let app;

  beforeEach(async () => {
    await AutomationRun.deleteMany({});
    await AutomationSettings.deleteMany({});
    await Board.deleteMany({});
    await Board.collection.insertMany([{ boardId: 'b1', workspaceId: WS, name: 'b1' }]);
    await AutomationSettings.create({ workspaceId: WS, invoice: { enabled: true } });
    resetRecordedJobs();
    app = createApp();
  });

  it('refuses an isoplus_user', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'isoplus_user' });
    // See the /verify note on the overview suite's equivalent test.
    await agent.get('/api/auth/verify');
    const res = await agent.post(`/api/system-health/workspace/${WS}/run`).send({ kind: 'invoice' });
    expect(res.status).toBe(403);
  });

  it('rejects an unknown kind rather than guessing', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.post(`/api/system-health/workspace/${WS}/run`).send({ kind: 'payroll' });
    expect(res.status).toBe(400);
  });

  it('enqueues a manual run and records it as manual', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent.post(`/api/system-health/workspace/${WS}/run`).send({ kind: 'invoice' });

    expect(res.status).toBe(202);
    expect(res.body.enqueued).toBe(1);
    const run = await AutomationRun.findOne({ workspaceId: WS }).lean();
    expect(run.trigger).toBe(TRIGGER_MANUAL);
  });

  it('refuses a second run for the same period, and says which', async () => {
    const { agent } = await authenticatedAgent(app);
    await agent.post(`/api/system-health/workspace/${WS}/run`).send({ kind: 'invoice' });

    const res = await agent.post(`/api/system-health/workspace/${WS}/run`).send({ kind: 'invoice' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_run');
    expect(res.body.periodKey).toBeTruthy();
    expect(res.body.runs.length).toBeGreaterThan(0);
  });

  it('runs anyway with ?force=1, under a distinct jobId', async () => {
    const { agent } = await authenticatedAgent(app);
    await agent.post(`/api/system-health/workspace/${WS}/run`).send({ kind: 'invoice' });

    const res = await agent
      .post(`/api/system-health/workspace/${WS}/run?force=1`)
      .send({ kind: 'invoice' });

    expect(res.status).toBe(202);
    const runs = await AutomationRun.find({ workspaceId: WS }).lean();
    expect(runs).toHaveLength(2);
    // The forced run must not collide with the original, or BullMQ drops it.
    expect(new Set(runs.map((r) => r.jobId)).size).toBe(2);
    expect(runs.some((r) => r.jobId.startsWith('manual:'))).toBe(true);
  });

  it('404s a workspace with no enabled block for that kind', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent
      .post(`/api/system-health/workspace/${WS}/run`)
      .send({ kind: 'statement' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/system-health/workspace/:workspaceId/runs/:runId/retry', () => {
  let app;

  beforeEach(async () => {
    await AutomationRun.deleteMany({});
    await Board.deleteMany({});
    await Board.collection.insertMany([{ boardId: 'b1', workspaceId: WS, name: 'b1' }]);
    resetRecordedJobs();
    app = createApp();
  });

  async function makeRun(status) {
    return AutomationRun.create({
      workspaceId: WS, boardId: 'b1', kind: 'invoice_automation',
      periodKey: '20260116-0900', jobId: `inv:b1:20260116-0900`, status,
    });
  }

  it('re-enqueues a failed run', async () => {
    const run = await makeRun(RUN_FAILED);
    const { agent } = await authenticatedAgent(app);

    const res = await agent.post(`/api/system-health/workspace/${WS}/runs/${run._id}/retry`);

    expect(res.status).toBe(202);
    expect(recordedJobIds().length).toBe(1);

    // The retry must leave a trace: a distinct jobId from the original run,
    // recorded under a row of its own, or the worker's markRun* calls have
    // nothing to close and the retry is invisible on System Health.
    const [jobId] = recordedJobIds();
    expect(jobId).not.toBe(run.jobId);
    const retryRow = await AutomationRun.findOne({ jobId }).lean();
    expect(retryRow).not.toBeNull();
    expect(retryRow.trigger).toBe(TRIGGER_MANUAL);
    expect(retryRow.workspaceId).toBe(WS);
    expect(retryRow.boardId).toBe(run.boardId);
    expect(retryRow.kind).toBe(run.kind);
    expect(retryRow.periodKey).toBe(run.periodKey);
  });

  it('refuses to retry a run that did not fail', async () => {
    const run = await makeRun(RUN_SUCCEEDED);
    const { agent } = await authenticatedAgent(app);

    const res = await agent.post(`/api/system-health/workspace/${WS}/runs/${run._id}/retry`);

    expect(res.status).toBe(409);
  });

  it('404s an unknown run id', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.post(
      `/api/system-health/workspace/${WS}/runs/64b7f9c2e4b0f5a3d2c1a000/retry`,
    );
    expect(res.status).toBe(404);
  });
});

/**
 * 6.5 asks the drill-down for "every email sent", not just per-run totals. The
 * run row carried a single `recipient` string that is a participant KEY, not an
 * address, and null entirely for the billing-contact route — so an operator
 * could see that a run happened and never which messages it produced or what
 * became of them.
 *
 * EmailSend is the join table (messageId -> board/period/recipient) and
 * EmailEvent carries the outcome keyed on the same id. Both already existed;
 * nothing read them.
 */
describe('GET /api/system-health/workspace/:workspaceId/runs/:runId/emails', () => {
  const PERIOD = '20260116-0900';
  let app;

  beforeEach(async () => {
    await AutomationRun.deleteMany({});
    await EmailSend.deleteMany({});
    await EmailEvent.deleteMany({});
    await Board.deleteMany({});
    await Board.collection.insertMany([{ boardId: 'b1', workspaceId: WS, name: 'b1' }]);
    app = createApp();
  });

  async function runWithEmails() {
    const run = await AutomationRun.create({
      workspaceId: WS, boardId: 'b1', kind: 'invoice_automation',
      periodKey: PERIOD, jobId: `inv:b1:${PERIOD}`, status: 'succeeded',
    });
    await EmailSend.create([
      { messageId: 'msg-delivered', kind: 'invoice_automation', workspaceId: WS, boardId: 'b1', periodKey: PERIOD, recipientKey: 'Mike Bird', recipientType: 'billing_contact' },
      { messageId: 'msg-bounced', kind: 'invoice_automation', workspaceId: WS, boardId: 'b1', periodKey: PERIOD, recipientKey: 'Jane Smith', recipientType: 'client_participant' },
      { messageId: 'msg-quiet', kind: 'invoice_automation', workspaceId: WS, boardId: 'b1', periodKey: PERIOD, recipientKey: 'No Events', recipientType: 'billing_contact' },
    ]);
    await EmailEvent.create([
      { eventType: 'Delivery', sesMessageId: 'msg-delivered', eventAt: new Date() },
      { eventType: 'Bounce', sesMessageId: 'msg-bounced', eventAt: new Date(), detail: { bounceType: 'Permanent', bounceSubType: 'NoEmail' } },
    ]);
    return run;
  }

  it('refuses a client', async () => {
    const run = await runWithEmails();
    const { agent } = await authenticatedAgent(app, { role: 'isoplus_user' });
    await agent.get('/api/auth/verify');

    const res = await agent.get(`/api/system-health/workspace/${WS}/runs/${run._id}/emails`);

    expect(res.status).toBe(403);
  });

  it('lists one row per message, with who it went to', async () => {
    const run = await runWithEmails();
    const { agent } = await authenticatedAgent(app);

    const res = await agent.get(`/api/system-health/workspace/${WS}/runs/${run._id}/emails`);

    expect(res.status).toBe(200);
    expect(res.body.emails).toHaveLength(3);
    const byId = Object.fromEntries(res.body.emails.map((e) => [e.messageId, e]));
    expect(byId['msg-delivered'].recipient).toBe('Mike Bird');
    expect(byId['msg-delivered'].recipientType).toBe('billing_contact');
  });

  it('carries each message its own delivery outcome', async () => {
    const run = await runWithEmails();
    const { agent } = await authenticatedAgent(app);

    const res = await agent.get(`/api/system-health/workspace/${WS}/runs/${run._id}/emails`);

    const byId = Object.fromEntries(res.body.emails.map((e) => [e.messageId, e]));
    expect(byId['msg-delivered'].state).toBe('delivered');
    expect(byId['msg-bounced'].state).toBe('bounced');
    // A bounce is the one outcome the operator can act on, so it carries a
    // sentence rather than only a label.
    expect(byId['msg-bounced'].detail).toMatch(/doesn't exist|does not exist/i);
    // Handed to SES, nothing heard back yet — not a failure.
    expect(byId['msg-quiet'].state).toBe('sent');
  });

  it('does not leak another run\'s messages', async () => {
    const run = await runWithEmails();
    await EmailSend.create({
      messageId: 'msg-other-period', kind: 'invoice_automation', workspaceId: WS,
      boardId: 'b1', periodKey: '20260201-0900', recipientKey: 'Other',
    });
    const { agent } = await authenticatedAgent(app);

    const res = await agent.get(`/api/system-health/workspace/${WS}/runs/${run._id}/emails`);

    expect(res.body.emails.map((e) => e.messageId)).not.toContain('msg-other-period');
  });

  it('404s an unknown run', async () => {
    const { agent } = await authenticatedAgent(app);
    const res = await agent.get(`/api/system-health/workspace/${WS}/runs/64b7f7f7f7f7f7f7f7f7f7f7/emails`);
    expect(res.status).toBe(404);
  });
});
